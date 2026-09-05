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

import { env } from '../../config/env.js';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as cron from 'node-cron';
import { runSweep } from '../worktree-sweep.js';
import type { SweepResult } from '../worktree-sweep.js';
import { sweepRootSet } from '../worktree-root-registry.js';
import { IdleDetector } from './idle-detector.js';
import { dequeueNext, recoverExpiredLeases } from './queue-store.js';
import { completeTask } from './lease-store.js';
import { makeDaemonElicitationHandler, recoverPendingHandoffs } from './handoff-wiring.js';
import { processAnsweredHandoffs } from './handoff-consume.js';
import { elicitationRouter } from '../elicitation-router.js';
import { getQueueDir, getStateDatabasePath, getTelemetryPath } from '../../paths.js';
import type { ScheduledTask as CronTask } from 'node-cron';
import { AgentSession } from '../session/agent-session.js';
import { registerSurfaceSession } from '../session/register-surface-session.js';
import { createDefaultHookRegistry } from '../default-hook-registry.js';
import { loadHooksConfig } from '../hooks/config-loader.js';
import { createDefaultTraceWriter } from '../trace/factory.js';
import type { TraceWriter } from '../trace/index.js';
import { MemoryStore, injectHotMemory } from '../memory/index.js';
import { StateStore } from '../state/state-store.js';

import { injectCompanionPrimer } from '../companion/index.js';
import { McpManager, loadMcpConfig } from '../mcp/index.js';
import { loadImportFromConfig, resolveImportedRoots } from '../../config/import-sources.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { AgentConfig } from '../types.js';

import { redactInlineSecrets } from '../session/prompt-dump.js';
import { ScheduledTask, validateScheduledTask } from './triggers.js';
import {
  DEFAULT_SESSIONSTART_COOLDOWN_MS,
  evaluateSessionStartGates,
  type GateDecision,
  type SessionStartSkipReason,
} from './gates.js';
import { summarizeRootFailures } from './root-failure-summary.js';
import { countPrunable, formatWorktreePruneSummary } from './worktree-prune-summary.js';
import { debugLog } from '../../utils/debug.js';

// Re-export module-scope helpers extracted to scheduler.helpers.ts for the
// 350-code-line ceiling. Public surface unchanged -- importers of
// resolveWorktreePruneRoot and daemonTraceLabel resolve through here.
export { resolveWorktreePruneRoot, daemonTraceLabel } from './scheduler.helpers.js';
import { builtinPruneExecFile, daemonTraceLabel, resolveWorktreePruneRoot } from './scheduler.helpers.js';

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

    // On startup, recover any leases that expired while the daemon was down.
    // Tasks with remaining attempts are re-enqueued; exhausted tasks are dead-lettered.
    try {
      const recovered = recoverExpiredLeases(this.queueDir);
      for (const record of recovered) {
        if (record.state === 'retrying') {
          // eslint-disable-next-line no-console
          console.error(`[daemon] lease-recovery: re-enqueued expired lease task ${record.id} (attempt ${record.attempts}/${record.maxAttempts})`);
        } else {
          // eslint-disable-next-line no-console
          console.error(`[daemon] lease-recovery: dead-lettered task ${record.id} (exhausted ${record.maxAttempts} attempt(s))`);
        }
      }
    } catch (err) {
      // Recovery is best-effort — a failure must not prevent the pull loop from starting.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[daemon] lease-recovery: failed to recover expired leases: ${msg}`);
    }

    // Recover pending handoffs independently — must not be skipped if lease recovery throws.
    void recoverPendingHandoffs(undefined, this.queueDir)
      .then((r) => {
        if (r.renotified > 0 || r.expired > 0) {
          // eslint-disable-next-line no-console
          console.error(`[daemon] handoff-recovery: re-notified ${r.renotified}, expired ${r.expired}`);
        }
      })
      .catch((err: unknown) => {
        const hMsg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`[daemon] handoff-recovery: recovery failed: ${hMsg}`);
      });
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
    const triggeredAt = new Date(this.now());
    const startTimeMs = this.now();
    const baseRecord = {
      taskId: task.taskId,
      command: task.command,
      trigger,
      ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
      triggeredAt: triggeredAt.toISOString(),
    };

    try {
      const primaryRoot = await resolveWorktreePruneRoot(
        builtinPruneExecFile,
        process.cwd(),
        env.AFK_WORKTREE_SWEEP_ROOT,
      );
      // The sweep is per-root, so the daemon's own cwd used to bound what could
      // ever be reclaimed. Visit every root known to hold managed trees (#761).
      const roots = await sweepRootSet(primaryRoot);
      if (roots.length === 0) {
        // An empty set means BOTH causes hold at once: sweepRootSet always
        // yields at least the primary when one resolved, so no primary (daemon
        // cwd outside a git repo, commonly $HOME under launchd) AND nothing
        // registered. Name both — reporting only the cwd half sent operators
        // looking for a daemon misconfiguration when the registry was simply
        // empty. Skip rather than error on every tick; the per-repo REPL
        // boot-prune still covers repos the user actually works in.
        const skipped: TelemetryRecord = {
          ...baseRecord,
          durationMs: this.now() - startTimeMs,
          status: 'skipped',
          responseExcerpt:
            'worktree-prune skipped: no roots to sweep — daemon cwd is not inside a ' +
            'git repository and no managed worktree roots are registered ' +
            '(set AFK_WORKTREE_SWEEP_ROOT to target a repo)',
        };
        this.writeTelemetry(skipped, task);
        return skipped;
      }

      const maxAgeDaysClean =
        parseInt(env.AFK_WORKTREE_MAX_AGE_CLEAN ?? '', 10) || 14;
      const maxAgeDaysDirty =
        parseInt(env.AFK_WORKTREE_MAX_AGE_DIRTY ?? '', 10) || 30;

      // Invariant: one unusable root must never starve the roots after it.
      // runSweep does not catch a failure of its own opening `git worktree
      // list`, and builtinPruneExecFile is a bare promisify(execFile), so a
      // nonzero git exit REJECTS. A registered directory whose .git was
      // deleted survives the registry's liveness gate (a bare isDirectory()
      // check), so such a root is sticky, not transient — uncaught, it would
      // abort the loop on every tick and permanently strand every root ordered
      // behind it, recreating the #761 leak this fan-out exists to close.
      // Failures are demoted to warnings so the tick still reports the
      // removals that already hit disk.
      //
      // Sequential on purpose: runSweep takes a single machine-global advisory
      // lock, so parallel roots would just contend and the losers short-circuit.
      const results: SweepResult[] = [];
      const rootFailures: string[] = [];
      // Parallel to rootFailures, but holding the structured (repoRoot, reason)
      // pair instead of a pre-joined string — the compact errorMessage below
      // needs `basename(repoRoot)` alone, not the full path baked into the
      // rootFailures line. `reason` is redacted exactly once, here, and reused
      // for both channels below.
      const rootFailureDetails: Array<{ repoRoot: string; reason: string }> = [];
      for (const repoRoot of roots) {
        try {
          results.push(await runSweep({
            execFile: builtinPruneExecFile,
            repoRoot,
            dryRun: false, // soft-launch valve inside runSweep handles early dry-runs
            maxAgeDaysClean,
            maxAgeDaysDirty,
            scope: 'all',
            telemetryPath: this.telemetryPath(),
          }));
        } catch (err) {
          const reason = redactInlineSecrets(err instanceof Error ? err.message : String(err));
          rootFailures.push(`[ERROR] sweep failed for ${repoRoot}: ${reason}`);
          rootFailureDetails.push({ repoRoot, reason });
          // The full path exists nowhere else on a PARTIAL failure: `warnings`
          // is not a field of TelemetryRecord (the scheduler consumes only its
          // .length, for the summary), and `errorMessage` — which carries
          // basenames only, by design — is written just when EVERY root fails.
          // Without this line an operator seeing "1 failed" has no way to learn
          // WHICH root failed, contradicting root-failure-summary.ts's own
          // contract that `warnings` is the detailed channel.
          debugLog(`[worktree-prune] sweep failed for ${repoRoot}: ${reason}`);
        }
      }
      const result = {
        // Retained for the record's own shape only. The SUMMARY no longer
        // branches on this: with a per-root valve a tick can mix live and
        // previewing roots, and choosing one of two exclusive sentences dropped
        // the removal count on exactly those ticks (see
        // daemon/worktree-prune-summary.ts).
        dryRun: results.some((r) => r.dryRun),
        removed: results.flatMap((r) => r.removed),
        warnings: [...rootFailures, ...results.flatMap((r) => r.warnings)],
        candidates: results.flatMap((r) => r.candidates),
      };

      const contestedResults = results.filter((r) => r.contested === true);
      const previewResults = results.filter((r) => r.dryRun && r.contested !== true);
      const liveResults = results.filter((r) => !r.dryRun && r.contested !== true);
      const summary = formatWorktreePruneSummary({
        removed: result.removed.length,
        warnings: result.warnings.length,
        wouldRemove: countPrunable(previewResults.flatMap((r) => r.candidates)),
        liveRoots: liveResults.length,
        previewRoots: previewResults.length,
        contestedRoots: contestedResults.length,
        failedRoots: rootFailureDetails.length,
        totalRoots: roots.length,
      });

      // Invariant: a tick where EVERY root rejected must report `status:
      // 'error'`, not 'success' — src/insights/aggregators/daemon.ts tallies
      // `errorCount` / `recentErrors` only off `status === 'error'`, so a
      // permanently broken prune (every root rejecting on every tick, e.g. a
      // stale AFK_WORKTREE_SWEEP_ROOT or a registry full of dead repos) would
      // otherwise report as healthy forever. `results.length === 0` with
      // `roots.length > 0` is exactly that case: every iteration of the loop
      // above hit the `catch` and pushed to `rootFailures` instead of
      // `results`. A tick where SOME roots succeeded (`results.length > 0`)
      // stays `success` — that is a partial failure, already visible via the
      // per-root `[ERROR]` warnings, not a systemic one.
      const record: TelemetryRecord =
        results.length === 0 && roots.length > 0
          ? {
              ...baseRecord,
              durationMs: this.now() - startTimeMs,
              status: 'error',
              // Compact + non-enumerating — see summarizeRootFailures' own
              // doc comment for why this must never be rootFailures.join(),
              // which embeds every failing root's absolute path.
              // rootFailureDetails' `reason` is already redacted at push time
              // (in the loop above) — redacting again would be a no-op.
              errorMessage: summarizeRootFailures(rootFailureDetails),
              responseExcerpt: summary,
            }
          : {
              ...baseRecord,
              durationMs: this.now() - startTimeMs,
              status: 'success',
              responseExcerpt: summary,
            };
      this.writeTelemetry(record, task);
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
    }
  }

  private async spawnSession(taskId: string, trigger: TelemetryTrigger = 'cron'): Promise<{
    session: AgentSession;
    memoryStore: MemoryStore;
    stateStore: StateStore;
    mcpManager?: McpManager;
    /** Archive the cross-surface registry handle. Called by runOnce on close. */
    dispose: () => void;
  }> {
    // Derive a unique-per-tick sessionId (daemonTraceLabel appends a random
    // suffix, so each tick gets its own label) so hook commands receive a
    // non-empty AFK_SESSION_ID and traces stay greppable by task name.
    const sessionId = daemonTraceLabel(taskId);
    const agentCwd = this.options.sessionConfig?.cwd ?? process.cwd();
    // Witness layer: open a fresh trace per spawned daemon session so its
    // subagent + skill lifecycle events are durable on disk — the AFK
    // (away-from-keyboard) surface where post-hoc inspection matters most.
    // Mirrors chat.ts / interactive bootstrap.ts. Returns null under
    // AFK_TRACE_DISABLED=1. The label is derived from the taskId (see
    // daemonTraceLabel) so traces are greppable by task name while each tick
    // still gets its own trace dir. Created before the hook registry so the
    // AFK gate's structured audit trace is wired from the start of the session.
    const trace = createDefaultTraceWriter({ sessionLabel: daemonTraceLabel(taskId) });
    const { registry, memoryStore } = createDefaultHookRegistry(
      undefined,
      'daemon',
      undefined,
      undefined,
      loadHooksConfig({ cwd: agentCwd }),
      { cwd: agentCwd, sessionId, ...(trace?.writer !== undefined ? { traceWriter: trace.writer } : {}) },
    );
    const stateStore = new StateStore(getStateDatabasePath());

    let mcpManager: McpManager | undefined;
    // Mirror the chat / telegram / interactive surfaces: include MCP configs
    // contributed by imported roots so the daemon reaches the same MCP
    // surface-parity, not just cwd `.mcp.json` + the global config.
    const importedMcpConfigs = resolveImportedRoots(loadImportFromConfig())
      .mcpConfigs.filter((c) => c.format === 'json')
      .map((c) => c.source);
    const loadedMcp = loadMcpConfig({
      cwd: agentCwd,
      ...(importedMcpConfigs.length > 0 ? { importedMcpConfigs } : {}),
    });
    const enabledMcpCount = Object.values(loadedMcp.mcpServers).filter((s) => !s.disabled).length;
    try {
      if (enabledMcpCount > 0) {
        // Witness layer: bracket the whole-fleet MCP connect with
        // mcp_connect_start / mcp_connect_done phases — surface-parity with
        // chat.ts, interactive/bootstrap.ts, and telegram/mcp-session.ts.
        // try/finally so mcp_connect_done fires even when an alwaysLoad server
        // makes fromConfig throw. Fire-and-forget; never gates the connect.
        const mcpStartedAt = Date.now();
        void emitSessionPhase(trace?.writer, {
          phase: 'mcp_connect_start',
          metadata: { serverCount: enabledMcpCount },
        });
        try {
          mcpManager = await McpManager.fromConfig(loadedMcp.mcpServers, {
            warnings: loadedMcp.warnings,
            serverLayers: loadedMcp.serverLayers,
            userAllowSecretEnv: loadedMcp.userAllowSecretEnv,
            ...(trace?.writer !== undefined ? { traceWriter: trace.writer } : {}),
          });
        } finally {
          void emitSessionPhase(trace?.writer, {
            phase: 'mcp_connect_done',
            durationMs: Date.now() - mcpStartedAt,
            metadata: { serverCount: enabledMcpCount },
          });
        }
      } else if (loadedMcp.warnings.length > 0) {
        for (const warning of loadedMcp.warnings) console.warn(`[mcp] ${warning}`);
      }
    } catch (err) {
      // McpManager.fromConfig re-throws when an `alwaysLoad` server fails to
      // connect. runOnce()'s finally cannot close this tick's MemoryStore
      // (its local is still null until spawnSession returns), so close it here
      // to avoid orphaning the SQLite handle on a connect failure.
      memoryStore.close();
      stateStore.close();
      throw err;
    }

    // Opt-in top-level tool-use-round ceiling (AFK_MAX_TOOL_USE_ITERATIONS).
    // Parsed inline from the already-imported `env` rather than via the CLI
    // `getMaxToolUseIterations()` helper to avoid an agent→cli layering
    // dependency (scheduler lives in src/agent/). Mirrors the lenient contract
    // of `parseMaxToolUseIterations` in cli/shared-helpers.ts: unset/non-numeric/
    // <=0 → undefined = unlimited (no behavior change); positive → floored int.
    // Placed BEFORE the `...sessionConfig` spread so an explicit
    // sessionConfig.maxToolUseIterations still wins (escape-hatch parity with
    // permissionMode/surface). The production path also re-applies the same
    // env fallback in the daemon.ts factory; both resolve to the same value.
    const rawMaxToolIters = env.AFK_MAX_TOOL_USE_ITERATIONS;
    const parsedMaxToolIters =
      rawMaxToolIters !== undefined && Number.isFinite(Number(rawMaxToolIters)) && Number(rawMaxToolIters) > 0
        ? Math.floor(Number(rawMaxToolIters))
        : undefined;
    const config: AgentConfig = {
      model: 'sonnet',
      // Daemon-spawned sessions run autonomously and require tool use without
      // human confirmation. Explicitly set bypassPermissions so the default
      // flip in C2 (from 'bypassPermissions' to 'default') does not silently
      // break scheduled tasks that depend on tool execution.
      permissionMode: 'bypassPermissions',
      hookRegistry: registry,
      // Pull tasks keep ask_question (handoff handler persists the question
      // for eventual reply); cron/sessionstart tasks strip it.
      isNonInteractive: trigger !== 'pull',
      // Surface stamps the session as 'daemon' so routing-decision telemetry
      // rows derive origin:'daemon' correctly. Placed before sessionConfig so
      // an operator escape-hatch via sessionConfig.surface can still override.
      // The production factory path (daemon.ts ComposeExecutor / SubagentExecutor
      // wiring) already stamps surface:'daemon' on its executors; this covers
      // the fallback/standalone path where no factory is set.
      surface: 'daemon',
      // Trace writer placed before sessionConfig so an operator-supplied
      // sessionConfig.traceWriter still wins (escape-hatch parity with
      // permissionMode).
      ...(trace ? { traceWriter: trace.writer } : {}),
      ...(mcpManager !== undefined ? { mcpManager } : {}),
      // Opt-in top-level tool-round ceiling default; overridable by an explicit
      // sessionConfig.maxToolUseIterations via the spread below.
      ...(parsedMaxToolIters !== undefined ? { maxToolUseIterations: parsedMaxToolIters } : {}),
      // sessionConfig may override permissionMode if the operator explicitly
      // wants a different mode for daemon tasks (intentional escape hatch).
      ...this.options.sessionConfig,
    };
    try {
      const traceOwner = this.options.sessionConfig?.traceWriter === undefined ? trace?.writer : undefined;
      const session = this.options.sessionFactory
        ? this.options.sessionFactory(config, traceOwner)
        : new AgentSession(injectCompanionPrimer(injectHotMemory(config)), traceOwner);
      // Step 7: register the daemon session in the cross-surface registry.
      // Best-effort; dispose() (archive) is invoked by runOnce on session close
      // so the long-running daemon never accumulates registry handles.
      const registration = registerSurfaceSession(session, {
        surface: 'daemon',
        model: config.model,
        cwd: agentCwd,
      });
      return {
        session,
        memoryStore,
        stateStore,
        dispose: registration.dispose,
        ...(mcpManager !== undefined ? { mcpManager } : {}),
      };
    } catch (err) {
      if (mcpManager) {
        await mcpManager.disconnectAll().catch(() => undefined);
      }
      // Session construction failed after MCP connected — close this tick's
      // MemoryStore and StateStore too (runOnce()'s finally can't, per the
      // fromConfig catch above) so they are not orphaned.
      memoryStore.close();
      stateStore.close();
      throw err;
    }
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
