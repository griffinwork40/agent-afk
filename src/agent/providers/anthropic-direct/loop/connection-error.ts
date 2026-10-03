/**
 * Connection-phase network failure classifier + retry budget for anthropic-direct.
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
 * The two classifiers (`isConnectionPhaseNetworkError`, `isRetryableConnectionStatus`)
 * live in `../../shared/connection-error.ts` so the openai-compatible provider
 * can share them; the budget constants and `connectionErrorCode` are
 * anthropic-direct-specific and remain here.
 *
 * Pure: no SDK import (classified by constructor name and cause-chain `code`), no I/O.
 */

export {
  isConnectionPhaseNetworkError,
  isRetryableConnectionStatus,
} from '../../shared/connection-error.js';

/** Retries for a connection-phase network failure. Matches the SDK default the fix replaces. */
export const CONNECTION_ERROR_MAX_RETRIES = 2;
/** Base backoff; doubled per attempt and jittered. Short: the request never reached the model. */
export const CONNECTION_ERROR_BASE_DELAY_MS = 1_000;

/** Cause-chain walk bound; also guards against a self-referential `cause`. */
const MAX_CAUSE_DEPTH = 5;

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
