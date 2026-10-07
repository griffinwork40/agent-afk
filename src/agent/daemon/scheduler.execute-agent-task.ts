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
import type { IdleDetector } from './idle-detector.js';
import type { AgentSession } from '../session/agent-session.js';
import type { MemoryStore } from '../memory/index.js';
import type { McpManager } from '../mcp/index.js';
import type { StateStore } from '../state/state-store.js';
import type { ScheduledTask } from './triggers.js';
import type { TelemetryRecord, TelemetryTrigger, TaskCompletionDetails } from './scheduler.js';
import type { Telegraf } from 'telegraf';

/** Subset of `SchedulerOptions` needed by the agent-executor path. */
interface AgentTaskOptions {
  bot?: Telegraf;
  primaryChatId?: number;
  primaryThreadId?: number;
  doneUnverifiedProbe?: (args: { responseText: string; successfulToolNames: readonly string[] }) => boolean;
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
}

/**
 * Spawn a session, send the task command, and return the telemetry record.
 *
 * Called by `CronScheduler.runOnce` for `executor: 'agent'` tasks (the
 * default). The caller holds the in-flight overlap guard for the full
 * duration of this call — guard release happens in the `runOnce` outer
 * `finally`, not here.
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

  let session: AgentSession | null = null;
  let memoryStore: MemoryStore | null = null;
  let stateStore: StateStore | null = null;
  let mcpManager: McpManager | null = null;
  let disposeRegistration: (() => void) | null = null;
  let handlerInstalled = false;
  ctx.idleDetector.increment();
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
    // "Done"-verification probe (opt-in via injected `doneUnverifiedProbe`,
    // ultimately gated on `daemon.verifyDone` at the push layer). Fully
    // guarded: a probe bug or a metadata surprise must NEVER crash a tick, so
    // any throw is swallowed and treated as "not unverified" (push unchanged,
    // fail-open). Feeds the probe the SAME text the notification sees (already
    // secret-redacted) plus the raw successful-tool names the stream consumer
    // recorded on the returned Message's metadata.
    let doneUnverified = false;
    try {
      const probe = ctx.options.doneUnverifiedProbe;
      if (probe !== undefined) {
        const successfulToolNames = Array.isArray(response.metadata?.successfulToolNames)
          ? response.metadata.successfulToolNames
          : [];
        doneUnverified = probe({ responseText, successfulToolNames });
      }
    } catch {
      doneUnverified = false;
    }
    const record: TelemetryRecord = {
      ...baseRecord,
      durationMs: ctx.now() - startTimeMs,
      status: 'success',
      responseExcerpt: responseText.length > 280
        ? `${responseText.slice(0, 280)}… [truncated]`
        : responseText,
    };
    ctx.writeTelemetry(record, task, { responseText, ...(doneUnverified ? { doneUnverified: true } : {}) });
    return record;
  } catch (err) {
    const record: TelemetryRecord = {
      ...baseRecord,
      durationMs: ctx.now() - startTimeMs,
      status: 'error',
      errorMessage: redactInlineSecrets(errorMessage(err)),
    };
    ctx.writeTelemetry(record, task);
    return record;
  } finally {
    if (handlerInstalled) elicitationRouter.uninstall();
    ctx.idleDetector.decrement();
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
