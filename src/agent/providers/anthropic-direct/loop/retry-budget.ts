/**
 * Per-round retry classification and budget for the anthropic-direct turn loop.
 *
 * Owns three things:
 *  - the retry-class **predicates** (`isTransientServerError`,
 *    `isOverloadedErrorEvent`) that decide whether a failure is retryable,
 *  - the **tuning constants** bounding each retry class, and
 *  - {@link RoundRetryBudget}, the mutable per-round allowance that the stream
 *    consumer spends and the retry handler reads.
 *
 * Extracted from `loop.ts`. The predicates and constants moved unchanged.
 *
 * @module agent/providers/anthropic-direct/loop/retry-budget
 */

export const OVERLOAD_MAX_RETRIES = 3;
export const OVERLOAD_BASE_DELAY_MS = 5_000;

// Invariant: the mid-stream clean-close budget stays BELOW OVERLOAD_MAX_RETRIES.
//
// A `StreamIncompleteError` is what translate.ts surfaces as an in-band error
// event when the SSE stream ended with NEITHER a `message_stop` NOR a
// `stop_reason` AFTER content had already streamed (an intermediary
// proxy/gateway/LB dropped the connection mid-generation; the raw SDK stream
// ends without throwing). This is distinct from both other retry classes: not a
// TTFB stall (a first byte WAS seen, so the stall timer never fires) and not an
// overload (no `overloaded_error` / 529), so without this branch it falls
// straight through to the fatal path.
//
// Kept LOW (below OVERLOAD_MAX_RETRIES = 3): each failed attempt burns a
// partial — often long — generation before the cut, so a retry costs far more
// here than a fast 529 rejection. Two attempts rescue the common transient blip
// while capping wasted token/latency spend on a deterministic
// (too-long-for-the-proxy) cut; the companion default-subagent contract (write
// bulk output to files, keep the final message short) shrinks the generation so
// these retries stay cheap. The delay is short (1s → 2s, not overload's
// 5s/10s/20s): a dropped connection is not a server-overload signal, so we
// reconnect promptly while still avoiding a tight loop against a flapping
// intermediary.
export const STREAM_INCOMPLETE_MAX_RETRIES = 2;
export const STREAM_INCOMPLETE_BASE_DELAY_MS = 1_000;

/**
 * Connection-phase transient: a real HTTP status on a thrown SDK error.
 * Consulted by the `messages.create` retry wrapper, where a status is present.
 */
export function isTransientServerError(err: Error): boolean {
  if (!('status' in err)) return false;
  const status = (err as Error & { status: number }).status;
  return status === 529 || status === 503;
}

/**
 * Detect a transient Anthropic *overload* delivered as a **mid-stream** SSE
 * `error` event. A connection-phase 529 carries a real HTTP `status` (handled
 * by {@link isTransientServerError} inside the create-retry wrapper); a
 * mid-stream overload is different — the SDK throws it from inside the stream
 * iterator as `new APIError(undefined, <parsed SSE body>, …)`, so `status` is
 * `undefined` and the only signal is the parsed body's nested
 * `error.type === 'overloaded_error'`. translate.ts converts that throw into an
 * in-band `{type:'error', error}` event whose `error` IS the APIError, so this
 * predicate inspects the (usually absent) status AND the nested SSE body in
 * both its double-nested (`{type:'error', error:{type:'overloaded_error'}}`)
 * and flat (`{type:'overloaded_error'}`) shapes.
 */
export function isOverloadedErrorEvent(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { status?: unknown; error?: unknown };
  if (e.status === 529 || e.status === 503) return true;
  const body = e.error;
  if (body === null || typeof body !== 'object') return false;
  const b = body as { type?: unknown; error?: { type?: unknown } | null };
  const innerType = (b.error !== null && typeof b.error === 'object' ? b.error.type : undefined) ?? b.type;
  return innerType === 'overloaded_error';
}

/**
 * Contract: mutable retry allowance scoped to ONE tool-use round.
 *
 * Three independent budgets share this object because they share a lifetime —
 * each is spent while a single round's stream is being driven, and all three
 * are released together by {@link RoundRetryBudget.reset} once that round
 * resolves cleanly. Mirroring the create-retry wrapper's per-call (not
 * per-turn) scope, this gives every round its own full allowance.
 *
 * Before extraction these were three loose `let`s in `runTurn`, reset by a bare
 * three-line side effect in the middle of a ~1000-line function. They are
 * grouped here so the reset is a named, testable operation: the readers (stream
 * consumption) and the writers (retry dispatch) now live in different modules
 * and must agree on exactly one budget instance.
 */
export class RoundRetryBudget {
  /**
   * Mid-stream overload retries spent on the current round. Distinct from the
   * connection-phase budget inside the create-retry wrapper, which
   * `createWithRetry` spends before any stream exists.
   */
  overloadRetries = 0;

  /** Mid-stream clean-close (`StreamIncompleteError`) re-drives spent. */
  streamIncompleteRetries = 0;

  /**
   * Whether this round already burned its single time-to-first-byte re-drive.
   * A boolean, not a counter: the TTFB retry is deliberately once-per-round so
   * it cannot stack on top of the overload backoff into a longer worst case.
   */
  ttfbRetried = false;

  /** True while another mid-stream overload retry remains. */
  canRetryOverload(): boolean {
    return this.overloadRetries < OVERLOAD_MAX_RETRIES;
  }

  /** True while another mid-stream clean-close re-drive remains. */
  canRetryStreamIncomplete(): boolean {
    return this.streamIncompleteRetries < STREAM_INCOMPLETE_MAX_RETRIES;
  }

  /** True while this round's single TTFB re-drive is unspent. */
  canRetryTtfb(): boolean {
    return !this.ttfbRetried;
  }

  /**
   * Release all three budgets. Called once a round resolves without needing a
   * retry, so the NEXT round starts with a full allowance.
   */
  reset(): void {
    this.overloadRetries = 0;
    this.streamIncompleteRetries = 0;
    this.ttfbRetried = false;
  }
}
