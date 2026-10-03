/**
 * Deterministic capability-fit classifier for the what-if prediction engine.
 *
 * Before `--verify` spends money, this module answers:
 *   "Can this experiment actually measure what the user wants to know?"
 *
 * Episodes stop at the agent's first side-effecting action (decision-only
 * runner), so some question types are structurally unmeasurable regardless of
 * episode count or budget.  The classifier uses the predict-time
 * `observable` tags already attached to each prediction (#2409) — no model
 * call, no I/O.
 *
 * ## Support levels
 *
 * - `supported`          — every prediction is `'decision'`; all are measurable.
 * - `partially-supported`— mix of `'decision'` and `'downstream'`; some cannot
 *                          be confirmed or refuted.
 * - `unsupported`        — every prediction is `'downstream'`; none measurable.
 *
 * When there are no predictions (the analyst found no expected behavior change)
 * the level is `'supported'` and a note is added so the user understands the
 * experiment will not produce confirmation signal.
 *
 * ## Usage
 *
 * Call `classifyQuestionFit(predictions)` after the predict phase and emit the
 * returned `QuestionFitResult` via `onProgress` (stage `'preflight'`) before
 * `--verify` starts episodes.  The same notice is shown on the predict-only
 * path so users understand the limitation before they re-run with `--verify`.
 *
 * @module whatif/question-fit
 */

import type { Prediction } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The three support levels for a what-if experiment's intended question.
 *
 * - `'supported'`           All predictions are decision-observable.
 * - `'partially-supported'` Mix of decision and downstream predictions.
 * - `'unsupported'`         All predictions are downstream-only.
 */
export type QuestionFitLevel = 'supported' | 'partially-supported' | 'unsupported';

export interface QuestionFitResult {
  level: QuestionFitLevel;
  /**
   * Count of predictions tagged 'decision' (measurable by the decision-only
   * runner).
   */
  decisionCount: number;
  /**
   * Count of predictions tagged 'downstream' (unmeasurable; require an action
   * to complete before the behavior is visible).
   */
  downstreamCount: number;
  /**
   * One or two human-readable lines explaining what can and cannot be
   * measured.  Suitable for direct use in `onProgress` messages.
   */
  lines: readonly string[];
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify how well the runner's decision-only episode model can answer the
 * experiment's implied question.
 *
 * Deterministic: no model calls, no I/O.  Operates entirely on the
 * `observable` tags already assigned by `predictChanges` (#2409).
 *
 * Predictions whose `observable` field is absent default to `'decision'`
 * (backward-compatible with older fixtures that lack the field).
 *
 * @param predictions  Predictions from the predict phase.
 */
export function classifyQuestionFit(predictions: readonly Prediction[]): QuestionFitResult {
  let decisionCount = 0;
  let downstreamCount = 0;

  for (const p of predictions) {
    // Absent tag (older fixtures) defaults to 'decision'.
    if ((p.observable ?? 'decision') === 'downstream') {
      downstreamCount++;
    } else {
      decisionCount++;
    }
  }

  const total = predictions.length;

  // ── No predictions ────────────────────────────────────────────────────────
  if (total === 0) {
    // Invariant: an empty prediction set returns 'supported' by convention —
    // "nothing is measurable" is indistinguishable from "everything is measurable"
    // when there are no predictions to classify.  The accompanying line makes
    // the vacuous nature explicit so users understand the experiment will produce
    // no confirmation signal even though the level string reads 'supported'.
    return {
      level: 'supported',
      decisionCount: 0,
      downstreamCount: 0,
      lines: [
        '[question-fit] supported — no behavior changes predicted; experiment will show no confirmation signal.',
      ],
    };
  }

  // ── All downstream ────────────────────────────────────────────────────────
  if (decisionCount === 0) {
    const reasons = buildDownstreamReasons(predictions);
    return {
      level: 'unsupported',
      decisionCount: 0,
      downstreamCount,
      lines: [
        `[question-fit] unsupported — all ${total} prediction(s) require an action to complete before they are visible.`,
        `  Episodes stop at the first side-effecting action, so verification cannot confirm or refute any of them.`,
        ...(reasons.length > 0 ? [`  ${reasons.join('; ')}.`] : []),
        `  Consider rephrasing your question as a decision: e.g. "Does the agent choose to …?" instead of "Does the result …?".`,
      ],
    };
  }

  // ── All decision ──────────────────────────────────────────────────────────
  if (downstreamCount === 0) {
    return {
      level: 'supported',
      decisionCount,
      downstreamCount: 0,
      lines: [
        `[question-fit] supported — all ${total} prediction(s) are measurable as agent decisions.`,
      ],
    };
  }

  // ── Mixed ─────────────────────────────────────────────────────────────────
  const reasons = buildDownstreamReasons(predictions);
  return {
    level: 'partially-supported',
    decisionCount,
    downstreamCount,
    lines: [
      `[question-fit] partially-supported — ${decisionCount} of ${total} prediction(s) are measurable; ` +
        `${downstreamCount} require a completed action and will be marked 🔭 Unobservable.`,
      ...(reasons.length > 0 ? [`  Unobservable: ${reasons.join('; ')}.`] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collect brief labels for downstream predictions to make the notice concrete.
 * Uses the `observabilityReason` when present, otherwise the prediction's
 * `behavior` text (truncated for readability).
 */
function buildDownstreamReasons(predictions: readonly Prediction[]): string[] {
  return predictions
    .filter((p) => (p.observable ?? 'decision') === 'downstream')
    .map((p) => {
      const label = p.observabilityReason?.trim() || truncate(p.behavior, 60);
      return `"${label}"`;
    });
}

/** Truncate a string to maxChars, appending '…' when over the limit. */
function truncate(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : s.slice(0, maxChars - 1) + '…';
}
