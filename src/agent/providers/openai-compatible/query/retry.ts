/**
 * Connection-phase + mid-stream retry helpers for the openai-compatible
 * provider's turn loop.
 *
 * Mirrors the Anthropic provider's connection-phase + mid-stream retry pattern
 * (see `anthropic-direct/loop.ts:createWithRetry` and the overload-retry block
 * in `runTurn`). The Anthropic `RetryLayer` class is too coupled to OAuth /
 * keychain hot-swap to share; the core retry pattern (bounded exponential
 * backoff on retryable HTTP status codes) is simple enough to implement here
 * directly. See issue #126.
 *
 * Extracted from `query.ts` so the query module carries only the session class
 * and its turn loop; the retryability predicates + backoff schedule live here.
 *
 * @module agent/providers/openai-compatible/query/retry
 */

/**
 * HTTP status codes that warrant a retry with backoff. 429 (rate limit) and
 * 5xx server errors are transient by nature — the same request sent again
 * after a short wait is likely to succeed. 400/401/403/404 are deterministic
 * client errors and must NOT be retried (they would just burn quota).
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 529]);

/** Max connection-phase retries per iteration (matches Anthropic's budget). */
export const MAX_CONNECTION_RETRIES = 3;

/** Max mid-stream retries per iteration (matches Anthropic's OVERLOAD_MAX_RETRIES). */
export const MAX_STREAM_RETRIES = 3;

/** Base delay for exponential backoff: 2s → 4s → 8s (shorter than Anthropic's 5s because OpenAI-compatible shims are often local). */
let retryBaseDelayMs = 2_000;

/**
 * Test injection hook for retry base delay. Set to 0 in tests to avoid real
 * waits. Pass `null` to restore the production default (2000ms).
 */
export function __setRetryBaseDelay(ms: number | null): void {
  retryBaseDelayMs = ms ?? 2_000;
}

/**
 * Exponential backoff delay for a zero-based attempt index: `base * 2^attempt`.
 * `base` honours the {@link __setRetryBaseDelay} test hook. Encapsulates the
 * mutable base-delay state so callers never read a module global directly.
 */
export function computeBackoffDelay(attempt: number): number {
  return retryBaseDelayMs * Math.pow(2, attempt);
}

/**
 * Extract an HTTP status code from an error thrown by the OpenAI SDK (or a
 * compatible shim). The SDK throws `APIError` instances with a `status` field;
 * network errors and generic throws have no status and are treated as
 * retryable (transient network blip) only when they carry no explicit code.
 */
function getErrorStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown };
  return typeof e.status === 'number' ? e.status : undefined;
}

/**
 * Connection-phase retryability: the HTTP call itself failed before any
 * streaming began. Only retry on known transient status codes — errors with
 * no status (network drops, DNS failures, wrong baseURL) are deterministic
 * and must surface immediately to avoid wasting time on misconfigurations.
 * Mirrors the Anthropic provider's `isTransientServerError` which also
 * requires an explicit status.
 */
export function isRetryableConnectionError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === undefined) return false;
  return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Mid-stream retryability: the stream was established but the server sent an
 * error event mid-flight. OpenAI-compatible APIs surface this as an `APIError`
 * thrown from the async iterator. Same status-code set as connection-phase —
 * only retry on explicit transient codes, not on status-less errors.
 */
export function isRetryableStreamError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === undefined) return false;
  return RETRYABLE_STATUS_CODES.has(status);
}
