/**
 * Responses-wire compaction-support predicate for the openai-compatible provider.
 *
 * Determines whether an error PROVES that the endpoint cannot serve a
 * Responses-wire compaction request — as opposed to having transiently failed
 * one. Extracted from query.ts to keep that file within its line ceiling.
 *
 * @module agent/providers/openai-compatible/query/compaction-guard
 */

import {
  getErrorStatus,
  isRetryableConnectionError,
  isRetryableStreamError,
} from './retry.js';
import { ResponsesSummaryIncompleteError } from '../oneshot.js';

/**
 * Statuses that prove the endpoint refused the REQUEST ITSELF (its shape, route,
 * or media type) rather than transiently failing to serve it. 429 and 5xx are
 * deliberately absent (transient — see `isRetryableConnectionError`), as are
 * 401/403 (a credential can be hot-swapped mid-session, so an auth lapse must
 * not permanently disable compaction).
 */
const UNSUPPORTED_REQUEST_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

/**
 * Contract: does `err` PROVE this endpoint cannot serve a Responses-wire
 * summarize at all — as opposed to having transiently failed one?
 *
 * Only an explicit, deterministic client-side refusal counts. The distinction
 * matters because the latch it guards is PERMANENT for the session, so a false
 * positive disables compaction until the session ends — re-creating the very
 * context-window exhaustion issue #653 fixed. Deliberately NOT proof:
 *   - 429 / 5xx and friends — transient, already classified by the retry preds;
 *   - status-less throws (network drop, DNS, bad baseURL) — a blip or a
 *     misconfiguration, neither of which is the backend refusing this shape;
 *   - {@link ResponsesSummaryIncompleteError} — the backend DID accept and serve
 *     the request, then streamed a failed/partial response. The wire works.
 */
export function provesResponsesCompactionUnsupported(err: unknown): boolean {
  if (err instanceof ResponsesSummaryIncompleteError) return false;
  if (isRetryableConnectionError(err) || isRetryableStreamError(err)) return false;
  const status = getErrorStatus(err);
  return status !== undefined && UNSUPPORTED_REQUEST_STATUSES.has(status);
}
