/**
 * Fetch wrapper for the OpenAI-compatible provider — mirrors the Anthropic
 * analog at `anthropic-direct/tracing-fetch.ts`.
 *
 * The OpenAI SDK accepts a custom `fetch` option; this wrapper intercepts every
 * response to:
 *   1. Wait for an admission permit BEFORE the outbound HTTP call (process-wide
 *      rate-limit bucket; skip for local shims via the `gate` parameter).
 *   2. Read `x-ratelimit-*` response headers and invoke the `onRateLimit`
 *      callback so the bucket stays current after every round-trip.
 *   3. Invoke the optional `onThrottle` callback for any 429/503/529 response,
 *      enabling live-banner updates on throttled calls.
 *
 * All callbacks are fire-and-forget and guarded with try/catch so a throwing
 * observer can never disturb the request path or the SDK's own retry loop.
 *
 * @module agent/providers/openai-compatible/tracing-fetch
 */

import { estimateInputTokens } from '../shared/rate-limit-bucket.js';
import type { ThrottleInfo } from '../anthropic-direct/tracing-fetch.js';

/** HTTP statuses that indicate throttling or transient server overload. */
const THROTTLE_STATUSES = new Set([429, 503, 529]);

/**
 * Admission gate interface. Same shape as the Anthropic gate, so the same
 * `globalRateLimitBucket` singleton satisfies both wires without a wrapper.
 */
export interface OpenAIRateLimitGate {
  acquirePermit(estimatedInputTokens: number, signal?: AbortSignal): Promise<void>;
  freeze(retryAfterMs: number): void;
}

/** Helper: parse `retry-after` (seconds or HTTP-date) to ms, or undefined. */
function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw == null) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.round(n * 1_000);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta >= 0) return delta;
  }
  return undefined;
}

/**
 * Wrap a `fetch` implementation for the OpenAI-compatible provider. Returns
 * the same `typeof fetch` signature the OpenAI SDK expects.
 *
 * Parameters:
 * - `baseFetch`   — the real `fetch` (or a test stub).
 * - `onThrottle`  — fired on 429/503/529 for live-surface updates; optional.
 * - `onRateLimit` — fired on EVERY response for bucket updates; optional.
 * - `gate`        — admission gate (the global bucket); omit for local shims.
 *
 * Returns `baseFetch` unchanged when none of the optional parameters are set.
 */
export function makeOpenAITracingFetch(
  baseFetch: typeof fetch = fetch,
  onThrottle?: (info: ThrottleInfo) => void,
  onRateLimit?: (headers: Headers) => void,
  gate?: OpenAIRateLimitGate,
): typeof fetch {
  if (!onThrottle && !onRateLimit && !gate) return baseFetch;

  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    // ADMISSION GATE: wait for a permit before the outbound request.
    if (gate) {
      const estimated = estimateInputTokens(init);
      const signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      await gate.acquirePermit(estimated, signal);
    }

    const res = await baseFetch(input, init);

    // Per-minute header capture: runs unconditionally so the bucket is updated
    // after every response, not just throttled ones.
    if (onRateLimit) {
      try {
        onRateLimit(res.headers);
      } catch {
        // A broken observer must never disturb the SDK retry loop.
      }
    }

    // Hard-freeze the bucket on 429 so concurrent waiters also back off.
    if (gate && res.status === 429) {
      try {
        const retryMs = parseRetryAfterMs(res.headers);
        gate.freeze(retryMs ?? 5_000);
      } catch {
        // ignore
      }
    }

    // Live throttle signal for the progress banner.
    if (onThrottle && THROTTLE_STATUSES.has(res.status)) {
      try {
        const retryAfterMs = parseRetryAfterMs(res.headers);
        onThrottle({
          status: res.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      } catch {
        // A broken observer must never disturb the SDK retry loop.
      }
    }

    return res;
  };
}
