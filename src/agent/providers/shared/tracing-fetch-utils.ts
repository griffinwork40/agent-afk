/**
 * Shared constants and interfaces used by both the Anthropic-direct and
 * OpenAI-compatible tracing-fetch wrappers.
 *
 * Extracted from their respective provider modules so neither provider has to
 * cross-import the other:
 *   - `THROTTLE_STATUSES`  — HTTP statuses indicating throttling / overload.
 *   - `ThrottleInfo`       — structured throttle observation for `onThrottle`.
 *   - `RateLimitGate`      — admission gate interface satisfied by the shared
 *                             `globalRateLimitBucket` singleton.
 *
 * @module agent/providers/shared/tracing-fetch-utils
 */

/** HTTP statuses that indicate throttling or transient server overload. */
export const THROTTLE_STATUSES = new Set([429, 503, 529]);

/**
 * Structured throttle observation handed to the `onThrottle` callback.
 * `retryAfterMs` is the parsed `retry-after` (or `retry-after-ms`) header
 * when present; `status` is the throttled HTTP status code.
 */
export interface ThrottleInfo {
  status: number;
  retryAfterMs?: number;
}

/**
 * Admission gate interface. Implementations call `acquirePermit` before every
 * outbound request and `freeze` when a 429 arrives to back off concurrent
 * waiters. Satisfied structurally by the shared `globalRateLimitBucket`.
 */
export interface RateLimitGate {
  acquirePermit(estimatedInputTokens: number, signal?: AbortSignal): Promise<void>;
  freeze(retryAfterMs: number): void;
}
