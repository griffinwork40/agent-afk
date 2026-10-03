/**
 * Shared connection-phase network failure classifier.
 *
 * Extracted from `anthropic-direct/loop/connection-error.ts` so the
 * openai-compatible provider can use the same classifier without duplicating
 * the logic. Both SDK error hierarchies use identical constructor names
 * (`APIConnectionError`, `APIConnectionTimeoutError`) and the same `cause`-chain
 * `code` conventions, so a single predicate covers both.
 *
 * anthropic-direct's provider-specific budget constants (`CONNECTION_ERROR_MAX_RETRIES`,
 * `CONNECTION_ERROR_BASE_DELAY_MS`) and the `connectionErrorCode` helper remain
 * in `anthropic-direct/loop/connection-error.ts` — that file now re-exports
 * the classifier from here.
 *
 * Pure: no SDK import (classified by constructor name and cause-chain `code`), no I/O.
 *
 * @module agent/providers/shared/connection-error
 */

/** Socket / DNS / connect codes meaning "the request never got through". */
const CONNECT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Cause-chain walk bound; also guards against a self-referential `cause`. */
const MAX_CAUSE_DEPTH = 5;

/**
 * HTTP status codes that are retryable at the CONNECTION phase (before any
 * response body was streamed). Used by both providers' connection-phase retry
 * loops. Intentionally narrower than the mid-stream set and distinct from the
 * overload set (529/503 → `isTransientServerError`):
 *
 *   - 408 Request Timeout: the server closed the TCP connection before the
 *     request body was fully received — a fresh retry with a new connection
 *     succeeds against a healthy server.
 *   - 409 Conflict: rare on LLM APIs but treated as transient per SDK parity
 *     (the OpenAI SDK's `shouldRetry` includes it).
 *   - 500 Internal Server Error: a transient crash on the server side;
 *     identical semantics to 502/504 for a connection-phase failure.
 *   - 502 Bad Gateway: the upstream origin returned an error to the gateway;
 *     a retry lands on a healthy replica most of the time.
 *   - 504 Gateway Timeout: the gateway gave up waiting for the upstream before
 *     the connection was established; a retry succeeds against a healthy replica.
 *
 * 429, 503 and 529 are deliberately absent. In anthropic-direct, 429 belongs
 * to the rate-limit / usage-limit tiers and 503/529 to the overload tier
 * (`isTransientServerError`), each with its own budget and terminal; adding
 * them here would retry them under the wrong budget. openai-compatible keeps
 * them in its own `RETRYABLE_STATUS_CODES` and unions the two sets.
 */
export const CONNECTION_PHASE_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 500, 502, 504,
]);

/**
 * Contract: true when `err` carries an HTTP status that is retryable at the
 * CONNECTION phase (no response body was streamed).
 *
 * Deliberately excludes 429 (rate-limit tiers) and 529/503 (overload tiers).
 * Callers must check their abort signal BEFORE this.
 */
export function isRetryableConnectionStatus(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status !== 'number') return false;
  return CONNECTION_PHASE_RETRYABLE_STATUSES.has(status);
}

/**
 * Contract: true when `err` is a connection-phase transport failure worth a
 * fresh attempt:
 *
 *   - the SDK's `APIConnectionError` (exact class, no HTTP status), which wraps
 *     any `fetch` rejection as "Connection error.", OR
 *   - any error whose own `code`, or a `code` on its bounded `cause` chain, is
 *     one of the known socket/DNS codes.
 *
 * Deliberately excludes `APIConnectionTimeoutError` (the SDK's own request
 * timeout; AFK's TTFB watchdog owns that window) and anything carrying an
 * HTTP status (those are server answers, routed by the status-based tiers).
 * Callers must check their abort signal BEFORE this, so a user interrupt or a
 * watchdog abort is never mistaken for a network blip.
 */
export function isConnectionPhaseNetworkError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const top = err as { status?: unknown };
  if (typeof top.status === 'number') return false;
  // The SDK does not set `name` on its error classes (it stays 'Error'), so
  // classify on the constructor name. Safe in the published bundle:
  // build-dist.mjs sets `minifyIdentifiers: false`, and subagent/handle.ts
  // already records `constructor.name` as 'APIConnectionError' in live traces.
  // The timeout subclass has its own constructor name, so it falls through.
  const ctorName = (err as { constructor?: { name?: unknown } }).constructor?.name;
  if (ctorName === 'APIConnectionTimeoutError') return false;
  if (ctorName === 'APIConnectionError') return true;
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (cur === null || typeof cur !== 'object') return false;
    const { code, cause } = cur as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && CONNECT_CODES.has(code)) return true;
    if (cause === cur) return false;
    cur = cause;
  }
  return false;
}
