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
 * Delegates the shared gate/throttle/freeze state machine to
 * {@link makeBaseTracingFetch} from `providers/shared/tracing-fetch.ts`.
 * The OpenAI provider has no extra provider-specific arms (no `onQuota`, no
 * witness-trace emit), so the shared base is the complete implementation and
 * this module is a thin named re-export with OpenAI-flavoured docs.
 *
 * @module agent/providers/openai-compatible/tracing-fetch
 */

import { makeBaseTracingFetch } from '../shared/tracing-fetch.js';
import type { ThrottleInfo, RateLimitGate } from '../shared/tracing-fetch-utils.js';
import { h1ModelFetch } from '../shared/h1-fetch.js';

/**
 * Admission gate interface. Same shape as the shared `RateLimitGate`, so the
 * same `globalRateLimitBucket` singleton satisfies both wires without a
 * wrapper. Re-exported as `OpenAIRateLimitGate` for backward compatibility with
 * any external code that imported this name.
 */
export type { RateLimitGate as OpenAIRateLimitGate } from '../shared/tracing-fetch-utils.js';

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
  baseFetch: typeof fetch = h1ModelFetch,
  onThrottle?: (info: ThrottleInfo) => void,
  onRateLimit?: (headers: Headers) => void,
  gate?: RateLimitGate,
): typeof fetch {
  return makeBaseTracingFetch({ baseFetch, onThrottle, onRateLimit, gate });
}
