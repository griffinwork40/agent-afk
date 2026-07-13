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
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as cron from 'node-cron';
import { runSweep } from '../worktree-sweep.js';
import type { ExecFileFn } from '../worktree-sweep.js';
import { IdleDetector } from './idle-detector.js';
import { dequeueNext } from './queue-store.js';
import { getQueueDir } from '../../paths.js';
import type { ScheduledTask as CronTask } from 'node-cron';
import { AgentSession } from '../session/agent-session.js';
import { registerSurfaceSession } from '../session/register-surface-session.js';
import { createDefaultHookRegistry } from '../default-hook-registry.js';
import { loadHooksConfig } from '../hooks/config-loader.js';
import { createDefaultTraceWriter } from '../trace/factory.js';
import { MemoryStore, injectHotMemory } from '../memory/index.js';
import { McpManager, loadMcpConfig } from '../mcp/index.js';
import { loadImportFromConfig, resolveImportedRoots } from '../../config/import-sources.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { AgentConfig } from '../types.js';
import { getTelemetryPath } from '../../paths.js';
import { redactInlineSecrets } from '../session/prompt-dump.js';
import { ScheduledTask, validateScheduledTask } from './triggers.js';
import {
  DEFAULT_SESSIONSTART_COOLDOWN_MS,
  evaluateSessionStartGates,
  type GateDecision,
  type SessionStartSkipReason,
} from './gates.js';

// Promisified once at module scope — the daemon's builtin worktree-prune task
// reuses the same node:child_process exec function on every tick; there is no
// reason to re-resolve it dynamically inside the handler.
const builtinPruneExecFile: ExecFileFn = promisify(execFileCallback) as ExecFileFn;

/**
 * Resolve the repo root for the builtin worktree-prune sweep. An explicit
 * `override` (AFK_WORKTREE_SWEEP_ROOT) wins; otherwise discover the repo
 * enclosing `cwd` via `git rev-parse --show-toplevel`. Returns `null` when the
 * cwd is not inside a git repository — the daemon's cwd is frequently $HOME
 * (launchd sets WorkingDirectory=homedir), so the caller skips gracefully
 * instead of erroring `fatal: not a git repository` on every nightly run.
 * Exported for unit testing with a stubbed execFile.
 */
export async function resolveWorktreePruneRoot(
  execFile: ExecFileFn,
  cwd: string,
  override: string | undefined,
): Promise<string | null> {
  if (override !== undefined && override.length > 0) return override;
  try {
    const top = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = top.stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/**
 * Build a charset-safe witness `sessionLabel` for a daemon tick, shaped
 * `<sanitized-taskId>-<uuid>` so traces are greppable by task name yet each
 * tick still gets its own trace dir (a bare taskId would make repeated ticks
 * append to one ever-growing file — the factory treats a repeated label as
 * resume/append).
 *
 * Contract: the result always satisfies SESSION_ID_SAFE (/^[a-zA-Z0-9_-]+$/)
 * because getTraceDir() validates the label and throws otherwise, and a raw
 * taskId may legally contain '.', '/', or spaces.
 */
export function daemonTraceLabel(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe || 'task'}-${randomUUID()}`;
}

export interface SchedulerOptions {
  /** Per-tick session config; merged with defaults at spawn time. */
  sessionConfig?: Partial<AgentConfig>;
  /** Override the telemetry sink (tests). Defaults to `~/.afk/agent-framework/forge-telemetry.jsonl`. */
  telemetryPath?: string;
  /** Override the session factory (tests). Defaults to `new AgentSession(config)`. */
  sessionFactory?: (config: AgentConfig) => AgentSession;
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
    for (const taskId of Array.from(this.registry.keys())) {
      this.unregister(taskId);
    }
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
    this.pullPollTimer = setInterval(() => {
      void this.pullTick();
    }, interval).unref();
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
      if (queued === null) return;
      const syntheticTask: ScheduledTask = {
        taskId: queued.id,
        command: queued.command,
        trigger: 'pull',
        ...(queued.notifyOn !== undefined ? { notifyOn: queued.notifyOn } : {}),
      };
      await this.runOnce(syntheticTask, 'pull');
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
    let mcpManager: McpManager | null = null;
    let disposeRegistration: (() => void) | null = null;
    this.idleDetector.increment();
    try {
      const spawned = await this.spawnSession(task.taskId);
      session = spawned.session;
      memoryStore = spawned.memoryStore;
      mcpManager = spawned.mcpManager ?? null;
      disposeRegistration = spawned.dispose;
      const response = await session.sendMessage(task.command);
      const responseText = redactInlineSecrets(response.content);
      const record: TelemetryRecord = {
        ...baseRecord,
        durationMs: this.now() - startTimeMs,
        status: 'success',
        responseExcerpt: responseText.slice(0, 280),
      };
      this.writeTelemetry(record, task, { responseText });
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
      const repoRoot = await resolveWorktreePruneRoot(
        builtinPruneExecFile,
        process.cwd(),
        env.AFK_WORKTREE_SWEEP_ROOT,
      );
      if (repoRoot === null) {
        // Daemon cwd is not inside a git repo (commonly $HOME under launchd).
        // Skip rather than erroring on every tick; the per-repo REPL boot-prune
        // still handles cleanup for repos the user actually works in.
        const skipped: TelemetryRecord = {
          ...baseRecord,
          durationMs: this.now() - startTimeMs,
          status: 'skipped',
          responseExcerpt:
            'worktree-prune skipped: daemon cwd is not inside a git repository ' +
            '(set AFK_WORKTREE_SWEEP_ROOT to target a repo)',
        };
        this.writeTelemetry(skipped, task);
        return skipped;
      }

      const maxAgeDaysClean =
        parseInt(env.AFK_WORKTREE_MAX_AGE_CLEAN ?? '', 10) || 14;
      const maxAgeDaysDirty =
        parseInt(env.AFK_WORKTREE_MAX_AGE_DIRTY ?? '', 10) || 30;

      const result = await runSweep({
        execFile: builtinPruneExecFile,
        repoRoot,
        dryRun: false, // soft-launch valve inside runSweep handles early dry-runs
        maxAgeDaysClean,
        maxAgeDaysDirty,
        scope: 'all',
        telemetryPath: this.telemetryPath(),
      });

      // 'stale-clean' is intentionally absent: the sweep engine preserves +
      // warns on stale-clean (commits ahead of base) rather than removing.
      const prunableVerdicts = new Set([
        'empty',
        'orphaned-dir',
        'orphaned-registration',
        'dead-owner',
      ]);
      const summary = result.dryRun
        ? `🔍 worktree-prune (dry-run): would remove ${result.candidates.filter((c) => prunableVerdicts.has(c.verdict)).length} worktree(s)`
        : `✂️ worktree-prune: removed ${result.removed.length}, warned ${result.warnings.length}`;

      const record: TelemetryRecord = {
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

  private async spawnSession(taskId: string): Promise<{
    session: AgentSession;
    memoryStore: MemoryStore;
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
      // Scheduler/cron sessions are headless (no human at the keyboard): strip
      // ask_question so a scheduled task never stalls on an unanswerable prompt.
      // The daemon session factory also forces this after its own config spread;
      // set it here as the base for the no-factory fallback (standalone
      // scheduler / tests). Placed before the sessionConfig spread so an
      // operator escape-hatch could still override it, mirroring permissionMode.
      isNonInteractive: true,
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
      const session = this.options.sessionFactory
        ? this.options.sessionFactory(config)
        : new AgentSession(injectHotMemory(config));
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
        dispose: registration.dispose,
        ...(mcpManager !== undefined ? { mcpManager } : {}),
      };
    } catch (err) {
      if (mcpManager) {
        await mcpManager.disconnectAll().catch(() => undefined);
      }
      // Session construction failed after MCP connected — close this tick's
      // MemoryStore too (runOnce()'s finally can't, per the fromConfig catch
      // above) so it is not orphaned.
      memoryStore.close();
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
    // Fire-and-forget. Notification callbacks must not block telemetry
    // writes or crash the scheduler — every error is swallowed and logged.
    try {
      const result = cb(record, details);
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
