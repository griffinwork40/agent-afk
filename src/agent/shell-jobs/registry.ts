/**
 * In-memory registry for user-typed shell jobs launched via `!cmd` /
 * `!&cmd` in the REPL.
 *
 * Lifecycle: per-REPL-session. The {@link runReplLoop} entry point
 * constructs one registry, wires it into the `!` dispatch path and the
 * `/sh` slash command, and calls {@link ShellJobRegistry.killAll} from
 * the loop's finally block so background jobs don't outlive the parent
 * REPL.
 *
 * Distinct from:
 *   - `BackgroundTaskManager` (src/cli/commands/interactive/background.ts)
 *     — tracks BACKGROUNDED MODEL TURNS (Ctrl+B / `/bg <prompt>`).
 *   - `BackgroundAgentRegistry` (src/agent/background-registry.ts) — tracks
 *     BACKGROUNDED SUBAGENT DISPATCHES (`agent` tool's `mode: 'background'`).
 *
 * These three names sit at different layers (shell process, model turn,
 * subagent fork) and are intentionally separate. Sharing the `BackgroundX`
 * prefix between any of them would invite incorrect cross-wiring.
 *
 * @module agent/shell-jobs/registry
 */

import { EventEmitter } from 'node:events';
import { startShell, type ShellHandle, type ShellResult, type StartShellOptions } from './streamer.js';

export type ShellJobStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface ShellJob {
  readonly id: string;
  readonly command: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly mode: 'foreground' | 'background';
  status: ShellJobStatus;
  /** Set when the job settles. */
  result?: ShellResult;
}

export interface ShellJobRegistryEvents {
  /**
   * Fired after a job's settle resolves. Listeners can read `job.status`
   * and `job.result` to decide what to surface (e.g. a `commitAbove`
   * completion notification + injecting the captured output into the
   * conversation's pending-context buffer).
   */
  complete: [job: ShellJob];
}

/**
 * Options forwarded to the per-job streamer plus the bookkeeping fields
 * the registry adds on top.
 */
export type StartJobOptions = Omit<StartShellOptions, 'onChunk' | 'abort'> & {
  /** Per-job onChunk passthrough. Wired by the REPL to `commitAbove`. */
  onChunk?: StartShellOptions['onChunk'];
  /** 'background' detaches the promise; 'foreground' returns it for awaiting. */
  mode: 'foreground' | 'background';
};

/**
 * Cap on retained job history. Once the `jobs` map exceeds this, the oldest
 * TERMINAL (non-running) jobs are evicted on each settle so a long-lived REPL
 * session doesn't accumulate `ShellResult` buffers (≤ maxBytes each, default
 * ~100KB) without bound. Running jobs are never evicted — they're needed for
 * `kill()`/`list()`. (PR #565 review: M1.)
 */
const MAX_JOB_HISTORY = 200;

export class ShellJobRegistry extends EventEmitter<ShellJobRegistryEvents> {
  private readonly jobs = new Map<string, ShellJob>();
  private readonly handles = new Map<string, ShellHandle>();
  private readonly aborts = new Map<string, AbortController>();
  private counter = 0;

  /**
   * Start a new job and register it.
   *
   * For foreground jobs the caller is expected to await the returned
   * promise (and route `onChunk` to `commitAbove`). For background jobs
   * the caller fires-and-forgets — the registry's `'complete'` event
   * fires when the child exits.
   */
  start(opts: StartJobOptions): { job: ShellJob; handle: ShellHandle } {
    const id = `sh-${++this.counter}`;
    const ac = new AbortController();
    const handle = startShell({
      command: opts.command,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      abort: ac.signal,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.onChunk !== undefined ? { onChunk: opts.onChunk } : {}),
    });

    const job: ShellJob = {
      id,
      command: opts.command,
      pid: handle.pid,
      startedAt: Date.now(),
      mode: opts.mode,
      status: 'running',
    };
    this.jobs.set(id, job);
    this.handles.set(id, handle);
    this.aborts.set(id, ac);

    // Settle wiring — translate `ShellResult.errorReason` into `ShellJobStatus`
    // and emit the `complete` event. Failures inside listeners must not break
    // the registry: handle.promise has its own try/catch and the EventEmitter
    // emits synchronously here, so wrap the emit in try/catch.
    handle.promise.then((result) => {
      job.result = result;
      job.status = mapStatus(result);
      this.aborts.delete(id);
      this.handles.delete(id);  // Release ChildProcess ref (L-2).
      try {
        this.emit('complete', job);
      } catch (err) {
        // Listener threw — don't propagate, but log so it's visible in dev.
        // External constraint: registry events must not be reentrant
        // failure-amplifiers.
        // eslint-disable-next-line no-console
        console.warn(
          `[shell-jobs] listener for 'complete' threw on ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // Evict old terminal jobs AFTER the listener runs so 'complete'
      // consumers always see the just-settled job still in the map. (M1)
      this.pruneHistory();
    });

    return { job, handle };
  }

  /** Lookup a job by id. */
  get(id: string): ShellJob | undefined {
    return this.jobs.get(id);
  }

  /** Snapshot of all jobs, oldest first. */
  list(): readonly ShellJob[] {
    return [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Subset of `list()` filtered to currently-running jobs. */
  running(): readonly ShellJob[] {
    return this.list().filter((j) => j.status === 'running');
  }

  /**
   * Kill a single running job. Idempotent — returns false if the job is
   * not found or already terminal; true if the kill signal was sent.
   *
   * Uses the per-job AbortController to flow through the streamer's
   * abort path (so it settles as `errorReason: 'abort'`, not as a
   * caller-side kill). Same end-state — the process-group SIGKILL is the
   * same in either path — but the abort path is preferred so all
   * "terminate from outside" signals land in the same code branch.
   */
  kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    const ac = this.aborts.get(id);
    if (ac) {
      ac.abort();
      return true;
    }
    // Fallback if abort got cleaned up between status check and lookup
    // (extremely unlikely; covers the race window).
    const handle = this.handles.get(id);
    if (handle) {
      handle.kill();
      return true;
    }
    return false;
  }

  /**
   * Kill every running job. Used by the REPL's finally block so bg jobs
   * don't outlive their parent.
   *
   * Returns the list of jobs that were running at the time of the call
   * (whether or not their kill signal landed) so the caller can surface
   * a "Killing N jobs on exit" notice. The promises resolve at their own
   * pace via the registered abort handlers.
   */
  killAll(): readonly ShellJob[] {
    const running = this.running();
    for (const job of running) {
      this.kill(job.id);
    }
    return running;
  }

  /**
   * Number of currently-running jobs — cheaper than `running().length`
   * for status-bar polling paths.
   */
  runningCount(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === 'running') n++;
    return n;
  }

  /**
   * Evict the oldest terminal jobs once history exceeds
   * {@link MAX_JOB_HISTORY}. Map iteration is insertion-ordered, so this
   * walks oldest-first and deletes only non-running entries until the map is
   * back under the cap. Running jobs are skipped. Deleting the current entry
   * during Map iteration is safe per spec. (PR #565 review: M1.)
   */
  private pruneHistory(): void {
    if (this.jobs.size <= MAX_JOB_HISTORY) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOB_HISTORY) break;
      if (job.status !== 'running') this.jobs.delete(id);
    }
  }
}

function mapStatus(result: ShellResult): ShellJobStatus {
  if (result.errorReason === undefined) return 'completed';
  if (result.errorReason === 'abort') return 'killed';
  return 'failed';
}
