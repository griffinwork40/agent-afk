/**
 * Registry of model-started background processes (`bash run_in_background`).
 *
 * One instance per ROOT interactive session. Distinct from the user's `!&`
 * {@link ShellJobRegistry} on purpose: model jobs log to a capped file instead
 * of an in-memory buffer that kills on overflow, carry a max runtime and a
 * graceful TERM->KILL stop, and must not be pruned by or double-delivered
 * through the user passthrough. Ids use the `proc-` prefix (user jobs are
 * `sh-N`) so the background tools can route by id.
 *
 * Ownership: the session that constructed the registry. A turn abort does not
 * touch jobs; `killAll()` (session teardown) stops them gracefully, and a
 * synchronous `process.on('exit')` fan-out SIGKILLs any group still live when
 * the afk process exits abruptly. Nothing is ever restarted.
 *
 * @module agent/shell-jobs/process-jobs
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getProcessJobSessionDir } from '../../paths.js';
import { ProcessLogSink } from './process-log-sink.js';
import { launchProcess, terminateWithGrace, type LaunchedProcess, type ProcessExit } from './process-launcher.js';
import { enforceSessionQuota, scheduleProcessJobSweep } from './process-jobs.sweep.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { TraceSink } from '../trace/index.js';

export type ProcessJobStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
export type ProcessCancelSource = 'model' | 'user' | 'teardown';

export const PROCESS_JOB_ID_PREFIX = 'proc-';
export const DEFAULT_MAX_CONCURRENT_PROCESS_JOBS = 3;
export const DEFAULT_PROCESS_MAX_RUNTIME_MS = 2 * 60 * 60 * 1000;
export const MAX_PROCESS_MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CANCEL_GRACE_MS = 5_000;
/** Teardown uses a shorter TERM->KILL grace so session exit stays prompt. */
const DEFAULT_TEARDOWN_GRACE_MS = 2_000;
const DEFAULT_SESSION_QUOTA_BYTES = 128 * 1024 * 1024;
const MAX_HISTORY = 50;

export function isProcessJobId(id: string): boolean {
  return id.startsWith(PROCESS_JOB_ID_PREFIX);
}

/** Public, read-only view of a job. */
export interface ProcessJobSnapshot {
  readonly id: string;
  readonly command: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: ProcessJobStatus;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly orphansReaped?: boolean;
  readonly spawnError?: string;
  readonly cancelSource?: ProcessCancelSource;
  readonly logPath: string;
  readonly ownerSessionId?: string;
  readonly maxRuntimeMs: number;
  readonly bytes: number;
  readonly logError?: string;
}

interface InternalJob {
  id: string;
  command: string;
  startedAt: number;
  maxRuntimeMs: number;
  ownerSessionId?: string;
  logPath: string;
  sink: ProcessLogSink;
  launched: LaunchedProcess;
  status: ProcessJobStatus;
  endedAt?: number;
  exit?: ProcessExit;
  cancelSource?: ProcessCancelSource;
  timedOut: boolean;
}

export interface ProcessJobRegistryOptions {
  maxConcurrent?: number;
  sessionLabel?: string;
  /** Override the log directory (tests). Default: per-session dir under the state dir. */
  logDir?: string;
  logCapBytes?: number;
  sessionQuotaBytes?: number;
  cancelGraceMs?: number;
  closeGraceMs?: number;
  reapGraceMs?: number;
  /** Run the 7-day directory sweep on construction. Default true unless `logDir` is set. */
  sweep?: boolean;
  /**
   * Witness trace writer. When supplied, emits `background_process_settled`
   * on each job completion so `afk trace show` can reconstruct background
   * jobs. Optional — tests and surfaces without a trace writer pass undefined.
   */
  traceWriter?: TraceSink;
}

export interface StartProcessJobArgs {
  command: string;
  cwd?: string | undefined;
  env: NodeJS.ProcessEnv;
  maxRuntimeMs?: number;
  ownerSessionId?: string | undefined;
}

export class ProcessJobCapError extends Error {
  constructor(readonly cap: number) {
    super(`Background process limit reached (${cap} running). Cancel one before starting another.`);
    this.name = 'ProcessJobCapError';
  }
}

export interface ProcessJobRegistryEvents {
  settled: [job: ProcessJobSnapshot];
  /**
   * Emitted when the cancel tool's CANCEL_WAIT_MS race resolves undefined,
   * meaning the model-cancel did NOT observe the job's final state.  Listeners
   * (e.g. ProcessJobNotifier) can use this to arrange a deferred delivery so
   * the model eventually learns the outcome.
   */
  cancelTimeout: [jobId: string];
}

export class ProcessJobRegistry extends EventEmitter<ProcessJobRegistryEvents> {
  readonly sessionLabel: string;
  readonly logDir: string;
  readonly maxConcurrent: number;
  private readonly opts: ProcessJobRegistryOptions;
  private readonly jobs = new Map<string, InternalJob>();
  private counter = 0;
  /** Set by killAll(): a registry being torn down accepts no new jobs. */
  private closed = false;
  private exitHookInstalled = false;
  private readonly exitHook = (): void => {
    // Synchronous last resort: the event loop is gone, so no grace period.
    // Use signalGroup() rather than killProcessGroup() directly so the
    // launcher's win32 freed-PID guard (no signal after leader exit) is
    // respected inside the exit hook too.
    for (const job of this.jobs.values()) {
      if (job.launched.isLive()) job.launched.signalGroup('SIGKILL');
    }
  };

  constructor(opts: ProcessJobRegistryOptions = {}) {
    super();
    this.opts = opts;
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_PROCESS_JOBS;
    this.sessionLabel = opts.sessionLabel ?? `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    this.logDir = opts.logDir ?? getProcessJobSessionDir(this.sessionLabel);
    if (opts.sweep ?? opts.logDir === undefined) scheduleProcessJobSweep(this.sessionLabel);
  }

  /** Start a job. Throws {@link ProcessJobCapError} at the concurrency cap. */
  start(args: StartProcessJobArgs): ProcessJobSnapshot {
    if (this.closed) throw new Error('This session is ending; no new background processes can start.');
    if (this.runningCount() >= this.maxConcurrent) throw new ProcessJobCapError(this.maxConcurrent);
    const id = `${PROCESS_JOB_ID_PREFIX}${++this.counter}`;
    fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    enforceSessionQuota(this.logDir, this.opts.sessionQuotaBytes ?? DEFAULT_SESSION_QUOTA_BYTES, this.liveLogPaths());
    const logPath = path.join(this.logDir, `${id}.log`);
    const sink = new ProcessLogSink({ logPath, ...(this.opts.logCapBytes !== undefined ? { capBytes: this.opts.logCapBytes } : {}) });
    const launched = launchProcess({
      command: args.command, cwd: args.cwd, env: args.env, sink,
      ...(this.opts.closeGraceMs !== undefined ? { closeGraceMs: this.opts.closeGraceMs } : {}),
      ...(this.opts.reapGraceMs !== undefined ? { reapGraceMs: this.opts.reapGraceMs } : {}),
    });
    const maxRuntimeMs = Math.min(args.maxRuntimeMs ?? DEFAULT_PROCESS_MAX_RUNTIME_MS, MAX_PROCESS_MAX_RUNTIME_MS);
    const job: InternalJob = {
      id, command: args.command, startedAt: Date.now(), maxRuntimeMs, logPath, sink, launched,
      status: 'running', timedOut: false,
      ...(args.ownerSessionId !== undefined ? { ownerSessionId: args.ownerSessionId } : {}),
    };
    this.jobs.set(id, job);
    this.installExitHook();
    const timer = setTimeout(() => {
      if (launched.leaderExited()) return; // exited on its own; settling now
      job.timedOut = true;
      terminateWithGrace(launched, this.cancelGraceMs());
    }, maxRuntimeMs);
    timer.unref();
    void launched.exited.then((exit) => {
      clearTimeout(timer);
      this.onSettled(job, exit);
    });
    return this.snapshot(job);
  }

  get(id: string): ProcessJobSnapshot | undefined {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : undefined;
  }

  /** Recent ANSI-stripped output for a job, or undefined for an unknown id. */
  tail(id: string, maxChars: number): string | undefined {
    return this.jobs.get(id)?.sink.tail(maxChars);
  }

  list(): readonly ProcessJobSnapshot[] {
    return [...this.jobs.values()].map((j) => this.snapshot(j));
  }

  runningCount(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === 'running') n++;
    return n;
  }

  /**
   * True once the leader process has exited for the given job id (the job may
   * still be settling: close-grace or orphan reap). Returns false for an
   * unknown id. Used by tests that need to synchronise on the same signal as
   * the cancel() guard — the Node 'exit' event — rather than an OS PID probe,
   * which can report the PID gone before Node has delivered the event.
   */
  leaderExited(id: string): boolean {
    return this.jobs.get(id)?.launched.leaderExited() ?? false;
  }

  /**
   * Gracefully stop a job (TERM the group, KILL after the grace period).
   * Returns the snapshot, or undefined for an unknown id. An already-settled
   * job is returned unchanged and no signal is sent.
   */
  cancel(id: string, source: ProcessCancelSource, graceMs = this.cancelGraceMs()): ProcessJobSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    // leaderExited() guard: a job whose leader already exited (still settling:
    // close-grace or orphan reap) keeps its natural outcome, never 'cancelled'.
    if (job.status === 'running' && job.cancelSource === undefined && !job.launched.leaderExited()) {
      job.cancelSource = source;
      terminateWithGrace(job.launched, graceMs);
    }
    return this.snapshot(job);
  }

  /**
   * Signal that the model-cancel tool timed out before observing the job's
   * final state.  Emits `'cancelTimeout'` so the notifier can arrange deferred
   * delivery when the job eventually settles.
   */
  emitCancelTimeout(id: string): void {
    this.emit('cancelTimeout', id);
  }

  /** Wait for a job to settle. Resolves undefined for an unknown id. */
  async waitFor(id: string): Promise<ProcessJobSnapshot | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    await job.launched.exited;
    return this.snapshot(job);
  }

  /** Session teardown: stop every running job and wait for all to settle. */
  async killAll(graceMs = Math.min(DEFAULT_TEARDOWN_GRACE_MS, this.cancelGraceMs())): Promise<readonly ProcessJobSnapshot[]> {
    this.closed = true;
    const running = [...this.jobs.values()].filter((j) => j.status === 'running');
    for (const job of running) {
      this.cancel(job.id, 'teardown', graceMs);
      // A cancel already in progress keeps its longer grace; teardown re-arms
      // the shorter one so session exit stays bounded.
      terminateWithGrace(job.launched, graceMs);
    }
    await Promise.all(running.map((j) => j.launched.exited));
    if (this.runningCount() === 0) this.dispose();
    return running.map((j) => this.snapshot(j));
  }

  /** Remove the process exit hook. Running jobs are NOT stopped. */
  dispose(): void {
    if (!this.exitHookInstalled) return;
    process.removeListener('exit', this.exitHook);
    this.exitHookInstalled = false;
  }

  private onSettled(job: InternalJob, exit: ProcessExit): void {
    job.exit = exit;
    job.endedAt = Date.now();
    job.status = statusFor(job, exit);
    if (this.runningCount() === 0) this.dispose();
    this.pruneHistory();
    // Witness trace: background_process_settled so afk trace show can
    // reconstruct background job outcomes. Fire-and-forget — trace errors are
    // swallowed inside emitSessionPhase and must never break settlement.
    const snap = this.snapshot(job);
    void emitSessionPhase(this.opts.traceWriter, {
      phase: 'background_process_settled',
      metadata: {
        jobId: snap.id,
        status: snap.status,
        exitCode: snap.exitCode !== undefined && snap.exitCode !== null ? String(snap.exitCode) : '',
        signal: snap.signal ?? '',
        durationMs: (snap.endedAt ?? Date.now()) - snap.startedAt,
        bytes: snap.bytes,
      },
    });
    try {
      this.emit('settled', snap);
    } catch (err) {
      // A listener failure must not break settlement bookkeeping.
      process.stderr.write(`[afk] process-jobs: settled listener threw: ${String(err)}\n`);
    }
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    process.on('exit', this.exitHook);
    this.exitHookInstalled = true;
  }

  private cancelGraceMs(): number {
    return this.opts.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  }

  private liveLogPaths(): Set<string> {
    const out = new Set<string>();
    for (const j of this.jobs.values()) if (j.status === 'running') out.add(j.logPath);
    return out;
  }

  private pruneHistory(): void {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_HISTORY) break;
      if (job.status !== 'running') this.jobs.delete(id);
    }
  }

  private snapshot(job: InternalJob): ProcessJobSnapshot {
    const e = job.exit;
    return {
      id: job.id, command: job.command, pid: job.launched.pid, startedAt: job.startedAt,
      status: job.status, logPath: job.logPath, maxRuntimeMs: job.maxRuntimeMs, bytes: job.sink.totalBytes,
      ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
      ...(e !== undefined ? { exitCode: e.exitCode, signal: e.signal, orphansReaped: e.orphansReaped } : {}),
      ...(e?.spawnError !== undefined ? { spawnError: e.spawnError } : {}),
      ...(job.cancelSource !== undefined ? { cancelSource: job.cancelSource } : {}),
      ...(job.ownerSessionId !== undefined ? { ownerSessionId: job.ownerSessionId } : {}),
      ...(job.sink.lastError !== undefined ? { logError: job.sink.lastError } : {}),
    };
  }
}

function statusFor(job: InternalJob, exit: ProcessExit): ProcessJobStatus {
  if (exit.spawnError !== undefined) return 'failed';
  if (job.cancelSource !== undefined) return 'cancelled';
  if (job.timedOut) return 'timed_out';
  return exit.exitCode === 0 && exit.signal === null ? 'completed' : 'failed';
}
