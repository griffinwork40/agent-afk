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
 * First-byte attempts a round got while the TTFB retry was a BOOLEAN: the
 * initial request plus exactly one re-drive.
 *
 * Kept as a named constant — not folded into the arithmetic below — because it
 * is the worst-case BASELINE the counted budget must not exceed. See
 * {@link ttfbAttemptTimeoutMs}.
 */
export const TTFB_LEGACY_ATTEMPTS = 2;

/** TTFB re-drives allowed per round. Total attempts = this + 1. */
export const TTFB_MAX_RETRIES = 2;

/** Total first-byte attempts per round: the initial request plus the re-drives. */
export const TTFB_MAX_ATTEMPTS = TTFB_MAX_RETRIES + 1;

// Invariant: MORE TTFB attempts must not buy a LONGER worst case. The counted
// budget below is only admissible because the per-attempt bound shrinks by
// exactly the factor the attempt count grows, so the product never rises:
//
//   before (boolean):  TTFB_LEGACY_ATTEMPTS × B          = 2B
//   after  (counted):  TTFB_MAX_ATTEMPTS    × ⌊2B / 3⌋   ≤ 2B    ∀ B ≥ 0
//
// with B = the operator-configured `AFK_MODEL_TTFB_TIMEOUT_MS`. Worked:
//   B = 180_000 (code default) → 3 × 120_000 = 360_000 ≤ 360_000  ✔
//   B = 300_000 (operator)     → 3 × 200_000 = 600_000 ≤ 600_000  ✔
//
// The bound therefore holds for EVERY configured value, not just the default —
// which a fixed per-attempt constant (e.g. "3 × 45s = 135s") would not: at
// B = 300_000 that reads the env var as the per-attempt bound and yields
// 3 × 300s = 900s, a 1.5× REGRESSION on the very config this fix targets.
//
// Why more attempts at all: measured stall rate ≈16% per request with ~25
// requests per sub-agent, so P(≥1 stall) ≈ 99% and P(a given round exhausts
// 2 attempts) ≈ 2.6% vs ≈0.4% at 3 — while the shorter bound (120s at the
// default) still sits well above the measured p99 TTFB of ≈85s, so no
// legitimately slow prefill is newly cut. Trading bound length for attempt
// count is strictly better against a bimodal failure (a stalled call returns
// NOTHING, so waiting longer on it buys nothing).
//
// Pinned by retry-budget.test.ts, which re-derives the product for a spread of
// B values rather than trusting this comment.

/**
 * Contract: the per-ATTEMPT first-byte bound derived from the per-ROUND
 * configured budget, such that `TTFB_MAX_ATTEMPTS` attempts cost no more wall
 * time than the pre-count regime's `TTFB_LEGACY_ATTEMPTS` did (see the
 * Invariant above).
 *
 * `0` in → `0` out: the explicit `AFK_MODEL_TTFB_TIMEOUT_MS=0` disable escape
 * hatch must survive the derivation untouched. Any positive input floors at
 * `1`ms, because a rounded-down sub-3ms budget would otherwise reach
 * `armFirstByteTimeout` as `<= 0` and silently DISABLE the watchdog instead of
 * tightening it.
 *
 * Invariant: the product bound `TTFB_MAX_ATTEMPTS × result ≤
 * TTFB_LEGACY_ATTEMPTS × configured` holds exactly for every
 * `configured >= TTFB_MAX_ATTEMPTS` (the floor division cannot overshoot once
 * there is at least 1ms per attempt to divide). BELOW that the 1ms floor wins
 * on purpose and the product may exceed the legacy figure by at most
 * `TTFB_MAX_ATTEMPTS` ms — e.g. `configured = 1` yields `3ms` vs a legacy
 * `2ms`. That carve-out is deliberate: a sub-3ms TTFB budget is not a
 * realistic configuration, 1ms is below `setTimeout` granularity anyway, and
 * the alternative (returning `0`) would disable the watchdog entirely — a real
 * regression traded for an imperceptible one. Both halves are pinned by
 * retry-budget.test.ts.
 */
export function ttfbAttemptTimeoutMs(configuredTtfbMs: number): number {
  if (!Number.isFinite(configuredTtfbMs) || configuredTtfbMs <= 0) return 0;
  const perAttempt = Math.floor((configuredTtfbMs * TTFB_LEGACY_ATTEMPTS) / TTFB_MAX_ATTEMPTS);
  return Math.max(1, perAttempt);
}

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
   * Time-to-first-byte re-drives spent on the current round.
   *
   * A COUNTER bounded by {@link TTFB_MAX_RETRIES}, not the original boolean.
   * The boolean existed to stop the TTFB retry stacking into a longer worst
   * case; that protection now comes from the arithmetic instead — the
   * per-attempt bound shrinks by the factor the attempt count grows
   * ({@link ttfbAttemptTimeoutMs}), so the per-round worst case is bounded by
   * the pre-count regime's while a transient stall gets 3 chances instead of 2.
   * Independent of the overload and stream-incomplete budgets below: those
   * still spend their own counters and serve their own backoffs.
   */
  ttfbRetries = 0;

  /** True while another mid-stream overload retry remains. */
  canRetryOverload(): boolean {
    return this.overloadRetries < OVERLOAD_MAX_RETRIES;
  }

  /** True while another mid-stream clean-close re-drive remains. */
  canRetryStreamIncomplete(): boolean {
    return this.streamIncompleteRetries < STREAM_INCOMPLETE_MAX_RETRIES;
  }

  /** True while another first-byte re-drive remains on this round's budget. */
  canRetryTtfb(): boolean {
    return this.ttfbRetries < TTFB_MAX_RETRIES;
  }

  /**
   * Release all three budgets. Called once a round resolves without needing a
   * retry, so the NEXT round starts with a full allowance.
   */
  reset(): void {
    this.overloadRetries = 0;
    this.streamIncompleteRetries = 0;
    this.ttfbRetries = 0;
  }
}
