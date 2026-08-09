/**
 * Provider-neutral SOFT wall-clock deadline + wind-down policy.
 *
 * Sibling of `tool-loop-cap.ts` and deliberately separate from it: that module
 * owns the ROUND-COUNT trigger for wind-down, this one owns the TIME trigger.
 * They share the same downstream mechanism (strip tools, append a note, run one
 * final synthesis round) but answer different questions, so they stay different
 * modules rather than one predicate with two meanings.
 *
 * Invariant: a subagent's wall-clock budget is enforced OUTSIDE its turn loop —
 * `subagent/handle.ts` wraps the whole `streamToFinalMessage` call in
 * `withTimeout` (`agent/timeout.ts`), which on expiry calls
 * `controller.abort(err)` synchronously and rejects on the same tick. The loop
 * is never consulted. That is the correct behaviour for a WEDGED child and the
 * wrong behaviour for a merely SLOW one: a child three quarters of the way
 * through useful work is killed with everything it learned still unsynthesized.
 * The partial-output plumbing (`subagent/handle.ts` → `tools/skill-executor/
 * fork-result.ts`) preserves whatever raw text happened to be mid-stream, but a
 * raw fragment is not an answer — it is usually a half-written sentence, and it
 * is empty when the child died mid-tool-call.
 *
 * This module supplies the earlier, cooperative deadline. The loop checks it at
 * a round boundary and, when it has passed, winds down exactly as it does for a
 * spent tool budget: one tools-stripped round in which the model reports what it
 * found. The hard `withTimeout` abort stays armed underneath as the backstop, so
 * a genuinely wedged child still dies on schedule.
 *
 * Two limits worth naming, because neither is a bug:
 *   1. The check happens at ROUND BOUNDARIES. A single tool call that hangs past
 *      the hard deadline never reaches one, so no wind-down occurs — that case
 *      belongs to `subagent/idle-watchdog.ts`, which bounds time-since-output.
 *   2. The synthesis round may itself overrun the reserve and be cut off by the
 *      hard abort. That is strictly better than today: the attempt costs one
 *      round, and whatever the round streamed is still preserved as partial
 *      output.
 *
 * Intentionally pure — no I/O, no SDK imports, no clock capture at module load.
 * Mirrors the other `shared/` modules (`tool-loop-cap.ts`, `auto-compact.ts`).
 *
 * @module agent/providers/shared/soft-deadline
 */

/**
 * Terminal `stopReason` both providers stamp when the turn ended because the
 * SOFT wall-clock deadline triggered a wind-down, as distinct from
 * `TOOL_USE_LOOP_CAPPED` (round budget spent). Kept separate so a turn that ran
 * out of TIME is never misreported as one that ran out of ROUNDS — they call for
 * different operator responses (raise the budget vs. narrow the task).
 */
export const SOFT_DEADLINE_WIND_DOWN = 'soft_deadline_wind_down';

/**
 * Instruction appended to the LAST turn of the wind-down round's request (never
 * persisted to history). Deliberately worded around TIME rather than tools, so
 * the model does not report "I ran out of tool calls" when it ran out of clock.
 */
export const SOFT_DEADLINE_NOTE =
  'Your time budget for this turn is nearly spent. Do not request any more ' +
  'tools — give your final answer now using only the information already ' +
  'gathered. If your work is incomplete, say briefly what you established, ' +
  'what remains unresolved, and what you would check next.';

/**
 * Fraction of the hard budget held back for the synthesis round.
 *
 * The reserve must cover one model round with no tool calls. 15% of a 45-minute
 * fork is ~6.75 minutes, far more than a text-only round needs, which is why it
 * is clamped below.
 */
export const SOFT_DEADLINE_RESERVE_FRACTION = 0.15;

/** Floor on the reserve — a synthesis round on a throttled lane needs real time. */
export const SOFT_DEADLINE_MIN_RESERVE_MS = 30_000;

/** Ceiling on the reserve — past this, extra headroom only steals working time. */
export const SOFT_DEADLINE_MAX_RESERVE_MS = 5 * 60_000;

/**
 * Budgets at or below this get NO soft deadline.
 *
 * Below ~2 minutes there is no split of the budget that leaves both meaningful
 * working time and a usable synthesis reserve, so carving one out would trade a
 * small chance of a graceful answer for a large chance of winding down a child
 * that had barely started. Short-budget forks keep the previous behaviour
 * exactly: hard abort with whatever partial output exists.
 */
export const SOFT_DEADLINE_MIN_BUDGET_MS = 120_000;

/**
 * Resolve the soft deadline (ms from turn start) from a hard wall-clock budget.
 *
 * Returns `0` — meaning "no soft deadline, hard abort only" — for an unbounded
 * budget (`0`/`undefined`, the top-level-session case, where a human owns the
 * turn), for a non-finite or negative value, and for any budget at or below
 * {@link SOFT_DEADLINE_MIN_BUDGET_MS}.
 *
 * @param hardTimeoutMs the wall-clock budget enforced by `withTimeout`
 * @returns ms from turn start after which the loop should wind down, or `0`
 */
export function resolveSoftDeadlineMs(hardTimeoutMs: number | undefined): number {
  if (hardTimeoutMs === undefined) return 0;
  if (!Number.isFinite(hardTimeoutMs) || hardTimeoutMs <= 0) return 0;
  if (hardTimeoutMs <= SOFT_DEADLINE_MIN_BUDGET_MS) return 0;

  const rawReserve = hardTimeoutMs * SOFT_DEADLINE_RESERVE_FRACTION;
  const reserve = Math.min(
    SOFT_DEADLINE_MAX_RESERVE_MS,
    Math.max(SOFT_DEADLINE_MIN_RESERVE_MS, rawReserve),
  );
  return Math.max(0, Math.floor(hardTimeoutMs - reserve));
}

/**
 * True once a turn that started at `startedAt` has passed its soft deadline —
 * the signal for a loop to enter its single wind-down round.
 *
 * A `softDeadlineMs` of `0` (the {@link resolveSoftDeadlineMs} "off" value)
 * never fires, mirroring how a `maxIterations` of `0` never fires in
 * {@link import('./tool-loop-cap.js').shouldWindDown}.
 *
 * `now` is injected rather than read from a captured clock so the predicate
 * stays pure and directly testable.
 */
export function softDeadlineExpired(
  startedAt: number,
  softDeadlineMs: number,
  now: number = Date.now(),
): boolean {
  return softDeadlineMs > 0 && now - startedAt >= softDeadlineMs;
}
