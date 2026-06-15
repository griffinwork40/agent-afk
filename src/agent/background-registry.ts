/**
 * Background subagent registry — in-memory tracker for fire-and-forget jobs
 * dispatched via the `agent` tool's `mode: 'background'` branch.
 *
 * This sits between two existing primitives:
 *
 *   - `SubagentHandle.runInBackground(prompt, onResult)` — detaches the
 *     child's promise and invokes a callback on terminal state.
 *
 * The registry owns one entry per dispatched background job. It exposes:
 *
 *   - `register()` — called by `SubagentExecutor` after `forkSubagent()`
 *     resolves; binds a stable `jobId` to the handle and wires the
 *     terminal-state callback into status transitions + witness events.
 *   - `list()` / `get()` — observable surface for `/bgsub` slash commands.
 *   - `join(jobId)` — resolves with the final `SubagentResult` once the
 *     job terminates. Emits a `joined` witness event. Re-joinable.
 *   - `cancelJob(jobId)` — explicitly cancels a still-running job.
 *   - `cancelAll()` — bulk cancel; called on parent-session teardown so
 *     background jobs don't outlive their parent.
 *
 * **Lifetime contract.** Background jobs are bounded by the parent's
 * `SubagentManager` root abort. When the parent session is aborted, the
 * `AbortGraph` cascades down to every forked child including those whose
 * runtime is "detached" from the executor's await — they will reach a
 * `cancelled` terminal state and the registry will see it via the
 * `runInBackground` callback. This is the "cancel-by-default" semantic.
 *
 * **No persistence.** v1 is in-memory only. A process restart loses the
 * registry. Jobs that were cancelled by abort cascade are still
 * observable for the lifetime of this process.
 *
 * **No silent context injection.** Completed jobs sit in the registry
 * until the caller invokes `join()`. The registry never pushes results
 * into the parent session's conversation.
 *
 * **Memory management.** Terminal jobs are evicted ~5 minutes after they
 * settle via a `setTimeout(...).unref()` so the timer doesn't keep the
 * Node process alive. New `register()` calls also enforce a
 * `maxConcurrentJobs` cap (default 10); exceeding the cap throws
 * `BackgroundJobCapError`.
 *
 * @module agent/background-registry
 */

import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { SubagentHandle, SubagentResult, SubagentStatus } from './subagent.js';
import { buildResultFromError, createEmptyTrace } from './subagent/result.js';
import { debugLog } from '../utils/debug.js';
import { emitBackgroundAgent } from './trace/emit.js';
import type { TraceWriter } from './trace/index.js';
import { BgJobLogWriter } from './bg-job-log.js';
import type { BgJobMeta } from './bg-job-log.js';
import { getBgJobsRoot, getBgJobDir } from '../paths.js';
import { appendRoutingDecision } from './routing-telemetry.js';

export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundJob {
  readonly jobId: string;
  readonly subagentId: string;
  readonly label: string;
  readonly model: string;
  readonly startedAt: number;
  readonly status: BackgroundJobStatus;
  /** Terminal-state result, set when status leaves 'running'. */
  readonly result?: SubagentResult;
  /** Monotonic completion timestamp. Undefined while running. */
  readonly endedAt?: number;
}

interface InternalJob extends BackgroundJob {
  status: BackgroundJobStatus;
  result?: SubagentResult;
  endedAt?: number;
  handle: SubagentHandle;
  joiners: Array<(r: SubagentResult) => void>;
  terminalSettled: Promise<SubagentResult>;
  settle: (r: SubagentResult) => void;
  /**
   * Set before `handle.cancel()` is called to record why the job was
   * cancelled — `'explicit'` for `cancelJob()` and `'cascade'` for
   * `cancelAll()`. Read by `markTerminal()` to attribute the trace event.
   */
  cancelSource?: 'explicit' | 'cascade';
  /**
   * Rolling tail of subagent output text — last ~4KB. Used by the
   * BackgroundSummarizer to feed Haiku without a transcript log. Trimmed
   * from the front when it overflows. Not exposed via BackgroundJob (the
   * public shape) — internal-only.
   */
  transcriptTail: string;
  /**
   * Optional parent session id forwarded from RegisterArgs.
   * Surfaced to both routing-telemetry events and bg-job meta records.
   */
  parentSessionId?: string | undefined;
}

/** Default TTL for evicting terminal jobs from the registry map. */
const TERMINAL_EVICT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Maximum byte length of the rolling transcript tail kept per job.
 * The BackgroundSummarizer reads this buffer to feed Haiku without
 * maintaining a separate log file.
 */
export const MAX_TRANSCRIPT_TAIL_BYTES = 4096;

/**
 * Best-effort routing-telemetry helper. Swallows errors so telemetry
 * failures never surface as registry errors.
 */
function emitRoutingTelemetry(entry: Parameters<typeof appendRoutingDecision>[0]): void {
  void appendRoutingDecision(entry).catch(() => {});
}

/**
 * Maximum time to wait for a single job's terminal callback to settle
 * during `cancelAll()`. A provider that doesn't yield after abort could
 * otherwise hang session teardown indefinitely. On timeout, the job is
 * treated as settled (teardown proceeds) and a warning is logged.
 */
const CANCEL_DRAIN_TIMEOUT_MS = 5000; // 5 seconds

/** Default maximum number of concurrently running background jobs. */
const DEFAULT_MAX_CONCURRENT_JOBS = 10;

export interface BackgroundRegistryOptions {
  /** Optional trace writer. Witness events become no-ops when undefined. */
  traceWriter?: TraceWriter | undefined;
  /**
   * Maximum number of concurrently *running* background jobs.
   * `register()` throws `BackgroundJobCapError` when this limit is reached.
   * Defaults to {@link DEFAULT_MAX_CONCURRENT_JOBS} (10).
   */
  maxConcurrentJobs?: number;
}

export interface RegisterArgs {
  handle: SubagentHandle;
  prompt: string;
  model: string;
  /**
   * Optional parent session id. Forwarded to routing-telemetry events
   * (`subagent.completed` / `subagent.failed`) and persisted to the bg-job
   * meta record for log correlation.
   */
  parentSessionId?: string | undefined;
}

/**
 * Thrown by `register()` when the registry already has
 * `maxConcurrentJobs` running jobs. The caller should tear down the
 * orphaned handle and surface an error to the model.
 */
export class BackgroundJobCapError extends Error {
  constructor(running: number, cap: number) {
    super(
      `Background job cap reached (${running}/${cap} running). ` +
        'Wait for existing jobs to finish or cancel them before spawning more.',
    );
    this.name = 'BackgroundJobCapError';
  }
}

export interface BackgroundRegistryEvents {
  /** Fires when a new job is registered (status 'running'). */
  started: [job: BackgroundJob];
  /** Fires when a job transitions to a terminal status (any of completed/failed/cancelled). */
  settled: [job: BackgroundJob];
  /** Fires when join() resolves (a separate witness; settled may have fired first or concurrently). */
  joined: [job: BackgroundJob];
}

export class BackgroundAgentRegistry extends EventEmitter<BackgroundRegistryEvents> {
  private readonly jobs = new Map<string, InternalJob>();
  /** Monotonic job counter. Seeded with a random offset so parallel
   *  test workers (vitest runs files concurrently) don't produce
   *  colliding jobIds that share the same on-disk `bg/` directory. */
  private counter = Math.floor(Math.random() * 65536);
  private readonly traceWriter: TraceWriter | undefined;
  private readonly maxConcurrentJobs: number;

  constructor(options: BackgroundRegistryOptions = {}) {
    super();
    this.traceWriter = options.traceWriter;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;

    // 7-day eviction sweep: fire after 5 seconds so it doesn't block startup.
    // `.unref()` prevents the timer from keeping the Node process alive.
    const sweepTimer = setTimeout(
      () => this._sweepOldJobs().catch((e: unknown) =>
        process.stderr.write(`[afk] bg sweep error: ${String(e)}\n`),
      ),
      5000,
    );
    sweepTimer.unref();
  }

  /**
   * Register a freshly-forked subagent handle as a background job and start
   * its detached execution. Returns the assigned jobId immediately. The
   * handle's `runInBackground()` callback wires terminal state back to
   * `markTerminal()`.
   *
   * **Ordering invariant**: the `background_agent.started` witness event
   * is emitted BEFORE `runInBackground` is invoked, so any operator
   * reading the trace sees the start record before any child events
   * the SDK might emit via `subagent_lifecycle`.
   *
   * @throws {BackgroundJobCapError} when the number of running jobs is at
   *   or above `maxConcurrentJobs`. The caller must tear down the handle.
   */
  register(args: RegisterArgs): BackgroundJob {
    const { job, jobId, writer, metaRecord } = this.createJobEntry(args);

    // Start detached execution. `runInBackground` swallows the promise; the
    // callback is our terminal-state hook. The onProgress callback pipes every
    // OutputEvent to the writer and also feeds text content to appendTranscript.
    args.handle.runInBackground(
      args.prompt,
      (result) => {
        this.markTerminal(jobId, result, writer, metaRecord);
      },
      (event) => {
        writer.write(event);
        // Feed text content to the Haiku summarizer's transcript ring buffer.
        if (event.type === 'chunk' && event.chunk.type === 'content') {
          this.appendTranscript(jobId, event.chunk.content);
        }
      },
    );

    return this.snapshot(job);
  }

  /**
   * Adopt an *already-running* subagent handle as a background job. This is
   * the user-promotion path (Ctrl+B on a running foreground subagent): the
   * handle's `runToResult()` is already in flight under a foreground
   * `SubagentExecutor.execute()` await, so — unlike {@link register} — we must
   * NOT call `runInBackground()`. That would re-enter `run()`, which throws
   * "already running" when status is `'running'` (see handle.ts). Instead we
   * attach the terminal-state callback to the caller-supplied in-flight
   * `runPromise`.
   *
   * Limitation: progress events for the already-running portion are NOT teed
   * to this job's log writer or transcript tail — the handle's progress sink
   * was bound when the foreground run started and cannot be retroactively
   * rewired. The final result is still captured and `join()`-able; only the
   * rolling transcript (used by the optional Haiku summarizer) is empty for
   * promoted jobs. New jobs that need full progress capture use
   * {@link register}.
   *
   * @throws {BackgroundJobCapError} when the running-job cap is reached. The
   *   caller (executor) should fall back to awaiting the foreground run rather
   *   than dropping the subagent.
   */
  adoptRunning(args: RegisterArgs & { runPromise: Promise<SubagentResult> }): BackgroundJob {
    const { job, jobId, writer, metaRecord } = this.createJobEntry(args);

    // `runToResult` is designed not to reject — it catches internally and
    // resolves a failure result (handle.ts) — so `.then` covers the normal
    // path. `.catch` is defense-in-depth, mirroring `runInBackground`'s naked
    // void-promise guard: if anything unexpected escapes, synthesize a failed
    // terminal so the job never hangs in 'running'.
    void args.runPromise
      .then((result) => {
        this.markTerminal(jobId, result, writer, metaRecord);
      })
      .catch((err: unknown) => {
        debugLog('adoptRunning: unexpected rejection from in-flight runPromise', err);
        this.markTerminal(
          jobId,
          buildResultFromError(args.handle.id, 'failed', err, createEmptyTrace()),
          writer,
          metaRecord,
        );
      });

    return this.snapshot(job);
  }

  /**
   * Allocate a registry entry for a new background job: cap-check, assign a
   * `jobId`, register the in-memory job, emit the `started` witness, and open
   * the persistent log writer. Shared by {@link register} (fresh handle, not
   * yet started) and {@link adoptRunning} (handle already mid-flight). The two
   * differ only in how the terminal-state callback is attached afterwards.
   *
   * @throws {BackgroundJobCapError} when the running-job cap is reached.
   */
  private createJobEntry(args: RegisterArgs): {
    job: InternalJob;
    jobId: string;
    writer: BgJobLogWriter;
    metaRecord: BgJobMeta;
  } {
    const running = [...this.jobs.values()].filter((j) => j.status === 'running').length;
    if (running >= this.maxConcurrentJobs) {
      throw new BackgroundJobCapError(running, this.maxConcurrentJobs);
    }

    const jobId = this.nextJobId();
    // Truncate label for trace audit — 80 chars matches the threshold used by
    // SubagentExecutor's agentType derivation for tree-line rendering.
    const label = args.prompt.trim().slice(0, 80);
    const startedAt = Date.now();

    let settle!: (r: SubagentResult) => void;
    const terminalSettled = new Promise<SubagentResult>((resolve) => {
      settle = resolve;
    });

    const job: InternalJob = {
      jobId,
      subagentId: args.handle.id,
      label,
      model: args.model,
      startedAt,
      status: 'running',
      handle: args.handle,
      joiners: [],
      terminalSettled,
      settle,
      transcriptTail: '',
      parentSessionId: args.parentSessionId,
    };
    this.jobs.set(jobId, job);

    // Witness: started event fires before the detached execution begins so
    // trace order matches lifecycle order. Fire-and-forget per witness policy.
    void emitBackgroundAgent(this.traceWriter, {
      transition: 'started',
      jobId,
      subagentId: args.handle.id,
      label,
      model: args.model,
    });
    this.emit('started', this.snapshot(job));

    // Persistent log writer: opened per-job so the OutputEvent stream is
    // durable even if the parent REPL exits after the job settles.
    const writer = new BgJobLogWriter(jobId);
    const metaRecord: BgJobMeta = {
      jobId,
      subagentId: args.handle.id,
      label,
      promptHash: createHash('sha256').update(args.prompt).digest('hex'),
      model: args.model,
      startedAt,
      status: 'running',
      ...(args.parentSessionId !== undefined ? { parentSessionId: args.parentSessionId } : {}),
      schemaVersion: 1,
    };
    void writer.writeMeta(metaRecord);

    return { job, jobId, writer, metaRecord };
  }

  /** Read-only snapshot of one job. */
  get(jobId: string): BackgroundJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job) : undefined;
  }

  /** Snapshot of every known job, in registration order. */
  list(): readonly BackgroundJob[] {
    return [...this.jobs.values()].map((j) => this.snapshot(j));
  }

  /**
   * Wait for a job to reach a terminal state and return its result.
   *
   * - Already-terminal jobs resolve immediately with the stored result.
   * - Running jobs await the next terminal transition.
   * - Unknown jobIds reject.
   *
   * Emits a `background_agent.joined` witness event when the wait resolves.
   * Multiple callers may join the same job; each receives the result and
   * each triggers its own joined event.
   */
  async join(jobId: string): Promise<SubagentResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(
        `Background job not found: "${jobId}". ` +
          'Completed and cancelled jobs are evicted from the registry ~5 minutes after ' +
          'they settle. If the jobId looks correct, the job may have already been evicted.',
      );
    }
    const result = await job.terminalSettled;
    // Job.status was set in markTerminal before settle, so it's already the
    // terminal value when we observe it here.
    void emitBackgroundAgent(this.traceWriter, {
      transition: 'joined',
      jobId,
      subagentId: job.subagentId,
      jobStatus: job.status as 'completed' | 'failed' | 'cancelled',
    });
    this.emit('joined', this.snapshot(job));
    return result;
  }

  /**
   * Explicitly cancel a running job. Returns true if cancel was issued,
   * false if the job is already terminal or unknown. Always idempotent.
   *
   * The cancellation goes through `SubagentHandle.cancel()` which fires the
   * existing abort cascade — the terminal-state callback installed in
   * `register()` then transitions status to 'cancelled' and emits the
   * trace event. We do NOT emit `.cancelled` here directly to avoid
   * double-emission on cascade.
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return false;
    job.cancelSource = 'explicit';
    await job.handle.cancel();
    return true;
  }

  /**
   * Cancel every still-running job. Called on parent-session teardown so
   * background work doesn't outlive the surface that spawned it. Resolves
   * once every cancellation has been *issued* and all terminal callbacks
   * have settled, so trace events flush before writer close.
   *
   * Each job's `terminalSettled` is raced against {@link CANCEL_DRAIN_TIMEOUT_MS}
   * to prevent a provider that never yields after abort from hanging session
   * teardown indefinitely. On timeout, a warning is logged naming the jobId
   * and teardown continues.
   */
  async cancelAll(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.status === 'running');
    // Issue all cancellations concurrently, then wait for each job's
    // terminal callback to settle before returning. This guarantees trace
    // events are flushed even if the trace writer closes immediately after.
    for (const j of running) {
      j.cancelSource = 'cascade';
    }
    await Promise.allSettled(running.map((j) => j.handle.cancel()));
    await Promise.allSettled(
      running.map((j) => {
        const timeout = new Promise<void>((resolve) =>
          setTimeout(() => {
            console.warn(
              `[BackgroundAgentRegistry] cancelAll: job ${j.jobId} did not settle within ${CANCEL_DRAIN_TIMEOUT_MS}ms — continuing teardown`,
            );
            resolve();
          }, CANCEL_DRAIN_TIMEOUT_MS).unref(),
        );
        return Promise.race([j.terminalSettled, timeout]);
      }),
    );
  }

  /**
   * Append text to a job's transcriptTail ring buffer. Truncates from the
   * front to keep total length under MAX_TRANSCRIPT_TAIL_BYTES (4096).
   * Silent no-op if jobId is unknown (the job may have been evicted).
   *
   * Write-side caller: the `onProgress` callback installed in `register()`
   * (see above) pipes every `chunk`/`content` OutputEvent here so the
   * BackgroundSummarizer always has a fresh tail to summarise.
   */
  appendTranscript(jobId: string, chunk: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const combined = job.transcriptTail + chunk;
    if (combined.length <= MAX_TRANSCRIPT_TAIL_BYTES) {
      job.transcriptTail = combined;
    } else {
      // Trim from the front, keeping the tail end.
      job.transcriptTail = combined.slice(combined.length - MAX_TRANSCRIPT_TAIL_BYTES);
    }
  }

  /**
   * Return the rolling transcript tail for a job, or undefined if unknown.
   * Used by BackgroundSummarizer.getTranscript.
   */
  getTranscript(jobId: string): string | undefined {
    return this.jobs.get(jobId)?.transcriptTail;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private nextJobId(): string {
    this.counter += 1;
    return `bg-${Date.now().toString(36)}-${this.counter}`;
  }

  /**
   * Terminal-state hook installed in `register()`. Sets final status,
   * stores the result, fires witness events, and settles the join promise.
   * Must run exactly once per job — guarded by the running-status check.
   *
   * After settling, schedules a TTL eviction (~5 min) so terminal entries
   * don't accumulate indefinitely. The timer is `.unref()`-ed so it won't
   * keep the Node process alive.
   *
   * Cancel source attribution reads `job.cancelSource` which is set by
   * `cancelJob()` ('explicit') or `cancelAll()` ('cascade') before calling
   * `handle.cancel()`. Defaults to `'explicit'` when not set.
   *
   * @param writer — persistent JSONL log writer for this job (optional; omitted in legacy paths).
   * @param openMeta — the meta record written at start, used to build the terminal update.
   */
  private markTerminal(
    jobId: string,
    result: SubagentResult,
    writer?: BgJobLogWriter,
    openMeta?: BgJobMeta,
  ): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return;

    job.result = result;
    job.endedAt = Date.now();
    const durationMs = job.endedAt - job.startedAt;
    job.status = this.statusFromResult(result.status);

    // Map SubagentStatus → BackgroundAgentPayload transition + emit.
    if (job.status === 'completed') {
      const rawContent = result.message?.content;
      const content = typeof rawContent === 'string'
        ? rawContent
        : rawContent !== undefined
          ? JSON.stringify(rawContent)
          : '';
      void emitBackgroundAgent(this.traceWriter, {
        transition: 'completed',
        jobId,
        subagentId: job.subagentId,
        durationMs,
        outputBytes: Buffer.byteLength(content, 'utf8'),
      });
      emitRoutingTelemetry({
        event: 'subagent.completed',
        subagent_id: job.subagentId,
        parent_session_id: job.parentSessionId,
        status: result.status,
        duration_ms: durationMs,
        content_chars: content.length,
      });
      this.emit('settled', this.snapshot(job));
    } else if (job.status === 'failed') {
      const err = result.error;
      void emitBackgroundAgent(this.traceWriter, {
        transition: 'failed',
        jobId,
        subagentId: job.subagentId,
        durationMs,
        errorClass: err?.name ?? 'Error',
        errorMessage: err?.message ?? 'unknown',
      });
      emitRoutingTelemetry({
        event: 'subagent.failed',
        subagent_id: job.subagentId,
        parent_session_id: job.parentSessionId,
        status: result.status,
        duration_ms: durationMs,
        error_message: err?.message,
      });
      this.emit('settled', this.snapshot(job));
    } else {
      // 'cancelled' — distinguish explicit operator cancels from cascade aborts
      // so trace readers can correlate with parent-session teardown events.
      // cancelSource is set before handle.cancel() in cancelJob() / cancelAll().
      void emitBackgroundAgent(this.traceWriter, {
        transition: 'cancelled',
        jobId,
        subagentId: job.subagentId,
        source: job.cancelSource ?? 'explicit',
      });
      emitRoutingTelemetry({
        event: 'subagent.failed',
        subagent_id: job.subagentId,
        parent_session_id: job.parentSessionId,
        status: result.status,
        duration_ms: durationMs,
      });
      this.emit('settled', this.snapshot(job));
    }

    job.settle(result);

    // Finalize the persistent log: update meta with terminal status + endedAt,
    // then close the writer. Fire-and-forget — writer errors are logged inside.
    if (writer && openMeta) {
      const finalStatus = job.status;
      const endedAt = job.endedAt;
      void writer.writeMeta({
        ...openMeta,
        status: finalStatus,
        ...(endedAt !== undefined ? { endedAt } : {}),
      }).then(() => writer.close());
    }

    // Schedule TTL eviction. `.unref()` prevents this timer from keeping the
    // Node process alive after the REPL exits normally.
    const timer = setTimeout(() => {
      this.jobs.delete(jobId);
    }, TERMINAL_EVICT_TTL_MS);
    timer.unref();
  }

  // ---------------------------------------------------------------------------
  // 7-day disk eviction sweep
  // ---------------------------------------------------------------------------

  /**
   * Remove bg job directories whose `meta.json` shows `endedAt` older than
   * 7 days. Called once on registry construction after a 5-second delay.
   * Errors per-directory are logged and do not abort the sweep.
   */
  private async _sweepOldJobs(): Promise<void> {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const root = getBgJobsRoot();
    let entries: string[];
    try {
      entries = await fsp.readdir(root);
    } catch {
      return; // root doesn't exist yet — nothing to sweep
    }
    for (const entry of entries) {
      const jobDir = getBgJobDir(entry);
      const metaPath = path.join(jobDir, 'meta.json');
      try {
        // Symlink guard: lstat does not follow symlinks — skip anything that
        // isn't a plain directory so we don't recursively remove symlink targets
        // outside the jobs root.
        const dirStat = await fsp.lstat(jobDir);
        if (!dirStat.isDirectory()) {
          process.stderr.write(`[afk] bg sweep: skipping non-directory entry ${entry}\n`);
          continue;
        }
        const raw = await fsp.readFile(metaPath, 'utf8');
        const meta = JSON.parse(raw) as { endedAt?: number; status?: string };
        // Only evict terminal jobs
        if (meta.status === 'running') continue;
        if (meta.endedAt === undefined) continue;
        if (Date.now() - meta.endedAt < SEVEN_DAYS_MS) continue;
        await fsp.rm(jobDir, { recursive: true, force: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue; // already gone
        process.stderr.write(`[afk] bg sweep: error evicting ${entry}: ${String(e)}\n`);
      }
    }
  }

  private statusFromResult(s: SubagentStatus): BackgroundJobStatus {
    if (s === 'succeeded') return 'completed';
    if (s === 'failed') return 'failed';
    if (s === 'cancelled') return 'cancelled';
    // 'idle' or 'running' shouldn't reach the terminal callback — treat as failed.
    return 'failed';
  }

  /** External-facing snapshot: strips internal fields, preserves observable state. */
  private snapshot(job: InternalJob): BackgroundJob {
    const snap: BackgroundJob = {
      jobId: job.jobId,
      subagentId: job.subagentId,
      label: job.label,
      model: job.model,
      startedAt: job.startedAt,
      status: job.status,
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    };
    return snap;
  }
}
