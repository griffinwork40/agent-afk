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
import { dequeueNext } from './queue-store.js';
import { completeTask } from './lease-store.js';
import { makeDaemonElicitationHandler } from './handoff-wiring.js';
import { processAnsweredHandoffs } from './handoff-consume.js';
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

import { redactInlineSecrets } from '../session/prompt-dump.js';
import { ScheduledTask, validateScheduledTask } from './triggers.js';
import { runBuiltinWorktreePruneTask } from './worktree-prune-task.js';
export { resolveWorktreePruneRoot } from './worktree-prune-task.js';
export { daemonTraceLabel } from './session-spawn.js';
import { spawnDaemonSession } from './session-spawn.js';
import {
  DEFAULT_SESSIONSTART_COOLDOWN_MS,
  evaluateSessionStartGates,
  type GateDecision,
  type SessionStartSkipReason,
} from './gates.js';


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
   * `src/cli/commands/daemon.ts`. Never persisted to telemetry.
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
        records.push(this.recordSkip(task, decision));
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
    void processAnsweredHandoffs(this.queueDir)
      .then((r) => {
        if (r.requeued > 0) {
          // eslint-disable-next-line no-console
          console.error(`[daemon] handoff-consume: re-enqueued ${r.requeued} answered handoff(s)`);
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`[daemon] handoff-consume: sweep failed: ${msg}`);
      });
    this.pullPollTimer = setInterval(() => { void this.pullTick(); }, interval).unref();
  }

  private async pullTick(): Promise<void> {
    if (!this.idleDetector.isIdle()) return;
    if (this.isDequeuing) return;
    this.isDequeuing = true;
    try {
      // ORDERING INVARIANT: file is removed by dequeueNext BEFORE runOnce
      // spawns a session — reverse order risks double-fire on daemon restart
      // if the process crashes between dequeue and spawn.
      const queued = dequeueNext(this.queueDir);
      if (queued === null) {
        // Queue is empty this tick — still sweep for answered handoffs. An
        // answer that arrives between ticks would otherwise wait indefinitely
        // if no other task completes to trigger the post-run sweep at :349.
        void processAnsweredHandoffs(this.queueDir)
          .then((r) => {
            if (r.requeued > 0) {
              // eslint-disable-next-line no-console
              console.error(`[daemon] handoff-consume: re-enqueued ${r.requeued} answered handoff(s)`);
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.error(`[daemon] handoff-consume: sweep failed: ${msg}`);
          });
        return;
      }
      const syntheticTask: ScheduledTask = {
        taskId: queued.id,
        command: queued.command,
        trigger: 'pull',
        ...(queued.notifyOn !== undefined ? { notifyOn: queued.notifyOn } : {}),
      };
      const record = await this.runOnce(syntheticTask, 'pull');
      // Finalize the lease: move the leased/<id>.json to completed/ so the task
      // does not appear as an expired lease on the next daemon restart.
      // Best-effort: a completeTask failure must never crash the pull loop.
      try {
        completeTask(
          queued.id,
          record.status === 'error' ? 'failed' : 'succeeded',
          record.errorMessage,
          this.queueDir,
        );
      } catch {
        // Non-fatal — the lease recovery path (recoverExpiredLeases on next
        // startup) will re-enqueue or dead-letter based on the record's attempts.
      }
      // If the session answered a handoff during this run, re-enqueue it now.
      void processAnsweredHandoffs(this.queueDir)
        .then((r) => {
          if (r.requeued > 0) {
            // eslint-disable-next-line no-console
            console.error(`[daemon] handoff-consume: re-enqueued ${r.requeued} answered handoff(s)`);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[daemon] handoff-consume: sweep failed: ${msg}`);
        });
    } catch (err) {
      // Errors thrown INSIDE runOnce are captured there and written to
      // telemetry. Errors reaching here come from the dequeue path (now
      // quarantined inside dequeueNext) or from synthetic-task construction.
      // Log so a bad tick is visible in daemon logs instead of vanishing;
      // the poll loop still survives (mirrors writeTelemetry's logging path).
      // Redact error-derived text before logging, matching the runOnce
      // telemetry path (a synthetic task's command may carry an inline secret).
      const msg = redactInlineSecrets(err instanceof Error ? err.message : String(err));
      // eslint-disable-next-line no-console
      console.error(`[daemon] pull tick failed: ${msg}`);
    } finally {
      this.isDequeuing = false;
    }
  }

  private async runOnce(task: ScheduledTask, trigger: TelemetryTrigger): Promise<TelemetryRecord> {
    // Intercept built-in tasks before spawning a session
    if (task.command === '__BUILTIN_WORKTREE_PRUNE__') {
      return this.runBuiltinWorktreePrune(task, trigger);
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
      const spawned = await this.spawnSession(task.taskId, trigger);
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
        responseExcerpt: responseText.slice(0, 280),
      };
      this.writeTelemetry(record, task, { responseText, ...(doneUnverified ? { doneUnverified: true } : {}) });
      return record;
    } catch (err) {
      const record: TelemetryRecord = {
        ...baseRecord,
        durationMs: this.now() - startTimeMs,
        status: 'error',
        errorMessage: redactInlineSecrets(err instanceof Error ? err.message : String(err)),
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
  }

  private recordSkip(task: ScheduledTask, decision: GateDecision): TelemetryRecord {
    const triggeredAt = new Date(this.now());
    const record: TelemetryRecord = {
      taskId: task.taskId,
      command: task.command,
      trigger: 'sessionstart',
      ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
      triggeredAt: triggeredAt.toISOString(),
      durationMs: 0,
      status: 'skipped',
      ...(decision.skipReason !== undefined ? { skipReason: decision.skipReason } : {}),
    };
    this.writeTelemetry(record, task);
    return record;
  }

  private async runBuiltinWorktreePrune(
    task: ScheduledTask,
    trigger: TelemetryTrigger,
  ): Promise<TelemetryRecord> {
    return runBuiltinWorktreePruneTask(task, trigger, {
      now: this.now,
      telemetryPath: () => this.telemetryPath(),
      writeTelemetry: (record) => this.writeTelemetry(record, task),
    });
  }


  private async spawnSession(taskId: string, trigger: TelemetryTrigger = 'cron'): ReturnType<typeof spawnDaemonSession> {
    return spawnDaemonSession(taskId, { ...this.options, trigger });
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
    try {
      appendFileSync(this.telemetryPath(), `${JSON.stringify(record)}\n`, 'utf-8');
      this.fireOnTaskComplete(record, task, details);
    } catch (err) {
      // Telemetry failure must not crash the daemon. Log to stderr and move on.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[daemon] telemetry write failed: ${msg}`);
    }
  }

  private fireOnTaskComplete(
    record: TelemetryRecord,
    task?: ScheduledTask,
    details?: TaskCompletionDetails,
  ): void {
    const cb = this.options.onTaskComplete;
    if (!cb) return;
    // notifyOn filter — only applies when the triggering task is known
    if (task !== undefined) {
      if (task.notifyOn === 'never') return;
      if (task.notifyOn === 'failure' && record.status !== 'error') return;
      // 'always' or undefined (legacy behavior) falls through
    }
    // Thread the task's explicit chat target (if any) onto the details so the
    // injected callback can route the push. Merged here — rather than at every
    // writeTelemetry call site — because this is the single funnel every
    // completion path flows through, and the scheduler must not resolve/validate
    // the target itself (layering: no src/cli import). An explicit
    // details.notifyChat (should never happen today) is preserved.
    const effectiveDetails: TaskCompletionDetails | undefined =
      task?.notifyChat !== undefined
        ? { ...(details ?? {}), notifyChat: details?.notifyChat ?? task.notifyChat }
        : details;
    // Fire-and-forget. Notification callbacks must not block telemetry
    // writes or crash the scheduler — every error is swallowed and logged.
    try {
      const result = cb(record, effectiveDetails);
      if (result instanceof Promise) {
        void result.catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error(`[daemon] onTaskComplete callback failed: ${msg}`);
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[daemon] onTaskComplete callback failed: ${msg}`);
    }
  }
}
