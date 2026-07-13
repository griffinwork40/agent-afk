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
