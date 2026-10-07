/**
 * Witness-trace adapter for {@link withTransientRetry}'s `onRetry` and
 * `onExhausted` callbacks.
 *
 * Emits the same `connection_retry` session_phase shape the streaming turn
 * path uses (`anthropic-direct/loop/round-request.ts` traceConnectionRetry):
 * `durationMs` = the planned backoff delay, not elapsed wall-clock time.
 * `metadata.error` = message head (≤200 chars), plus `attempt`, `maxRetries`,
 * and `code`/`status` when present.
 * `metadata.source` names the caller (e.g. 'compaction') so one-shot retries
 * are distinguishable from turn-loop retries in the trace.
 *
 * {@link traceExhaustedRetry} emits a `connection_retry_exhausted`
 * session_phase event when all retry attempts are spent, giving trace
 * consumers a single terminal event to detect final outcomes without counting
 * `connection_retry` events.
 *
 * @module agent/providers/shared/transient-retry.trace
 */

import { emitSessionPhase } from '../../trace/emit.js';
import { redactSecrets } from '../../redact-secrets.js';
import type { TraceSink } from '../../trace/index.js';
import type { RetryInfo } from './transient-retry.js';

/** Build a fire-and-forget `onRetry` that records each retry in the witness trace. */
export function traceTransientRetry(
  traceWriter: TraceSink | undefined,
  source: string,
  maxRetries: number,
): (info: RetryInfo) => void {
  return (info) => {
    const message = info.error instanceof Error ? info.error.message : String(info.error);
    void emitSessionPhase(traceWriter, {
      phase: 'connection_retry',
      // Contract: durationMs is the PLANNED backoff delay (set before the
      // sleep begins). Aborted sleeps therefore report the full planned delay,
      // not elapsed wall-clock time. Emit occurs before the wait, so this is
      // the only value available without adding a post-sleep callback.
      durationMs: info.delayMs,
      metadata: {
        source,
        attempt: info.attempt,
        maxRetries,
        error: redactSecrets(message).slice(0, 200),
        ...(info.code !== undefined ? { code: info.code } : {}),
        ...(info.status !== undefined ? { status: info.status } : {}),
      },
    });
  };
}

/**
 * Build a fire-and-forget `onExhausted` that records retry exhaustion in the
 * witness trace as a `connection_retry_exhausted` session_phase event.
 *
 * This gives trace consumers a single terminal event marking that all retry
 * attempts were spent, without having to count `connection_retry` events.
 * `durationMs` is 0 — no further backoff wait occurs after exhaustion.
 */
export function traceExhaustedRetry(
  traceWriter: TraceSink | undefined,
  source: string,
  maxRetries: number,
): (info: RetryInfo) => void {
  return (info) => {
    const message = info.error instanceof Error ? info.error.message : String(info.error);
    void emitSessionPhase(traceWriter, {
      phase: 'connection_retry_exhausted',
      durationMs: 0,
      metadata: {
        source,
        attempt: info.attempt,
        maxRetries,
        error: redactSecrets(message).slice(0, 200),
        ...(info.code !== undefined ? { code: info.code } : {}),
        ...(info.status !== undefined ? { status: info.status } : {}),
      },
    });
  };
}
