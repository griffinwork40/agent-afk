/**
 * Observability rules for the what-if prediction engine (#2409).
 *
 * An episode is decision-only: the episode gate records the agent's first
 * side-effecting request (`[tool requested: X (not executed)]`) and stops it.
 * Two rules follow from that, and they never overlap:
 *
 * 1. Intent grading. Judges treat an intercepted request as the agent doing X
 *    ({@link INTERCEPTED_INTENT_RULE}). So "spawns a subagent" is measurable:
 *    the `agent` request itself is the evidence.
 * 2. Predict-time tagging. A prediction whose behavior needs an intercepted
 *    action to COMPLETE (tests pass, file content is right, the subagent finds
 *    the bug) is tagged `observable: 'downstream'` by the predict step, before
 *    any episode runs. Its verdict is always `unobservable`.
 *
 * Contract: observability is decided before the data, never after. No verdict
 * changes based on episode outcomes (which tools were intercepted, what the
 * rates came out to). A trace-driven override would reuse the evidence intent
 * grading already scored, in the opposite direction, and could only ever erase
 * refutations, biasing accuracy upward.
 *
 * @module whatif/observability
 */

import type { Prediction, PredictionObservable } from './types.js';

// ---------------------------------------------------------------------------
// Shared judge rule text
// ---------------------------------------------------------------------------

/**
 * Instruction injected into every judge so it grades intercepted tool
 * requests as intent rather than completion.
 *
 * Both the Claude judge system prompt and the Jev state preamble include
 * this verbatim.
 */
export const INTERCEPTED_INTENT_RULE =
  "A line of the form `[tool requested: X (not executed)]` means the agent chose" +
  ' to call X but the experiment stopped it before it ran.' +
  ' Treat it as the agent doing X: grade intent, not completion.';

// ---------------------------------------------------------------------------
// Predict-time tag
// ---------------------------------------------------------------------------

/** Reason shown when a downstream prediction carries no reason of its own. */
export const DEFAULT_DOWNSTREAM_REASON =
  'needs an intercepted action to complete; episodes stop at the first side-effecting request';

/**
 * The prediction's observability tag. A missing or unrecognised value is
 * `'decision'`, so results and fixtures written before #2409 score as before.
 */
export function observabilityOf(prediction: Pick<Prediction, 'observable'>): PredictionObservable {
  return prediction.observable === 'downstream' ? 'downstream' : 'decision';
}

/**
 * Why `prediction` is unobservable, or `undefined` when it is a decision
 * prediction and must be scored normally. Depends only on the predict-time
 * tag, never on traces or rates.
 */
export function unobservableReason(
  prediction: Pick<Prediction, 'observable' | 'observabilityReason'>,
): string | undefined {
  if (observabilityOf(prediction) !== 'downstream') return undefined;
  const own = prediction.observabilityReason?.trim();
  return `downstream of the episode boundary: ${own ? own : DEFAULT_DOWNSTREAM_REASON}`;
}
