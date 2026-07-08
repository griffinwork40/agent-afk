/**
 * Observability wrapper for the Anthropic SDK's `fetch` client option.
 *
 * The SDK retries transient failures (429 rate limit, 503/529 overload)
 * internally, honoring the `retry-after` header — but that backoff is
 * completely SILENT: it happens inside a single `messages.create` call, emits
 * no event, and surfaces only as an abnormally long `model_ttfb` in the trace
 * (a 429 with a 70s `retry-after`, retried twice, looks like a ~140s "stuck"
 * turn with no explanation). This wrapper sits under the SDK and records every
 * throttled response into the witness trace as a `rate_limit` session-phase
 * event, so `afk trace show` explains the stall instead of hiding it.
 *
 * Purely observational: it forwards the request unchanged and returns the
 * Response untouched (only `res.headers` is read, which does not consume the
 * body), so retry behavior is exactly as before.
 *
 * @module agent/providers/anthropic-direct/tracing-fetch
 */

import type { TraceWriter } from '../../trace/index.js';
import { emitSessionPhase } from '../../trace/emit.js';
import { parseRetryAfterMs } from './usage-limit.js';

/** HTTP statuses that indicate throttling / transient overload. */
const THROTTLE_STATUSES = new Set([429, 503, 529]);

/**
 * Wrap a `fetch` implementation so throttled responses (429/503/529) emit a
 * `rate_limit` trace event. Returns the wrapped fetch; when `writer` is
 * undefined the base fetch is returned unchanged (no overhead).
 */
export function makeTracingFetch(
  writer: TraceWriter | undefined,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  if (!writer) return baseFetch;
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const res = await baseFetch(input, init);
    if (THROTTLE_STATUSES.has(res.status)) {
      const retryAfterMs = parseRetryAfterMs({ headers: res.headers });
      const metadata: Record<string, string | number | boolean> = {
        status: res.status,
        reason: res.status === 429 ? 'rate-limit' : 'overloaded',
        source: 'sdk-fetch',
      };
      if (retryAfterMs !== undefined) metadata['retryAfterMs'] = retryAfterMs;
      // Fire-and-forget: a broken trace writer must never disturb the request
      // path. emitSessionPhase already swallows writer errors internally.
      void emitSessionPhase(writer, {
        phase: 'rate_limit',
        ...(retryAfterMs !== undefined ? { durationMs: retryAfterMs } : {}),
        metadata,
      });
    }
    return res;
  };
}
