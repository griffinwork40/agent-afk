/**
 * Observability wrapper for the Anthropic SDK's `fetch` client option.
 *
 * Invariant: the SDK retries transient failures (429 rate limit, 503/529
 * overload) internally, honoring the `retry-after` header — but that backoff is
 * otherwise SILENT: it happens inside a single `messages.create` call, and
 * surfaces only as an abnormally long `model_ttfb` in the trace (a 429 with a
 * 70s `retry-after`, retried twice, looks like a ~140s "stuck" turn with no
 * explanation). This wrapper sits under the SDK and does TWO things on every
 * throttled response, both purely observational:
 *   1. Records it into the witness trace as a `rate_limit` session-phase event,
 *      so `afk trace show` explains the stall after the fact.
 *   2. Invokes the optional {@link makeTracingFetch} `onThrottle` callback so a
 *      live surface (the interactive progress banner) can show the backoff AS
 *      IT HAPPENS. This is the only hook that fires DURING the SDK's blocking
 *      retry loop — the per-turn loop is parked awaiting `messages.create`, so
 *      without this callback the banner cannot update until the wait is over.
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
 * Structured throttle observation handed to the {@link makeTracingFetch}
 * `onThrottle` callback. `retryAfterMs` is the parsed `retry-after` header when
 * present; `status` is the throttled HTTP status.
 */
export interface ThrottleInfo {
  status: number;
  retryAfterMs?: number;
}

/**
 * Wrap a `fetch` implementation so throttled responses (429/503/529) emit a
 * `rate_limit` trace event AND (when provided) invoke `onThrottle` for a live
 * surface. Returns the wrapped fetch; when BOTH `writer` and `onThrottle` are
 * undefined the base fetch is returned unchanged (no overhead).
 *
 * `onThrottle` is fire-and-forget from the caller's perspective — this wrapper
 * guards it with try/catch so a throwing callback can never disturb the request
 * path or the SDK's retry loop.
 */
export function makeTracingFetch(
  writer: TraceWriter | undefined,
  baseFetch: typeof fetch = fetch,
  onThrottle?: (info: ThrottleInfo) => void,
): typeof fetch {
  if (!writer && !onThrottle) return baseFetch;
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const res = await baseFetch(input, init);
    if (THROTTLE_STATUSES.has(res.status)) {
      const retryAfterMs = parseRetryAfterMs({ headers: res.headers });
      // Live signal FIRST so the banner updates with minimal latency; the
      // trace write below is async fire-and-forget. Guarded so a throwing
      // observer can never break the request path.
      if (onThrottle) {
        try {
          onThrottle({
            status: res.status,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          });
        } catch {
          // A broken live observer must never disturb the SDK retry loop.
        }
      }
      if (writer) {
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
    }
    return res;
  };
}
