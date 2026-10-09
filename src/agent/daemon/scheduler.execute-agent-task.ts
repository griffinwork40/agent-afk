/**
 * Agent-executor path for `CronScheduler.runOnce`.
 *
 * Extracted from `scheduler.ts` to collapse the previously double-nested
 * `try { try {…} finally {…} } finally {…}` structure. The outer `finally`
 * in `runOnce` releases the per-task in-flight overlap guard; this module
 * owns the session lifecycle (spawn → send → teardown) as a single flat
 * try/catch/finally, making each concern independently editable.
 *
 * @module agent/daemon/scheduler.execute-agent-task
 */

import { makeDaemonElicitationHandler } from './handoff-wiring.js';
import { elicitationRouter } from '../elicitation-router.js';
import { redactInlineSecrets } from '../session/prompt-dump.js';
import { errorMessage } from '../../utils/errors.js';
import { resolveTaskRetryPolicy, runWithTaskRetry } from './task-retry.js';
import type { IdleDetector } from './idle-detector.js';
import type { AgentSession } from '../session/agent-session.js';
import type { MemoryStore } from '../memory/index.js';
import type { McpManager } from '../mcp/index.js';
import type { StateStore } from '../state/state-store.js';
import type { ScheduledTask } from './triggers.js';
import type { TelemetryRecord, TelemetryTrigger, TaskCompletionDetails } from './scheduler.js';
import type { Telegraf } from 'telegraf';
import type { Message } from '../types/message-types.js';

/** Subset of `SchedulerOptions` needed by the agent-executor path. */
interface AgentTaskOptions {
  bot?: Telegraf;
  primaryChatId?: number;
  primaryThreadId?: number;
  doneUnverifiedProbe?: (args: { responseText: string; successfulToolNames: readonly string[] }) => boolean;
  onTaskTurnComplete?: (args: TaskTurnCompleteArgs) => void;
}

/**
 * A completed agent-task turn, handed to `SchedulerOptions.onTaskTurnComplete`
 * so the CLI can persist it as a resumable session sidecar. Text fields are
 * already secret-redacted (same treatment as telemetry).
 */
export interface TaskTurnCompleteArgs {
  task: ScheduledTask;
  sessionId: string | undefined;
  cwd: string | undefined;
  userInput: string;
  response: Message;
}

/** Context supplied by `CronScheduler` to the agent-executor. */
export interface AgentTaskContext {
  options: AgentTaskOptions;
  queueDir: string;
  idleDetector: IdleDetector;
  now: () => number;
  spawnSession: (task: ScheduledTask, trigger: TelemetryTrigger) => Promise<{
    session: AgentSession;
    memoryStore: MemoryStore;
    stateStore: StateStore;
    mcpManager?: McpManager;
    dispose: () => void;
  }>;
  writeTelemetry: (record: TelemetryRecord, task: ScheduledTask, details?: TaskCompletionDetails) => void;
  /** Scheduler shutdown signal; ends a retry backoff wait immediately (#3243). */
  shutdownSignal?: AbortSignal;
  /** True when the task was unregistered/replaced mid-run; stops further retries. */
  isCancelled?: () => boolean;
  /** Injected backoff sleep (tests). Defaults to `sleepWithAbort`. */
  retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** What one successful attempt hands back to the telemetry writer. */
interface AttemptResult {
  responseText: string;
  doneUnverified: boolean;
}

/**
 * Run the task (with optional transient-failure retries) and return the
 * telemetry record.
 *
 * Called by `CronScheduler.runOnce` for `executor: 'agent'` tasks (the
 * default). The caller holds the in-flight overlap guard for the full
 * duration of this call — including every retry attempt and backoff wait —
 * and releases it in the `runOnce` outer `finally`, not here. The idle
 * detector is likewise held across the whole loop so a pull-mode dequeue
 * cannot slip into a retry backoff window. Exactly one telemetry record is
 * written per run; `attempts` is recorded when the task opted into retries.
 */
export async function executeAgentTask(
  ctx: AgentTaskContext,
  task: ScheduledTask,
  trigger: TelemetryTrigger,
): Promise<TelemetryRecord> {
  const triggeredAt = new Date(ctx.now());
  const startTimeMs = ctx.now();
  const baseRecord: Pick<
    TelemetryRecord,
    'taskId' | 'command' | 'trigger' | 'cronExpression' | 'triggeredAt'
  > = {
    taskId: task.taskId,
    command: redactInlineSecrets(task.command),
    trigger,
    ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
    triggeredAt: triggeredAt.toISOString(),
  };
  const policy = resolveTaskRetryPolicy(task);
  ctx.idleDetector.increment();
  try {
    const outcome = await runWithTaskRetry(() => runAgentAttempt(ctx, task, trigger), {
      ...policy,
      signal: ctx.shutdownSignal ?? new AbortController().signal,
      ...(ctx.isCancelled !== undefined ? { isCancelled: ctx.isCancelled } : {}),
      ...(ctx.retrySleep !== undefined ? { sleep: ctx.retrySleep } : {}),
    });
    const attemptsField = policy.maxAttempts > 1 ? { attempts: outcome.attempts } : {};
    if (!outcome.ok) {
      const record: TelemetryRecord = {
        ...baseRecord,
        durationMs: ctx.now() - startTimeMs,
        status: 'error',
        errorMessage: redactInlineSecrets(errorMessage(outcome.error)),
        ...attemptsField,
      };
      ctx.writeTelemetry(record, task);
      return record;
    }
    const { responseText, doneUnverified } = outcome.value;
    const record: TelemetryRecord = {
      ...baseRecord,
      durationMs: ctx.now() - startTimeMs,
      status: 'success',
      responseExcerpt: responseText.length > 280
        ? `${responseText.slice(0, 280)}… [truncated]`
        : responseText,
      ...attemptsField,
    };
    ctx.writeTelemetry(record, task, { responseText, ...(doneUnverified ? { doneUnverified: true } : {}) });
    return record;
  } finally {
    ctx.idleDetector.decrement();
  }
}

/**
 * One attempt: spawn a fresh session, send the task command, tear down.
 * Throws on failure so `runWithTaskRetry` can classify the error. A fresh
 * session per attempt means a retry never inherits a half-finished turn.
 */
async function runAgentAttempt(
  ctx: AgentTaskContext,
  task: ScheduledTask,
  trigger: TelemetryTrigger,
): Promise<AttemptResult> {
  let session: AgentSession | null = null;
  let memoryStore: MemoryStore | null = null;
  let stateStore: StateStore | null = null;
  let mcpManager: McpManager | null = null;
  let disposeRegistration: (() => void) | null = null;
  let handlerInstalled = false;
  try {
    const spawned = await ctx.spawnSession(task, trigger);
    session = spawned.session;
    memoryStore = spawned.memoryStore;
    stateStore = spawned.stateStore;
    mcpManager = spawned.mcpManager ?? null;
    disposeRegistration = spawned.dispose;

    // Invariant: handoff handler installed BEFORE sendMessage so the
    // ask-question-gate's hasHandler() probe passes for pull tasks;
    // uninstalled in the finally block so cron ticks never inherit it.
    if (trigger === 'pull') {
      elicitationRouter.install(makeDaemonElicitationHandler({
        taskId: task.taskId,
        originalCommand: redactInlineSecrets(task.command),
        queueDir: ctx.queueDir,
        ...(ctx.options.bot !== undefined ? { bot: ctx.options.bot } : {}),
        ...(ctx.options.primaryChatId !== undefined ? { chatId: ctx.options.primaryChatId } : {}),
        ...(ctx.options.primaryThreadId !== undefined ? { threadId: ctx.options.primaryThreadId } : {}),
      }));
      handlerInstalled = true;
    }

    const response = await session.sendMessage(task.command);
    const responseText = redactInlineSecrets(response.content);
    // Persist the run like a REPL turn so it appears in `/resume`. Injected
    // (the sidecar store lives in src/cli/) and guarded: persistence must
    // never fail a tick that already succeeded.
    try {
      ctx.options.onTaskTurnComplete?.({
        task,
        sessionId: session.sessionId ?? response.metadata?.sessionId,
        cwd: session.cwd,
        userInput: redactInlineSecrets(task.command),
        response: { ...response, content: responseText },
      });
    } catch {
      // best-effort
    }
    return { responseText, doneUnverified: probeDoneUnverified(ctx, responseText, response) };
  } finally {
    if (handlerInstalled) elicitationRouter.uninstall();
    if (session) {
      try {
        await session.close();
      } catch {
        // already-closed sessions throw; ignore.
      }
    }
    // Archive the cross-surface registry handle (frees its key) so the
    // long-running daemon never accumulates handles. Best-effort.
    disposeRegistration?.();
    if (mcpManager) {
      try {
        await mcpManager.disconnectAll();
      } catch {
        // MCP server shutdown is best-effort during daemon tick teardown.
      }
    }
    memoryStore?.close();
    stateStore?.close();
  }
}

/**
 * "Done"-verification probe (opt-in via injected `doneUnverifiedProbe`,
 * ultimately gated on `daemon.verifyDone` at the push layer). Fully
 * guarded: a probe bug or a metadata surprise must NEVER crash a tick, so
 * any throw is swallowed and treated as "not unverified" (push unchanged,
 * fail-open). Feeds the probe the SAME text the notification sees (already
 * secret-redacted) plus the raw successful-tool names the stream consumer
 * recorded on the returned Message's metadata.
 */
function probeDoneUnverified(ctx: AgentTaskContext, responseText: string, response: Message): boolean {
  try {
    const probe = ctx.options.doneUnverifiedProbe;
    if (probe === undefined) return false;
    const successfulToolNames = Array.isArray(response.metadata?.successfulToolNames)
      ? response.metadata.successfulToolNames
      : [];
    return probe({ responseText, successfulToolNames });
  } catch {
    return false;
  }
}
