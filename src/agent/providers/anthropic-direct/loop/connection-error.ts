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
 * rejected before any stream body was consumed, so nothing was generated and a
 * retry costs no partial output. Three shapes qualify: a transport failure
 * with no response at all (`APIConnectionError` or a socket/DNS code), an SDK
 * connect timeout (`APIConnectionTimeoutError`, retried only while the request
 * signal is not aborted), and a status-bearing 408/409/500/502/504, where the
 * server DID answer with headers but no model output was streamed. Mid-stream
 * drops after streaming began are a different class with their own LOW budget
 * (see network-termination.ts and STREAM_INCOMPLETE_MAX_RETRIES in
 * retry-budget.ts).
 *
 * The classifiers (`isConnectionPhaseNetworkError`, `isConnectionTimeoutError`,
 * `isRetryableConnectionStatus`) live in `../../shared/connection-error.ts` so
 * the openai-compatible provider can share them; the budget constants,
 * `connectionErrorCode` and `connectionRetryMetadata` are anthropic-direct
 * specific and remain here.
 *
 * Pure: no SDK import (classified by constructor name and cause-chain `code`), no I/O.
 */

import { redactSecrets } from '../../../redact-secrets.js';

export {
  isConnectionPhaseNetworkError,
  isConnectionTimeoutError,
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

/** Max characters of error text recorded in a `connection_retry` trace event. */
const TRACE_ERROR_MAX_CHARS = 200;

/**
 * Contract: the `metadata` object of one `connection_retry` session_phase event.
 * `error` is truncated and passed through `redactSecrets`, the same treatment
 * `tool_call.completed.errorHead` gets: the status-retry path (408/500/502/504)
 * carries SDK `APIError` messages that embed the response body, so proxy or
 * gateway text would otherwise land in the trace verbatim. `code` and `status`
 * are included only when present.
 */
export function connectionRetryMetadata(
  info: { attempt: number; error: Error },
  maxRetries: number = CONNECTION_ERROR_MAX_RETRIES,
): Record<string, string | number | boolean> {
  const code = connectionErrorCode(info.error);
  const status = (info.error as { status?: unknown }).status;
  return {
    attempt: info.attempt,
    maxRetries,
    error: redactSecrets(info.error.message.slice(0, TRACE_ERROR_MAX_CHARS)),
    ...(code !== undefined ? { code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
  };
}
