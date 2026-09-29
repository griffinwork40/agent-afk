/**
 * Cron-based task scheduler for the daemon.
 *
 * Each tick spawns a fresh `AgentSession`, sends the task's `command` as a
 * user message, drains the response, and appends a telemetry record to
 * `~/.afk/agent-framework/forge-telemetry.jsonl`. Errors in one task
 * never halt the scheduler — they're logged and the next tick proceeds.
 *
 * Phase 6 adds `fireOnStart()` for `sessionstart` and `both` triggers,
 * gated by cooldown + brief-queue checks (see `daemon/gates.ts`).
 *
 * @module agent/daemon/scheduler
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as cron from 'node-cron';
import { IdleDetector } from './idle-detector.js';
import { makeDaemonElicitationHandler } from './handoff-wiring.js';
import { elicitationRouter } from '../elicitation-router.js';
import { recoverDaemonQueues } from './pull-recovery.js';
import { getQueueDir, getTelemetryPath } from '../../paths.js';
import type { ScheduledTask as CronTask } from 'node-cron';
import type { TraceWriter } from '../trace/index.js';
import type { AgentSession } from '../session/agent-session.js';
import type { MemoryStore } from '../memory/index.js';
import type { McpManager } from '../mcp/index.js';
import type { StateStore } from '../state/state-store.js';
import type { AgentConfig } from '../types.js';
import type { Telegraf } from 'telegraf';

import { redactInlineSecrets } from '../session/prompt-dump.js';
import { ScheduledTask, validateScheduledTask } from './triggers.js';
import { runBuiltinTask } from './builtin-task.js';
import { runShellTask } from './shell-task.js';
import { checkTaskCwdAtRuntime, warnIfBuiltinHasCwd } from './cwd-validator.js';
export { resolveWorktreePruneRoot } from './worktree-prune-task.js';
export { daemonTraceLabel } from './session-spawn.js';
import { spawnDaemonSession } from './session-spawn.js';
import {
  DEFAULT_SESSIONSTART_COOLDOWN_MS,
  evaluateSessionStartGates,
  type SessionStartSkipReason,
} from './gates.js';
import {
  sweepAnsweredHandoffs,
  executePullTick,
  fireOnTaskComplete,
  type PullTickContext,
  type FireOnTaskCompleteOptions,
} from './scheduler.pull-tick.js';
import { errorMessage } from '../../utils/errors.js';
import { makeOverlapSkipRecord, makeSessionStartSkipRecord } from './scheduler.overlap-guard.js';


export interface SchedulerOptions {
  /** Per-tick session config; merged with defaults at spawn time. */
  sessionConfig?: Partial<AgentConfig>;
  /** Override the telemetry sink (tests). Defaults to `~/.afk/agent-framework/forge-telemetry.jsonl`. */
  telemetryPath?: string;
  /** Override the session factory (tests). Defaults to `new AgentSession(config, ownedTraceWriter)`. */
  sessionFactory?: (config: AgentConfig, ownedTraceWriter?: TraceWriter) => AgentSession;
  /**
   * Default cooldown (ms) between sessionstart fires of the same task.
   * Can be overridden per-task via `ScheduledTask.debounceMs`. Defaults to
   * 6 hours. `0` disables the cooldown check.
   */
  cooldownMs?: number;
  /** Clock injection (tests). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Optional callback invoked after the telemetry record is successfully
   * written to disk (success, error, or skipped). If the telemetry write
   * itself fails, the callback is NOT fired. Callback errors are caught so
   * notification failures never crash the scheduler. Used for out-of-band
   * notifications (Telegram push, webhooks, etc.).
   */
  onTaskComplete?: (record: TelemetryRecord, details?: TaskCompletionDetails) => void | Promise<void>;
  /**
   * Poll interval (ms) for the pull-trigger queue. When > 0, `startPullLoop()`
   * will set up a `setInterval` that dequeues one task per tick when idle.
   * Set to 0 or omit to disable pull mode.
   */
  pullPollIntervalMs?: number;
  /** Override the queue directory for pull-mode dequeue (defaults to `getQueueDir()`). */
  queueDir?: string;
  /**
   * "Done"-verification probe (opt-in; injected by the CLI daemon wiring).
   *
   * Given a tick's `responseText` and the names of the tools that ran
   * successfully this turn (from `Message.metadata.successfulToolNames`),
   * returns `true` when the response self-certifies a `Done` terminal state
   * with NO corroborating evidence — the daemon analog of the REPL's
   * terminal-state gate. Result is threaded onto `TaskCompletionDetails.
   * doneUnverified` for the push formatter to act on.
   *
   * INJECTED (not imported) because the real implementation composes
   * `parseTerminalState` + `doneHasCorroboratingEvidence`, both of which live in
   * `src/cli/commands/interactive/` — and `src/agent/` must never import from
   * `src/cli/` (layering invariant; see `agent/facets/schema.ts`). The CLI
   * daemon command supplies the wired probe; when omitted (standalone scheduler,
   * most tests), `runOnce` simply never computes `doneUnverified` (fail-open,
   * push unchanged). The probe MUST be pure and MUST NOT throw — `runOnce` still
   * guards it defensively so a bug can never crash a tick.
   */
  doneUnverifiedProbe?: (args: { responseText: string; successfulToolNames: readonly string[] }) => boolean;
  /**
   * Telegraf bot instance for rich elicitation in pull-mode tasks. When
   * provided together with `primaryChatId`, daemon ask_question calls use
   * `sendHandoffQuestion` (inline keyboards, reply-to matching) instead of
   * falling back to the plain `pushIfConfigured` text notification path.
   * Has no effect when absent — fallback is always preserved.
   * Has no effect on cron-triggered tasks, which use the plain push path.
   */
  bot?: Telegraf;
  /** Primary Telegram chat ID for handoff question delivery. */
  primaryChatId?: number;
  /** Optional topic thread ID for supergroup delivery. */
  primaryThreadId?: number;
}

export type TelemetryTrigger = 'cron' | 'sessionstart' | 'pull';
export type TelemetryStatus = 'success' | 'error' | 'skipped';

export interface TelemetryRecord {
  taskId: string;
  command: string;
  trigger: TelemetryTrigger;
  cronExpression?: string;
  triggeredAt: string;
  durationMs: number;
  status: TelemetryStatus;
  errorMessage?: string;
  responseExcerpt?: string;
  skipReason?: SessionStartSkipReason;
  /** Human-readable label from ScheduledTaskConfig, if available. */
  name?: string;
  /**
   * True when the tick's response self-certified a `Done` terminal state with
   * NO corroborating evidence (no successful file-write/edit/shell call this
   * turn). Absent when verification did not run, when the response was
   * verified, or when the terminal state is not `Done`. Enables post-hoc
   * review tools to distinguish a verified success from an unverified claim.
   * The `status` field remains `'success'` for backward compatibility.
   */
  doneUnverified?: boolean;
}

export interface TaskCompletionDetails {
  /** Full successful task response for out-of-band notifications; not persisted to telemetry. */
  responseText?: string;
  /**
   * True when this tick's response self-certified a `Done` terminal state with
   * NO corroborating evidence this turn (no successful file write/edit or
   * executed command — the daemon analog of the REPL's terminal-state gate).
   * Additive/optional: absent on non-`Done` ticks, on ticks with evidence, and
   * on any parse failure (fail-open). The push formatter downgrades the
   * completion message to "⚠️ Done (unverified)" only when this is `true` AND
   * `daemon.verifyDone` is enabled — see `formatTaskCompletion` in
   * `src/cli/commands/daemon.ts`. Persisted to telemetry as `TelemetryRecord.doneUnverified` (only when `true`) as of #2307.
   */
  doneUnverified?: boolean;
  /**
   * Explicit chat target for this task's completion notification, copied from
   * the triggering `ScheduledTask.notifyChat`. A number is a raw chat id; a
   * string is a numeric id or an alias name (resolved by the CLI push wiring
   * against `telegram.chatAliases`). The scheduler itself does NOT resolve or
   * validate it — routing/allowlist enforcement lives in the injected
   * `onTaskComplete` callback (`src/cli/commands/daemon.ts`), preserving the
   * `src/agent/` → no-`src/cli/`-import layering invariant. Absent when the task
   * has no `notifyChat` (default routing). Never persisted to telemetry.
   */
  notifyChat?: number | string;
}

interface RegisteredEntry {
  task: ScheduledTask;
  cronTask?: CronTask;
}

export class CronScheduler {
  private readonly registry = new Map<string, RegisteredEntry>();
  private readonly options: SchedulerOptions;
  private readonly defaultCooldownMs: number;
  private readonly now: () => number;
  private readonly idleDetector = new IdleDetector();
  private pullPollTimer: ReturnType<typeof setInterval> | undefined;
  private isDequeuing = false;
  private readonly queueDir: string;
  /** Per-task in-flight guard: IDs of tasks whose runOnce promise is still pending. Intra-process only — no cross-process coordination. */
  private readonly inFlightTaskIds = new Set<string>();
  // TODO(#337-hook): hook-driven dequeue path will share isDequeuing mutex

  constructor(options: SchedulerOptions = {}) {
    this.options = options;
    this.defaultCooldownMs = options.cooldownMs ?? DEFAULT_SESSIONSTART_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.queueDir = options.queueDir ?? getQueueDir();
    this.ensureTelemetrySink();
  }

  register(task: ScheduledTask): void {
    validateScheduledTask(task);
    if (this.registry.has(task.taskId)) {
      throw new Error(`task ${task.taskId} is already registered`);
    }
    let cronTask: CronTask | undefined;
    if (task.trigger === 'cron' || task.trigger === 'both') {
      cronTask = cron.schedule(
        task.cronExpression!,
        () => {
          // Fire-and-forget — the cron callback type doesn't await, but
          // catching here means a thrown promise can't leak as unhandled.
          void this.runOnce(task, 'cron').catch(() => undefined);
        },
        { name: task.taskId },
      );
    }
    this.registry.set(task.taskId, { task, cronTask });
  }

  unregister(taskId: string): void {
    const entry = this.registry.get(taskId);
    if (!entry) return;
    if (entry.cronTask) {
      void Promise.resolve(entry.cronTask.stop()).catch(() => undefined);
      void Promise.resolve(entry.cronTask.destroy()).catch(() => undefined);
    }
    this.registry.delete(taskId);
  }

  list(): ScheduledTask[] {
    return Array.from(this.registry.values()).map((entry) => entry.task);
  }

  /**
   * Run one tick of `taskId` immediately, bypassing the cron timer and gates.
   * Used by `--once` CLI mode and by tests. Recorded as `trigger: 'cron'`.
   * Note: subject to the per-task in-flight overlap guard (see {@link CronScheduler.inFlightTaskIds}).
   */
  async tick(taskId: string): Promise<TelemetryRecord> {
    const entry = this.registry.get(taskId);
    if (!entry) throw new Error(`task ${taskId} is not registered`);
    return this.runOnce(entry.task, 'cron');
  }

  /**
   * Evaluate sessionstart gates for every registered task with
   * `trigger: 'sessionstart' | 'both'`. For passing tasks, fire once and
   * record telemetry with `trigger: 'sessionstart'`. For gated tasks, write
   * a `status: 'skipped'` record naming the reason. Returns every record
   * (fired or skipped) so callers can inspect outcomes.
   */
  async fireOnStart(): Promise<TelemetryRecord[]> {
    const eligible = Array.from(this.registry.values())
      .map((entry) => entry.task)
      .filter((task) => task.trigger === 'sessionstart' || task.trigger === 'both');
    const records: TelemetryRecord[] = [];
    for (const task of eligible) {
      const cooldownMs = task.debounceMs ?? this.defaultCooldownMs;
      const decision = evaluateSessionStartGates({
        taskId: task.taskId,
        cooldownMs,
        nowMs: this.now(),
        telemetryPath: this.telemetryPath(),
      });
      if (decision.fire) {
        records.push(await this.runOnce(task, 'sessionstart'));
      } else {
        const skipRecord = makeSessionStartSkipRecord(task, decision, this.now());
        this.writeTelemetry(skipRecord, task);
        records.push(skipRecord);
      }
    }
    return records;
  }

  async stop(): Promise<void> {
    if (this.pullPollTimer !== undefined) {
      clearInterval(this.pullPollTimer);
      this.pullPollTimer = undefined;
    }
    for (const taskId of this.registry.keys()) this.unregister(taskId);
  }

  /**
   * Start the pull-mode polling loop. Dequeues one task per tick from the
   * queue directory when the scheduler is idle (no in-flight tasks). Calling
   * this method more than once is safe — subsequent calls are no-ops.
   *
   * The interval is `.unref()`-ed so it won't prevent Node from exiting
   * if the process has nothing else to wait on.
   */
  startPullLoop(): void {
    if (this.pullPollTimer !== undefined) return;
    const interval = this.options.pullPollIntervalMs;
    if (!interval || interval <= 0) return;

    recoverDaemonQueues(this.queueDir);

    // Pick up any answers that arrived while the daemon was down.
    sweepAnsweredHandoffs(this.queueDir);
    this.pullPollTimer = setInterval(() => { void this.pullTick(); }, interval).unref();
  }

  private async pullTick(): Promise<void> {
    const ctx: PullTickContext = {
      queueDir: this.queueDir,
      isIdle: () => this.idleDetector.isIdle(),
      getIsDequeuing: () => this.isDequeuing,
      setIsDequeuing: (v) => { this.isDequeuing = v; },
      runOnce: (task, trigger) => this.runOnce(task, trigger),
    };
    return executePullTick(ctx);
  }

  private async runOnce(task: ScheduledTask, trigger: TelemetryTrigger): Promise<TelemetryRecord> {
    // Overlap guard: skip and record telemetry when this task's previous run is
    // still in progress. Prevents stacked concurrent sessions on slow ticks
    // (the in-flight set is released in the agent-path finally block below).
    // The guard is intentionally checked BEFORE the cwd and executor branches
    // so it applies uniformly to all executor types.
    if (this.inFlightTaskIds.has(task.taskId)) {
      const record = makeOverlapSkipRecord(task, trigger, this.now());
      this.writeTelemetry(record, task);
      return record;
    }
    this.inFlightTaskIds.add(task.taskId);
    try {
    // Resolve executor early so the cwd guard can skip builtin tasks (which
    // ignore cwd entirely and would produce spurious errors if the dir vanishes).
    const isLegacySentinel = task.command === '__BUILTIN_WORKTREE_PRUNE__';
    const executor = task.executor
      ?? (isLegacySentinel ? 'builtin' as const : 'agent' as const);
    if (executor === 'builtin') {
      warnIfBuiltinHasCwd(task);
      // Normalize the legacy sentinel to the canonical builtin name here --
      // the single compat point -- so runBuiltinTask only sees canonical names.
      const normalizedTask = isLegacySentinel
        ? { ...task, command: 'worktree-prune' }
        : task;
      return runBuiltinTask(normalizedTask, trigger, {
        now: this.now, telemetryPath: () => this.telemetryPath(),
        writeTelemetry: (r) => this.writeTelemetry(r, task),
      });
    }
    // Runtime cwd guard: fail loudly when the pinned directory has vanished
    // rather than silently falling back to $HOME. Skipped for builtin tasks
    // (handled above) because builtins ignore cwd entirely.
    if (task.cwd !== undefined) {
      const cwdError = checkTaskCwdAtRuntime(task.cwd);
      if (cwdError !== undefined) {
        const record: TelemetryRecord = {
          taskId: task.taskId,
          command: redactInlineSecrets(task.command),
          trigger,
          ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
          triggeredAt: new Date(this.now()).toISOString(),
          durationMs: 0,
          status: 'error',
          errorMessage: redactInlineSecrets(cwdError),
        };
        this.writeTelemetry(record, task);
        return record;
      }
    }
    if (executor === 'shell') {
      this.idleDetector.increment();
      try {
        // Resolve shell cwd: task.cwd ?? daemon-wide sessionConfig.cwd ?? process.cwd().
        // Passed as cwd in the execFile options so shell commands run in the
        // correct directory without the grep/glob tool-timeout regression.
        const shellCwd = task.cwd ?? this.options.sessionConfig?.cwd;
        return await runShellTask(
          shellCwd !== undefined ? { ...task, cwd: shellCwd } : task,
          trigger,
          { now: this.now, writeTelemetry: (r) => this.writeTelemetry(r, task) },
        );
      } finally { this.idleDetector.decrement(); }
    }

    const triggeredAt = new Date(this.now());
    const startTimeMs = this.now();
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
    this.idleDetector.increment();
    try {
      const spawned = await this.spawnSession(task, trigger);
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
          queueDir: this.queueDir,
          ...(this.options.bot !== undefined ? { bot: this.options.bot } : {}),
          ...(this.options.primaryChatId !== undefined ? { chatId: this.options.primaryChatId } : {}),
          ...(this.options.primaryThreadId !== undefined ? { threadId: this.options.primaryThreadId } : {}),
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
        const probe = this.options.doneUnverifiedProbe;
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
        durationMs: this.now() - startTimeMs,
        status: 'success',
        responseExcerpt: responseText.length > 280
          ? `${responseText.slice(0, 280)}… [truncated]`
          : responseText,
      };
      this.writeTelemetry(record, task, { responseText, ...(doneUnverified ? { doneUnverified: true } : {}) });
      return record;
    } catch (err) {
      const record: TelemetryRecord = {
        ...baseRecord,
        durationMs: this.now() - startTimeMs,
        status: 'error',
        errorMessage: redactInlineSecrets(errorMessage(err)),
      };
      this.writeTelemetry(record, task);
      return record;
    } finally {
      if (handlerInstalled) elicitationRouter.uninstall();
      this.idleDetector.decrement();
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
    } finally {
      this.inFlightTaskIds.delete(task.taskId);
    }
  }

  private async spawnSession(task: ScheduledTask, trigger: TelemetryTrigger = 'cron'): ReturnType<typeof spawnDaemonSession> {
    return spawnDaemonSession(task.taskId, {
      ...this.options,
      trigger,
      // Per-task cwd takes precedence over the daemon-wide sessionConfig.cwd.
      ...(task.cwd !== undefined ? { taskCwd: task.cwd } : {}),
    });
  }

  private telemetryPath(): string {
    return this.options.telemetryPath ?? getTelemetryPath();
  }

  private ensureTelemetrySink(): void {
    try {
      mkdirSync(dirname(this.telemetryPath()), { recursive: true });
    } catch {
      // Directory creation is best-effort; the actual write path will surface a real error.
    }
  }

  private writeTelemetry(
    record: TelemetryRecord,
    task?: ScheduledTask,
    details?: TaskCompletionDetails,
  ): void {
    // Persist doneUnverified (#2307): only written when true; absent = not unverified.
    const persistedRecord: TelemetryRecord = details?.doneUnverified === true ? { ...record, doneUnverified: true } : record;
    try {
      appendFileSync(this.telemetryPath(), `${JSON.stringify(persistedRecord)}\n`, 'utf-8');
      const opts: FireOnTaskCompleteOptions = { onTaskComplete: this.options.onTaskComplete };
      fireOnTaskComplete(persistedRecord, opts, task, details);
    } catch (err) {
      // Telemetry failure must not crash the daemon. Log to stderr and move on.
      const msg = errorMessage(err);
      // eslint-disable-next-line no-console
      console.error(`[daemon] telemetry write failed: ${msg}`);
    }
  }
}
