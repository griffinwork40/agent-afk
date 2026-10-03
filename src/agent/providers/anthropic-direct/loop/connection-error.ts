/**
 * Connection-phase network failure classifier + retry budget.
 *
 * History: #2422 (PR #2702, v5.278.0) set `maxRetries: 0` on every SDK client
 * so AFK's own loops are the single traced retry authority. The SDK's default
 * two retries had been silently absorbing connection-phase blips (a stale
 * keep-alive socket reused after an idle gap, a brief DNS or Wi-Fi drop). With
 * them gone, `createWithRetry` only retried 529/503, so every such blip became
 * a fatal `APIConnectionError: Connection error.` that killed the turn (and any
 * subagent mid-run). Witness traces showed 1 such failure in the two weeks
 * before v5.278.0 and 11 in the three days after.
 *
 * Invariant: this covers the CONNECTION phase only, meaning `messages.create`
 * rejected before any response headers arrived, so nothing was generated and
 * a retry costs no partial output. Mid-stream drops after headers are a
 * different class with their own LOW budget (see network-termination.ts and
 * STREAM_INCOMPLETE_MAX_RETRIES in retry-budget.ts).
 *
 * Pure: no SDK import (classified by constructor name and cause-chain `code`), no I/O.
 */

/** Retries for a connection-phase network failure. Matches the SDK default the fix replaces. */
export const CONNECTION_ERROR_MAX_RETRIES = 2;
/** Base backoff; doubled per attempt and jittered. Short: the request never reached the model. */
export const CONNECTION_ERROR_BASE_DELAY_MS = 1_000;

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
 * Contract: true when `err` is a connection-phase transport failure worth a
 * fresh attempt:
 *
 *   - the SDK's `APIConnectionError` (exact class, no HTTP status), which wraps
 *     any `fetch` rejection as "Connection error.", OR
 *   - any error whose own `code`, or a `code` on its bounded `cause` chain, is
 *     one of {@link CONNECT_CODES}.
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

/**
 * Contract: the underlying network code for trace metadata, e.g. `ECONNRESET`,
 * or `undefined` when no `code` is found on the bounded cause chain.
 */
export function connectionErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (cur === null || typeof cur !== 'object') return undefined;
    const { code, cause } = cur as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    if (cause === cur) return undefined;
    cur = cause;
  }
  return undefined;
}
