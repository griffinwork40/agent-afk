/**
 * `markTerminal` implementation for BackgroundAgentRegistry.
 *
 * Split out of `background-registry.ts` (file-size ceiling, #3481).
 * Governs the terminal-state transition for a background job: status mutation,
 * witness/telemetry emit, join-promise settlement, persistent log finalization,
 * TTL eviction scheduling, handle teardown, cleanup callback, and budget release.
 *
 * @module agent/background-registry.mark-terminal
 */

import { debugLog } from '../utils/debug.js';
import { emitBackgroundAgent } from './trace/emit.js';
import { emitBackgroundRoutingTelemetry } from './background-registry.telemetry.js';
import { boundedStopReason } from './tools/subagent/failure-payload.js';
import { persistResultBody } from './background-registry.result.js';
import { appendTranscriptTail } from './background-registry.transcript.js';
import { recordTouchedFile } from './background-registry.touched-files.js';
import type { BgJobLogWriter, BgJobMeta } from './bg-job-log.js';
import type { SubagentResult, SubagentStatus } from './subagent.js';
import type { TraceSink } from './trace/index.js';
import type { BackgroundJobStatus } from './background-registry.types.js';

/** Default TTL for evicting terminal jobs from the registry map. */
const TERMINAL_EVICT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---- Internal job shape (mirrors the InternalJob in background-registry.ts) ----
// Only the fields markTerminal reads/writes are typed here; the rest are
// structural (`Pick`) to avoid duplicating the full interface.
export interface MarkTerminalJob {
  jobId: string;
  subagentId: string;
  status: BackgroundJobStatus;
  startedAt: number;
  endedAt?: number;
  result?: SubagentResult;
  provenance: 'user' | 'model';
  parentSessionId?: string;
  cancelSource?: 'explicit' | 'cascade';
  modelCancelReason?: string;
  transcriptTail: string;
  touchedFiles: string[];
  handle: { teardown(): Promise<void>; cancel(): Promise<void> };
  settle: (r: SubagentResult) => void;
  onCleanup?: () => Promise<void>;
  onSettled?: () => void;
}

export function statusFromResult(s: SubagentStatus): BackgroundJobStatus {
  if (s === 'succeeded') return 'completed';
  if (s === 'failed') return 'failed';
  if (s === 'cancelled') return 'cancelled';
  // 'idle' or 'running' shouldn't reach the terminal callback — treat as failed.
  return 'failed';
}

export function appendTranscript(job: MarkTerminalJob, chunk: string): void {
  job.transcriptTail = appendTranscriptTail(job.transcriptTail, chunk);
}

export function recordTouched(job: MarkTerminalJob, rawInput: unknown): void {
  recordTouchedFile(job.touchedFiles, typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput));
}

/**
 * Terminal-state hook. Sets final status, stores the result, fires witness
 * events, settles the join promise, and finally tears the handle down so
 * `SubagentStop` fires. Must run exactly once per job — guarded by the
 * running-status check. See the full Invariant block in background-registry.ts.
 *
 * @param job       The live InternalJob entry (mutated in place).
 * @param result    Terminal SubagentResult from runInBackground/adoptRunning.
 * @param emit      Callback to the registry's EventEmitter `emit('settled', …)`.
 * @param snapshot  Callback to produce the public BackgroundJob snapshot.
 * @param evict     Callback to delete the job from the registry map after TTL.
 * @param traceWriter Witness-layer writer (may be undefined).
 * @param writer    Per-job persistent log writer (optional).
 * @param openMeta  The meta record written at start (optional).
 */
export async function markTerminalImpl(
  job: MarkTerminalJob,
  result: SubagentResult,
  emit: (job: MarkTerminalJob) => void,
  evict: (jobId: string) => void,
  traceWriter: TraceSink | undefined,
  writer?: BgJobLogWriter,
  openMeta?: BgJobMeta,
): Promise<void> {
  if (job.status !== 'running') return;

  job.result = result;
  job.endedAt = Date.now();
  const durationMs = job.endedAt - job.startedAt;
  job.status = statusFromResult(result.status);

  // Map SubagentStatus → BackgroundAgentPayload transition + emit.
  if (job.status === 'completed') {
    const rawContent = result.message?.content;
    // Invariant: `content` here is the RAW message content, measured BEFORE
    // any `annotateIfIncomplete` / provenance-header pass runs. This method
    // is an observation site only — it never mutates `result` — so
    // `content_chars` always reflects the subagent's actual output size.
    const content = typeof rawContent === 'string'
      ? rawContent
      : rawContent !== undefined
        ? JSON.stringify(rawContent)
        : '';
    void emitBackgroundAgent(traceWriter, {
      transition: 'completed',
      jobId: job.jobId,
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
    emit(job);
  } else if (job.status === 'failed') {
    const err = result.error;
    void emitBackgroundAgent(traceWriter, {
      transition: 'failed',
      jobId: job.jobId,
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
    emit(job);
  } else {
    // 'cancelled' — distinguish explicit operator cancels from cascade aborts.
    void emitBackgroundAgent(traceWriter, {
      transition: 'cancelled',
      jobId: job.jobId,
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
    emit(job);
  }

  job.settle(result);

  // Finalize the persistent log: update meta with terminal status + endedAt,
  // persist the result body, then close the writer. Fire-and-forget.
  if (writer && openMeta) {
    persistResultBody(writer, job.jobId, job.status, result);
    void writer.writeMeta({
      ...openMeta,
      status: job.status,
      ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
      ...(boundedStopReason(result.stopReason) !== undefined
        ? { stopReason: boundedStopReason(result.stopReason) }
        : {}),
    }).then(() => writer.close());
  }

  // Schedule TTL eviction. `.unref()` prevents this timer from keeping the
  // Node process alive after the REPL exits normally.
  const timer = setTimeout(() => {
    evict(job.jobId);
  }, TERMINAL_EVICT_TTL_MS);
  timer.unref();

  // Tear the handle down so a naturally-completing background job fires
  // `SubagentStop` — the same lifecycle guarantee foreground jobs get from
  // `SubagentExecutor`'s finally block. MUST be the last step (synchronous-
  // observability invariant): all state a caller observes synchronously is
  // already committed by the time we suspend here.
  try {
    await job.handle.teardown();
  } catch (err) {
    debugLog(
      `markTerminal: handle.teardown() failed for job ${job.jobId}: ${String(err)}`,
    );
  }

  // Post-terminal cleanup (e.g. isolation:"worktree" unlock + teardown).
  // Fires on ALL terminal states. Best-effort.
  if (job.onCleanup) {
    try {
      await job.onCleanup();
    } catch (err) {
      debugLog(`markTerminal: onCleanup failed for job ${job.jobId}: ${String(err)}`);
    }
  }

  // Item 4: release delegation-budget slot for promoted foreground subagents.
  if (job.onSettled) {
    try {
      job.onSettled();
    } catch (err) {
      debugLog(`markTerminal: onSettled failed for job ${job.jobId}: ${String(err)}`);
    }
  }
}
