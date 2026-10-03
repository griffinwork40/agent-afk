/**
 * Provider-neutral tool-use-loop cap + graceful wind-down policy.
 *
 * Both provider turn-loops (`anthropic-direct/loop.ts` and
 * `openai-compatible/query.ts`) own their own stateful loop and their own
 * message/tool mechanics — the loop stays per-provider by design (see the
 * "sibling-provider approach" note in `openai-compatible/loop.ts`). What they
 * SHARE lives here: the cap resolution, the "when does the cap fire" predicate,
 * the wind-down instruction text, and the terminal stop-reason string. Keeping
 * these in one place is what stops the two providers from drifting apart — the
 * exact failure mode that left openai-compatible without the graceful wind-down
 * after it was added to anthropic-direct.
 *
 * Contract shared by both providers when the tool-round cap fires:
 *   1. run ONE final "wind-down" round with tools stripped, so the model
 *      synthesizes a real answer from what it already gathered instead of being
 *      cut off mid-round (a silent stop with no final message is
 *      indistinguishable from a hang);
 *   2. append {@link WIND_DOWN_NOTE} to that round's request ONLY (never into
 *      persisted history);
 *   3. emit `turn.completed` with `usage.stopReason === `{@link TOOL_USE_LOOP_CAPPED}
 *      so `session/closure-reason.ts` classifies the turn as `iteration_cap`.
 *
 * Intentionally pure — no I/O, no SDK imports. Mirrors the other `shared/`
 * modules (`auto-compact.ts`, `tool-input-summary.ts`, `sleep-with-abort.ts`).
 *
 * @module agent/providers/shared/tool-loop-cap
 */

/**
 * Terminal `stopReason` both providers stamp on the capped `turn.completed`.
 * `session/closure-reason.ts` maps this to the `iteration_cap` closure reason.
 */
export const TOOL_USE_LOOP_CAPPED = 'tool_use_loop_capped';

/**
 * Default cap on tool-use rounds within a single user turn. `0` means "no cap"
 * — the loop terminates only when the model stops emitting tool calls, the
 * abort signal fires, or the provider errors. This is the top-level default for
 * BOTH providers; subagent forks override it with a non-zero anti-hang default
 * (`SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS` in `subagent.ts`).
 */
export const DEFAULT_MAX_TOOL_USE_ITERATIONS = 0;

/**
 * Instruction appended to the LAST turn of the wind-down round's request (never
 * persisted to history). Tells the model its tool budget is spent so it answers
 * in text. Identical wording across providers so behavior matches exactly.
 */
export const WIND_DOWN_NOTE =
  'You have reached your tool-use budget for this turn. Do not request ' +
  'any more tools — give your final answer now using only the ' +
  'information already gathered.';

/**
 * Resolve the effective per-turn tool-round cap from the configured value.
 * `undefined`, `0`, and non-positive values all mean "no cap" ({@link
 * DEFAULT_MAX_TOOL_USE_ITERATIONS}); a positive value is floored to an integer.
 * Single source of truth — replaces the per-provider constants that previously
 * diverged (anthropic-direct defaulted to `0`; openai-compatible hard-coded 50
 * and ignored config entirely).
 */
export function resolveMaxToolIterations(configured: number | undefined): number {
  return configured !== undefined && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_TOOL_USE_ITERATIONS;
}

/**
 * True once `completedRounds` tool-use rounds have run and a positive cap is in
 * effect — the signal for a loop to enter its single wind-down round. A cap of
 * `0` (unlimited) never fires.
 */
export function shouldWindDown(completedRounds: number, maxIterations: number): boolean {
  return maxIterations > 0 && completedRounds >= maxIterations;
}

/**
 * Render the round-number label both providers embed in the progress-banner
 * `summary` string (`round ${label}: ${toolHeadline}`).
 *
 * `maxIterations` must already be a RESOLVED cap (the output of {@link
 * resolveMaxToolIterations}, not raw config) — same contract as {@link
 * shouldWindDown}. A positive cap renders the denominator (`round 7/50`) so
 * the banner shows how close the child is to its tool-round ceiling;
 * `maxIterations <= 0` means unlimited, so the bare `round 7` is kept as-is
 * rather than rendering the meaningless `round 7/0` or `round 7/Infinity`.
 */
export function formatRoundLabel(round: number, maxIterations: number): string {
  return maxIterations > 0 ? `round ${round}/${maxIterations}` : `round ${round}`;
}

/**
 * Warning thresholds for advance remaining-round notifications.
 *
 * Each value is the number of REMAINING rounds (not completed rounds) at which
 * the shared policy emits a single warning text to the in-flight model turn.
 * Thresholds are relative so they scale with any cap size — a 12-round
 * probe and a 120-round flagship both get a "10 remaining" and a "5 remaining"
 * warning at proportionally the same moment. Smallest-cap coverage: the
 * minimum useful thresholds only fire when remaining > 0 AND remaining < cap,
 * so a 3-round cap gets a ≤2-remaining warning (but not a redundant 10 one).
 *
 * Design: one-shot per threshold (callers track last-warned via
 * {@link pickRoundWarning}). Emitting at ROUND boundaries (not between API
 * calls) keeps parity between both provider loops.
 */
export const ROUND_WARNING_THRESHOLDS = [10, 5, 2] as const;

/**
 * Return a warning string when `completedRounds` has just crossed a
 * {@link ROUND_WARNING_THRESHOLDS} boundary, or `null` when no new warning
 * applies. The caller must pass the previously-warned threshold (`lastWarned`,
 * initially `undefined`) so each threshold fires at most ONCE per turn.
 *
 * Contract:
 *  - Only fires when a positive cap is in effect (`maxIterations > 0`).
 *  - Only fires when remaining rounds are positive (> 0) — the wind-down note
 *    covers the "zero remaining" moment.
 *  - Thresholds are tested in descending order; the first unseen hit is returned.
 *  - A budget too small to reach a threshold (e.g. cap=3) only gets the
 *    thresholds that fit within it (remaining=2 fires the ≤2 warning).
 *  - Unlimited budgets (maxIterations ≤ 0) never warn.
 *
 * Usage pattern (both provider loops):
 * ```
 * const [warnText, newLastWarned] = pickRoundWarning(round, maxIterations, lastWarnedThreshold);
 * if (warnText !== null) { ... inject warnText into the next model turn; lastWarnedThreshold = newLastWarned; }
 * ```
 */
export function pickRoundWarning(
  completedRounds: number,
  maxIterations: number,
  lastWarned: number | undefined,
): [string, number] | [null, undefined] {
  if (maxIterations <= 0) return [null, undefined];
  const remaining = maxIterations - completedRounds;
  if (remaining <= 0) return [null, undefined]; // wind-down fires instead

  // Find the smallest threshold that `remaining` fits under and that has not
  // been warned yet. Thresholds are tested in descending order; we scan all
  // of them and pick the tightest match (the one with the smallest value
  // where remaining <= threshold AND lastWarned > threshold or is undefined).
  // Example: remaining=2 → fits ≤10, ≤5, AND ≤2; tightest is 2.
  let tightest: (typeof ROUND_WARNING_THRESHOLDS)[number] | undefined;
  for (const threshold of ROUND_WARNING_THRESHOLDS) {
    if (remaining <= threshold && (lastWarned === undefined || lastWarned > threshold)) {
      tightest = threshold;
    }
  }
  if (tightest === undefined) return [null, undefined];
  const plural = remaining === 1 ? 'round' : 'rounds';
  return [
    `[Budget notice: ${remaining} tool-use ${plural} remaining of ${maxIterations}. ` +
      `Prioritize the highest-value remaining work and prepare to summarize findings ` +
      `if more rounds are needed than remain.]`,
    tightest,
  ];
}
