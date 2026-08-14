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
 * Admission gate: when a {@link RateLimitGate} is provided, the wrapper calls
 * `gate.acquirePermit` BEFORE forwarding the request. This gates outbound HTTP
 * without touching the dispatch layer — no deadlock risk (the waiter holds no
 * concurrency-pool slot; it is waiting for TIME, not for another coroutine to
 * release a resource). See `rate-limit-bucket.ts` for the proof.
 *
 * Purely observational after the gate: it forwards the request unchanged and
 * returns the Response untouched (only `res.headers` is read, which does not
 * consume the body), so retry behavior is exactly as before.
 *
 * @module agent/providers/anthropic-direct/tracing-fetch
 */

import type { TraceSink } from '../../trace/index.js';
import { emitSessionPhase } from '../../trace/emit.js';
import { parseRetryAfterMs } from './usage-limit.js';
import { estimateInputTokens } from '../shared/rate-limit-bucket.js';

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
 * Admission gate interface. The fetch wrapper calls `acquirePermit` before
 * every outbound request and `freeze` when a 429 arrives.
 */
export interface RateLimitGate {
  acquirePermit(estimatedInputTokens: number, signal?: AbortSignal): Promise<void>;
  freeze(retryAfterMs: number): void;
}

/**
 * Wrap a `fetch` implementation so throttled responses (429/503/529) emit a
 * `rate_limit` trace event AND (when provided) invoke `onThrottle` for a live
 * surface. When a `gate` is provided, each request waits for a permit before
 * making the outbound call. Returns the wrapped fetch; when `writer`,
 * `onThrottle`, `onQuota`, `onRateLimit`, AND `gate` are all undefined the base
 * fetch is returned unchanged (no overhead).
 *
 * `onThrottle`, `onQuota`, and `onRateLimit` are fire-and-forget from the
 * caller's perspective — this wrapper guards all three with try/catch so a
 * throwing callback can never disturb the request path or the SDK's retry loop.
 */
export function makeTracingFetch(
  writer: TraceSink | undefined,
  baseFetch: typeof fetch = fetch,
  onThrottle?: (info: ThrottleInfo) => void,
  onQuota?: (headers: Headers) => void,
  onRateLimit?: (headers: Headers) => void,
  gate?: RateLimitGate,
): typeof fetch {
  if (!writer && !onThrottle && !onQuota && !onRateLimit && !gate) return baseFetch;
  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    // ADMISSION GATE: wait for a permit before making the outbound call.
    // This is called BEFORE baseFetch so the request waits in the wrapper, not
    // after committing to an HTTP round-trip that will 429 immediately.
    if (gate) {
      const estimated = estimateInputTokens(init);
      const signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      await gate.acquirePermit(estimated, signal);
    }

    const res = await baseFetch(input, init);

    // Per-minute rate-limit header capture: fires unconditionally on every
    // response (not just throttled ones) so the bucket stays current. Guarded
    // with try/catch — a broken observer must never disturb the request path.
    if (onRateLimit) {
      try {
        onRateLimit(res.headers);
      } catch {
        // A broken observer must never disturb the SDK retry loop.
      }
    }

    // Hard-freeze on 429 so concurrent waiters in acquirePermit also back off.
    if (gate && res.status === 429) {
      try {
        const retryMs = parseRetryAfterMs({ headers: res.headers });
        gate.freeze(retryMs ?? 5_000);
      } catch {
        // ignore
      }
    }

    // Passive quota capture: Anthropic returns `anthropic-ratelimit-unified-*`
    // headers on EVERY response under OAuth auth, not just throttled ones, so
    // this runs unconditionally (before the throttle-status gate below) and
    // is guarded exactly like `onThrottle` — a throwing observer must never
    // disturb the request path or the SDK's retry loop.
    if (onQuota) {
      try {
        onQuota(res.headers);
      } catch {
        // A broken live observer must never disturb the SDK retry loop.
      }
    }
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
