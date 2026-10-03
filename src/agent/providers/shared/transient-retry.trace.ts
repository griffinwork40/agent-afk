/**
 * Witness-trace adapter for {@link withTransientRetry}'s `onRetry` callback.
 *
 * Emits the same `connection_retry` session_phase shape the streaming turn
 * path uses (`anthropic-direct/loop/round-request.ts` traceConnectionRetry):
 * `durationMs` = the backoff wait, `metadata.error` = message head (≤200
 * chars), plus `attempt`, `maxRetries`, and `code`/`status` when present.
 * `metadata.source` names the caller (e.g. 'compaction') so one-shot retries
 * are distinguishable from turn-loop retries in the trace.
 *
 * @module agent/providers/shared/transient-retry.trace
 */

import { emitSessionPhase } from '../../trace/emit.js';
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
      durationMs: info.delayMs,
      metadata: {
        source,
        attempt: info.attempt,
        maxRetries,
        error: message.slice(0, 200),
        ...(info.code !== undefined ? { code: info.code } : {}),
        ...(info.status !== undefined ? { status: info.status } : {}),
      },
    });
  };
}
