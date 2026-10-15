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
 * **Server backoff hints.** When a retryable error carries a `retry-after`
 * (or OpenAI's `retry-after-ms`) header, {@link retryAfterDelayMs} honors it —
 * clamped to {@link RETRY_AFTER_MAX_WAIT_MS} — in preference to the blind
 * exponential schedule, so a 429 from a rate-limited endpoint (local shim,
 * OpenRouter, DeepSeek, Together, …) waits the server-advised interval instead
 * of guessing. Mirrors the Anthropic provider's transient-429 handling
 * (`retry-layer.ts` `rate-limit-transient`), which likewise honors `retry-after`
 * with a 120s cap.
 *
 * **Why no `paused`/`resumed` here.** This module owns only SHORT transient
 * retries. Long waits live one tier up in `usage-limit-tier.ts`, which parks
 * with `paused`/`resumed` on a long `retry-after` 429 or on the ChatGPT/Codex
 * subscription backend's `usage_limit_reached` 429 (a real subscription window
 * with a reset time, see `chatgpt-usage-limit.ts`). That marker is never retried
 * here: retrying an exhausted subscription window only burns calls and delays
 * the pause, and the official Codex CLI does not retry it either. See #536.
 *
 * @module agent/providers/openai-compatible/query/retry
 */

import { parseRetryAfterMs } from '../../shared/retry-after.js';
import { getErrorStatus as sharedGetErrorStatus } from '../../shared/error-status.js';
import {
  isConnectionPhaseNetworkError,
  CONNECTION_PHASE_RETRYABLE_STATUSES,
} from '../../shared/connection-error.js';
import { isChatGptUsageLimitError } from './chatgpt-usage-limit.js';

/**
 * HTTP status codes that warrant a retry for a MID-STREAM error (the stream
 * was established but the server sent an error event mid-flight). 429 (rate
 * limit) and 5xx server errors are transient by nature — the same request sent
 * again after a short wait is likely to succeed. 400/401/403/404 are
 * deterministic client errors and must NOT be retried (they would just burn
 * quota). Intentionally narrower than the connection-phase set — connection
 * errors 408/409/504 are handled exclusively by `isRetryableConnectionError`.
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
 * Cap on a single honored `retry-after` wait. A server hint beyond this is
 * clamped so a pathological or hostile header cannot park a turn for minutes.
 * Matches the Anthropic provider's `RATE_LIMIT_RETRY_MAX_WAIT_MS` (120s).
 */
export const RETRY_AFTER_MAX_WAIT_MS = 120_000;

/**
 * Test injection hook for `RETRY_AFTER_MAX_WAIT_MS`. Pass `null` to restore
 * the production default. Used by conformance tests that need short waits to
 * drive the connection-phase retry loop quickly without real timer delays.
 */
let retryAfterMaxWaitOverride: number | null = null;
export function __setRetryAfterMaxWaitMs(ms: number | null): void {
  retryAfterMaxWaitOverride = ms;
}
function resolveRetryAfterMaxWaitMs(): number {
  return retryAfterMaxWaitOverride ?? RETRY_AFTER_MAX_WAIT_MS;
}

/**
 * Server-advised backoff for a retryable error, or `undefined` when the error
 * carries no usable `retry-after` / `retry-after-ms` header.
 *
 * When present the value is clamped to {@link RETRY_AFTER_MAX_WAIT_MS}. Callers
 * use `retryAfterDelayMs(err) ?? computeBackoffDelay(attempt)` so a server hint
 * wins over the blind exponential schedule, falling back to exponential when no
 * hint is given. Deterministic (no jitter) so the wait is exactly reproducible
 * in tests and traces; parsing is delegated to the shared
 * {@link parseRetryAfterMs}, which handles both the `Headers` and plain-record
 * error shapes and the seconds / HTTP-date / `-ms` header variants.
 */
export function retryAfterDelayMs(err: unknown): number | undefined {
  const hinted = parseRetryAfterMs(err);
  if (hinted === undefined) return undefined;
  return Math.min(hinted, resolveRetryAfterMaxWaitMs());
}

/**
 * Extract an HTTP status code from an error thrown by the OpenAI SDK (or a
 * compatible shim). The SDK throws `APIError` instances with a `status` field;
 * network errors and generic throws have no status and are treated as
 * retryable (transient network blip) only when they carry no explicit code.
 *
 * Delegates to the shared {@link sharedGetErrorStatus} from
 * `providers/shared/error-status.ts`, which encodes the same field-access
 * logic used by the Anthropic-direct provider. Re-exported as
 * `getErrorStatus` so existing importers of this module compile unchanged.
 */
export function getErrorStatus(err: unknown): number | undefined {
  return sharedGetErrorStatus(err);
}

/**
 * Connection-phase retryability: the HTTP call itself failed before any
 * streaming began. Retries two classes of errors:
 *
 *   1. Statusless transport failures — `APIConnectionError` (SDK constructor
 *      name) or any error whose cause chain carries a known socket/DNS `code`
 *      (ECONNRESET, ENOTFOUND, …). The SDK's default `shouldRetry` previously
 *      covered these silently; with `maxRetries: 0` they must be retried here.
 *      `APIConnectionTimeoutError` is deliberately excluded HERE because this
 *      predicate cannot see the request signal; `runConnectionPhase` retries
 *      it separately when its stream signal is not aborted (the SDK's own
 *      connect timeout, see shared `isConnectionTimeoutError`).
 *
 *   2. Status-bearing transients (except the ChatGPT `usage_limit_reached`
 *      429, which the usage-limit tier parks on) — the union of `RETRYABLE_STATUS_CODES`
 *      (429, 500, 502, 503, 529) and `CONNECTION_PHASE_RETRYABLE_STATUSES`
 *      (408, 409, 500, 502, 504; see shared/connection-error.ts). Any of
 *      them carrying a `retry-after` header waits per `retryAfterDelayMs`. Unlike
 *      anthropic-direct, this provider has no separate overload tier, so
 *      every retryable status shares the `MAX_CONNECTION_RETRIES` budget.
 *
 * The compaction-guard (`compaction-guard.ts`) uses this predicate to decide
 * that a failed Responses-wire summarize was a transient blip rather than a
 * proof of endpoint incapability — widening it to include statusless errors is
 * correct there too (a DNS drop does not prove the endpoint is unsupported).
 */
export function isRetryableConnectionError(err: unknown): boolean {
  // A ChatGPT subscription window is exhausted: never retry, park instead.
  if (isChatGptUsageLimitError(err)) return false;
  if (isConnectionPhaseNetworkError(err)) return true;
  const status = getErrorStatus(err);
  if (status === undefined) return false;
  return RETRYABLE_STATUS_CODES.has(status) || CONNECTION_PHASE_RETRYABLE_STATUSES.has(status);
}

/** Body/error `code` values that signal a transient server overload. */
const OVERLOAD_CODES = new Set(['server_is_overloaded']);

/** Body/error `type` values that signal a transient server overload. */
const OVERLOAD_TYPES = new Set(['service_unavailable_error', 'overloaded_error']);

/**
 * Message text that signals a transient server overload. Requires the word
 * "server" to appear near "overloaded" (within 40 chars), anchoring the match
 * on known provider phrases like "Our servers are currently overloaded" while
 * excluding unrelated messages where an unrelated subsystem is overloaded
 * (e.g. "Model context window is overloaded", "worker pool overloaded").
 * The lookahead/lookbehind window is intentionally wide (40 chars) to stay
 * robust across provider-specific phrasing variations. The `\b` around
 * "overloaded" ensures the match does not fire when "overloaded" appears as
 * a suffix in a compound word (e.g. "server requestoverloaded") — see #2860.
 */
const OVERLOAD_MESSAGE_RE = /server.{0,40}\boverloaded\b|\boverloaded\b.{0,40}server/i;

/**
 * True when a `{ code?, type?, message? }` record carries an overload marker.
 * `checkMessage` is false for the error object itself: its `.message` may be a
 * non-SDK throw or a JSON-stringified body, so free-text matching is limited to
 * the parsed server body, where the SDK puts the server's own message.
 */
function hasOverloadMarker(
  rec: { code?: unknown; type?: unknown; message?: unknown },
  checkMessage: boolean,
): boolean {
  if (typeof rec.code === 'string' && OVERLOAD_CODES.has(rec.code)) return true;
  if (typeof rec.type === 'string' && OVERLOAD_TYPES.has(rec.type)) return true;
  return checkMessage && typeof rec.message === 'string' && OVERLOAD_MESSAGE_RE.test(rec.message);
}

/**
 * Invariant: a server overload can arrive WITHOUT an HTTP status.
 *
 * When the server sends a mid-stream SSE payload carrying an `error` key, the
 * openai SDK (`core/streaming` iterator) throws
 * `new APIError(undefined, data.error, undefined, headers)`: `status` is
 * `undefined`, the parsed body lives on `.error`, and `APIError`'s constructor
 * copies the body's `code` / `type` / `param` onto the error itself. The
 * status-keyed predicates below therefore never see it, and an "Our servers are
 * currently overloaded" event would surface raw with no retry or pause.
 *
 * Contract: returns true ONLY when the shared `getErrorStatus` yields
 * `undefined` AND an overload marker is present on the error itself or on its
 * `.error` body (flat `{type,code,message}` or nested `{error:{...}}` shapes,
 * mirroring anthropic-direct's `isOverloadedErrorEvent`). A status-bearing
 * error is never matched here; the numeric-status paths already own it.
 *
 * Note on the top-level `hasOverloadMarker(e, false)` call: `checkMessage` is
 * deliberately `false` here because `e.message` on the error object itself may
 * be a non-SDK throw or a JSON-stringified body — free-text matching is
 * restricted to the parsed server body (`.error`). The SDK's `APIError`
 * constructor does copy `code` and `type` from the body onto the error itself,
 * so those fields are available and safe to match here. For plain-object shapes
 * (non-SDK throws that carry no `status`), this path serves as the primary
 * guard; it is never reached when `getErrorStatus` returns a status (the
 * early-return above ensures that), so the status-keyed paths remain exclusive.
 */
export function isOpenAIOverloadError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  if (getErrorStatus(err) !== undefined) return false;
  const e = err as { code?: unknown; type?: unknown; message?: unknown; error?: unknown };
  // Match code/type on the error itself (SDK copies these from the body); skip
  // .message here since it may be a non-SDK throw or a JSON-stringified body.
  if (hasOverloadMarker(e, false)) return true;
  const body = e.error;
  if (body === null || typeof body !== 'object') return false;
  const b = body as { code?: unknown; type?: unknown; message?: unknown; error?: unknown };
  if (hasOverloadMarker(b, true)) return true;
  const inner = b.error;
  return inner !== null && typeof inner === 'object' && hasOverloadMarker(inner, true);
}

/**
 * Mid-stream retryability: the stream was established but the server sent an
 * error event mid-flight. OpenAI-compatible APIs surface this as an `APIError`
 * thrown from the async iterator. Same status-code set as connection-phase,
 * plus status-less SDK overload throws ({@link isOpenAIOverloadError}). Other
 * status-less errors, and the ChatGPT `usage_limit_reached` marker with or
 * without a status, are not retried here.
 */
export function isRetryableStreamError(err: unknown): boolean {
  if (isChatGptUsageLimitError(err)) return false;
  if (isOpenAIOverloadError(err)) return true;
  const status = getErrorStatus(err);
  if (status === undefined) return false;
  return RETRYABLE_STATUS_CODES.has(status);
}
