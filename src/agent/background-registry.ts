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
 * **Delivery is the surface's job.** The registry never pushes results
 * into the parent session's conversation itself — it only emits the
 * `settled` event. The interactive REPL wires a `BgResultNotifier`
 * (src/cli/commands/interactive/bg-result-notifier.ts) onto that event to
 * auto-deliver results into the next user turn; surfaces without a
 * notifier fall back to explicit `join()`.
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
import { createHash } from 'node:crypto';
import type { SubagentHandle, SubagentResult, SubagentStatus } from './subagent.js';
import { buildResultFromError, createEmptyTrace } from './subagent/result.js';
import { debugLog } from '../utils/debug.js';
import { emitBackgroundAgent } from './trace/emit.js';
import type { TraceSink } from './trace/index.js';
import { BgJobLogWriter } from './bg-job-log.js';
import type { BgJobMeta } from './bg-job-log.js';
import { emitBackgroundRoutingTelemetry } from './background-registry.telemetry.js';
import { boundedStopReason } from './tools/subagent/failure-payload.js';
import { sweepOldBgJobs } from './background-registry.sweep.js';
import { BackgroundJobCapError, resolveBackgroundJobCap } from './background-registry.cap.js';
import { appendTranscriptTail } from './background-registry.transcript.js';
import type { BackgroundJob, BackgroundJobProvenance, BackgroundJobStatus } from './background-registry.types.js';

export { BackgroundJobCapError } from './background-registry.cap.js';
export { MAX_TRANSCRIPT_TAIL_BYTES } from './background-registry.transcript.js';
export type { BackgroundJob, BackgroundJobProvenance, BackgroundJobStatus } from './background-registry.types.js';

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
  /** Model cancellation metadata. Adjacent to cancelSource for trace-reader compatibility. */
  modelCancelReason?: string;
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
  /** Post-terminal cleanup callback, forwarded from RegisterArgs. */
  onCleanup?: () => Promise<void>;
}

/** Default TTL for evicting terminal jobs from the registry map. */
const TERMINAL_EVICT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Maximum time to wait for a single job's terminal callback to settle
 * during `cancelAll()`. A provider that doesn't yield after abort could
 * otherwise hang session teardown indefinitely. On timeout, the job is
 * treated as settled (teardown proceeds) and a warning is logged.
 */
const CANCEL_DRAIN_TIMEOUT_MS = 5000; // 5 seconds

export interface BackgroundRegistryOptions {
  /** Optional trace writer. Witness events become no-ops when undefined. */
  traceWriter?: TraceSink | undefined;
  /**
   * Maximum number of concurrently *running* background jobs.
   * `register()` throws `BackgroundJobCapError` when this limit is reached.
   * Defaults to AFK_MAX_CONCURRENT_BACKGROUND_JOBS, or 10 when unset/invalid.
   */
  maxConcurrentJobs?: number;
}

export interface RegisterArgs {
  handle: SubagentHandle;
  prompt: string;
  model: string;
  /** Creator of this job. Defaults to user so ambiguous callers fail safe. */
  provenance?: BackgroundJobProvenance;
  /**
   * Optional parent session id. Forwarded to routing-telemetry events
   * (`subagent.completed` / `subagent.failed`) and persisted to the bg-job
   * meta record for log correlation.
   */
  parentSessionId?: string | undefined;
  /**
   * Optional post-terminal cleanup callback. Called in markTerminal() after
   * handle.teardown() finishes. Best-effort — errors are logged, never thrown.
   * Used by isolation:"worktree" to unlock + tear down the child's worktree.
   */
  onCleanup?: () => Promise<void>;
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
  // Not readonly: a REPL `/resume` hands this long-lived registry a fresh
  // writer via `setTraceWriter`, because the outgoing session sealed the one
  // captured at construction (#731).
  private traceWriter: TraceSink | undefined;
  private readonly maxConcurrentJobs: number;

  constructor(options: BackgroundRegistryOptions = {}) {
    super();
    this.traceWriter = options.traceWriter;
    this.maxConcurrentJobs = resolveBackgroundJobCap(options.maxConcurrentJobs);

    // 7-day eviction sweep: fire after 5 seconds so it doesn't block startup.
    // `.unref()` prevents the timer from keeping the Node process alive.
    const sweepTimer = setTimeout(
      () => sweepOldBgJobs().catch((e: unknown) =>
        process.stderr.write(`[afk] bg sweep error: ${String(e)}\n`),
      ),
      5000,
    );
    sweepTimer.unref();
  }

  /**
   * Re-point the writer this registry emits background-job lifecycle events
   * into.
   *
   * Contract: called (via the bootstrap cascade) on a REPL `/resume`, where
   * the outgoing session sealed the writer captured at construction. Jobs
   * already in flight keep emitting into whatever writer they hold; only
   * events emitted by the registry after this call use `writer` (#731).
   */
  setTraceWriter(writer: TraceSink | undefined): void {
    this.traceWriter = writer;
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
    //
    // `markTerminal` is async (it awaits `handle.teardown()` to fire
    // SubagentStop) but the callback is synchronous — `void` + `.catch` mirrors
    // `runInBackground`'s own naked-void-promise guard so a teardown rejection
    // never escapes as an unhandled rejection on this detached path.
    args.handle.runInBackground(
      args.prompt,
      (result) => {
        void this.markTerminal(jobId, result, writer, metaRecord).catch(
          (err: unknown) =>
            debugLog(`markTerminal (register) rejected for ${jobId}: ${String(err)}`),
        );
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
    // `markTerminal` is async (awaits `handle.teardown()` for SubagentStop);
    // await it inside both branches so a teardown rejection surfaces to the
    // trailing `.catch` rather than leaking as an unhandled rejection. The
    // promotion path's handle already ran to completion, so teardown here fires
    // SubagentStop exactly as the native-background path does.
    void args.runPromise
      .then((result) => this.markTerminal(jobId, result, writer, metaRecord))
      .catch((err: unknown) => {
        debugLog('adoptRunning: unexpected rejection from in-flight runPromise', err);
        return this.markTerminal(
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
      provenance: args.provenance ?? 'user',
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
      onCleanup: args.onCleanup,
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
   * Record that a terminal job's result was auto-delivered into the parent
   * conversation by a surface-level notifier (BgResultNotifier). Emits a
   * `background_agent.delivered` witness event so trace readers can
   * distinguish auto-delivery from explicit `joined` events. No-op for
   * unknown (evicted) or still-running jobs. Does not consume the job —
   * it remains `join()`-able until TTL eviction.
   */
  markDelivered(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'running') return;
    void emitBackgroundAgent(this.traceWriter, {
      transition: 'delivered',
      jobId,
      subagentId: job.subagentId,
      jobStatus: job.status as 'completed' | 'failed' | 'cancelled',
    });
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

  /** Cancel a running model-owned job and attribute its required reason in witness. */
  async cancelModelJob(jobId: string, reason: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running' || job.provenance !== 'model') return false;
    job.cancelSource = 'explicit';
    job.modelCancelReason = reason;
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
    job.transcriptTail = appendTranscriptTail(job.transcriptTail, chunk);
  }

  /**
   * Return the rolling transcript tail for a job, or undefined if unknown.
   * Used by BackgroundSummarizer.getTranscript.
   */
  getTranscript(jobId: string): string | undefined {
    return this.jobs.get(jobId)?.transcriptTail;
  }

  /**
   * Return the live SubagentHandle for a job, or undefined if unknown.
   * Used by the send_message_to_agent tool executor to call handle.steer().
   */
  getHandle(jobId: string): SubagentHandle | undefined {
    return this.jobs.get(jobId)?.handle;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private nextJobId(): string {
    this.counter += 1;
    return `bg-${Date.now().toString(36)}-${this.counter}`;
  }

  /**
   * Terminal-state hook installed in `register()` / `adoptRunning()`. Sets
   * final status, stores the result, fires witness events, settles the join
   * promise, and finally tears the handle down so `SubagentStop` fires. Must
   * run exactly once per job — guarded by the running-status check.
   *
   * After settling, schedules a TTL eviction (~5 min) so terminal entries
   * don't accumulate indefinitely. The timer is `.unref()`-ed so it won't
   * keep the Node process alive.
   *
   * Cancel source attribution reads `job.cancelSource` which is set by
   * `cancelJob()` ('explicit') or `cancelAll()` ('cascade') before calling
   * `handle.cancel()`. Defaults to `'explicit'` when not set.
   *
   * Invariant: the ordered sequence below is governed by two external
   * constraints and MUST NOT be reordered:
   *   1. Synchronous observability. `register()`'s `onResult` callback (and
   *      `adoptRunning()`'s `.then`) invoke this method but do not await it.
   *      Callers (and every synchronous unit test) observe terminal state
   *      immediately after firing the callback, so all state that must be
   *      visible synchronously — status mutation, witness/telemetry emit,
   *      `job.settle(result)`, log finalize, eviction scheduling — happens
   *      BEFORE the first `await`. JS runs an async function synchronously up
   *      to its first suspension point; placing `await handle.teardown()`
   *      last preserves that guarantee.
   *   2. Fire-SubagentStop-once. `teardown()` fires `SubagentStop` via the
   *      handle's `stopDispatched` guard. On the cancel path
   *      (`cancelJob`/`cancelAll` → `handle.cancel()`), the handle already
   *      dispatched `SubagentStop` and set `stopDispatched` BEFORE synthesizing
   *      the cancelled result that re-enters this method — so the trailing
   *      `teardown()` is a guaranteed no-op there. Only natural completion
   *      (where `run()`/`runToResult()` called `onTerminal()` but never the
   *      stop path) reaches `teardown()` with `stopDispatched === false`, so
   *      the hook fires exactly once for both natural and cancelled endings.
   *
   * @param writer — persistent JSONL log writer for this job (optional; omitted in legacy paths).
   * @param openMeta — the meta record written at start, used to build the terminal update.
   */
  private async markTerminal(
    jobId: string,
    result: SubagentResult,
    writer?: BgJobLogWriter,
    openMeta?: BgJobMeta,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running') return;

    job.result = result;
    job.endedAt = Date.now();
    const durationMs = job.endedAt - job.startedAt;
    job.status = this.statusFromResult(result.status);

    // Map SubagentStatus → BackgroundAgentPayload transition + emit.
    if (job.status === 'completed') {
      const rawContent = result.message?.content;
      // Invariant: `content` here is the RAW message content, measured BEFORE
      // any `annotateIfIncomplete` / provenance-header pass runs. This method
      // is an observation site only (see class-level note on markTerminal) —
      // it never mutates `result` — so `content_chars` always reflects the
      // subagent's actual output size, never the parent-visible banner text
      // a delivery consumer (bg-result-notifier.ts, bgsub.ts) may prepend.
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
      emitBackgroundRoutingTelemetry({
        event: 'subagent.completed',
        subagent_id: job.subagentId,
        parent_session_id: job.parentSessionId,
        status: result.status,
        duration_ms: durationMs,
        content_chars: content.length,
        stop_reason: boundedStopReason(result.stopReason),
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
      emitBackgroundRoutingTelemetry({
        event: 'subagent.failed',
        subagent_id: job.subagentId,
        parent_session_id: job.parentSessionId,
        status: result.status,
        duration_ms: durationMs,
        error_message: err?.message,
        stop_reason: boundedStopReason(result.stopReason),
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
        ...(job.modelCancelReason !== undefined
          ? { cancelledBy: 'model' as const, reason: job.modelCancelReason }
          : {}),
      });
      emitBackgroundRoutingTelemetry({
        event: 'subagent.failed',
        subagent_id: job.subagentId,
        parent_session_id: job.parentSessionId,
        status: result.status,
        duration_ms: durationMs,
        stop_reason: boundedStopReason(result.stopReason),
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
        // Persist stopReason so the /bgsub:join disk-fallback path (reached
        // after this job's in-memory entry is TTL-evicted) can reconstruct
        // the same partial-result labeling the in-memory replay applies —
        // see BgJobMeta.stopReason. Omitted (not undefined/null) when absent.
        // Bounded via the shared chokepoint (see failure-payload.ts) — this
        // was the one write site (of six) that persisted the raw,
        // provider-controlled value uncapped (#717).
        ...(boundedStopReason(result.stopReason) !== undefined
          ? { stopReason: boundedStopReason(result.stopReason) }
          : {}),
      }).then(() => writer.close());
    }

    // Schedule TTL eviction. `.unref()` prevents this timer from keeping the
    // Node process alive after the REPL exits normally.
    const timer = setTimeout(() => {
      this.jobs.delete(jobId);
    }, TERMINAL_EVICT_TTL_MS);
    timer.unref();

    // Tear the handle down so a naturally-completing background job fires
    // `SubagentStop` — the same lifecycle guarantee foreground jobs get from
    // `SubagentExecutor`'s finally block. This MUST be the last step (see the
    // synchronous-observability invariant above): all state a caller observes
    // synchronously is already committed by the time we suspend here.
    //
    // injectContext for background: `teardown()` routes any `injectContext` a
    // SubagentStop handler returns through the handle's default channel —
    // `queueFrameworkContext` on a live `parentInputStreamRef` (so it rides the
    // parent's next real user message), else a no-op. A background job has no
    // waiting tool_result to carry the note in-turn, so this default-queue path
    // is the only correct delivery; if the parent already detached (no live
    // ref), the note is silently dropped. That trade-off is intentional:
    // firing the hook + sealing the trace is the primary goal here; inject
    // delivery is best-effort and secondary for detached background work.
    //
    // Idempotent with the cancel path: on `cancelJob`/`cancelAll` the handle
    // already fired `SubagentStop` (and set `stopDispatched`) before the
    // cancelled result re-entered this method, so this call is a no-op there.
    // Errors are swallowed — teardown is a cleanup step and must never turn a
    // settled job into an unhandled rejection on the detached callback path.
    try {
      await job.handle.teardown();
    } catch (err) {
      debugLog(
        `markTerminal: handle.teardown() failed for job ${jobId}: ${String(err)}`,
      );
    }

    // Post-terminal cleanup (e.g. isolation:"worktree" unlock + teardown).
    // Fires on ALL terminal states: completion, failure, and cancellation.
    // Placed after handle.teardown() so hooks can inspect state. Best-effort.
    if (job.onCleanup) {
      try {
        await job.onCleanup();
      } catch (err) {
        debugLog(`markTerminal: onCleanup failed for job ${jobId}: ${String(err)}`);
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
      provenance: job.provenance,
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
