/**
 * Combiner — delegates to combiner v2 while re-exporting the v1 helpers
 * (`computeConfidence`) for backward compatibility with existing tests.
 *
 * The public `combine()` function now invokes combiner v2 internally.
 * Callers that need severity-aware results directly should import from
 * combine-v2.ts. This file exists purely as the stable import surface used
 * by store.ts and the rest of the codebase.
 *
 * v2 rules (first match wins):
 *   0. explicit_feedback override (/good → succeeded 1.0, /bad → failed 1.0)
 *   1. closure=abort and no artifacts → interrupted
 *   2. self_report == blocked → blocked
 *   3. critical/major negative not outweighed by later strong positive → failed
 *   4. Two or more minor negatives → failed
 *   5. Strong positive and no major/critical negative → succeeded (proven)
 *   6. Good-by-default (past settle window, normal closure, no negatives)
 *   7. One minor negative past window → succeeded 0.3 (no_bad_signals)
 *   8. Otherwise → unknown
 */

import type { Vote, OutcomeLabel, SelfReport, Artifacts } from './schema.js';
import { combineV2 } from './combine-v2.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CombinerInput {
  votes: Vote[];
  selfReport: SelfReport;
  artifacts: Artifacts;
  explicit_feedback?: 'good' | 'bad'; // M0 has no source; supported for completeness
  /** Whether the settle window has passed (used by v2 good-by-default rule). */
  settleWindowPassed?: boolean;
  /** Whether the closure was normal (used by v2 good-by-default rule). */
  normalClosure?: boolean;
}

export interface CombinerResult {
  label: OutcomeLabel;
  confidence: number;
  /** How the label was established. Absent on unknown/blocked. */
  basis?: 'proven' | 'no_bad_signals';
}

// ---------------------------------------------------------------------------
// Vote helpers (kept for backward compat and tests)
// ---------------------------------------------------------------------------

function strongVotes(votes: Vote[]): Vote[] {
  return votes.filter((v) => v.strength === 'strong');
}

// ---------------------------------------------------------------------------
// Confidence calculation (v1 — kept for backward compat with existing tests)
// ---------------------------------------------------------------------------

/**
 * Compute confidence in [0, 1].
 *
 * Base: strong votes agreeing with the chosen label ÷ strong votes cast.
 * Penalty: 0.2 per weak vote that disagrees with the chosen label.
 * unknown always returns 0.
 *
 * Retained for backward compatibility. New code should use computeConfidenceV2
 * from combine-v2.ts which applies severity-based penalties.
 */
export function computeConfidence(
  label: OutcomeLabel,
  votes: Vote[],
): number {
  if (label === 'unknown') return 0;

  const sVotes = strongVotes(votes);
  if (sVotes.length === 0) return 0;

  const agreeDir: 1 | -1 =
    label === 'succeeded' ? 1
    : label === 'failed' ? -1
    : label === 'interrupted' ? -1
    : label === 'blocked' ? -1
    : 1;

  const agreeing = sVotes.filter((v) => v.vote === agreeDir).length;
  const base = agreeing / sVotes.length;

  const weakDisagree = votes.filter(
    (v) => v.strength === 'weak' && v.vote !== 0 && v.vote !== agreeDir,
  ).length;

  const confidence = Math.max(0, base - weakDisagree * 0.2);
  return Math.round(confidence * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main combiner — delegates to combiner v2
// ---------------------------------------------------------------------------

/**
 * Evaluate the combiner rules and return a label + confidence + basis.
 *
 * Delegates to combiner v2. The v1 computeConfidence helper above is retained
 * for tests that cover the confidence calculation in isolation.
 */
export function combine(input: CombinerInput): CombinerResult {
  return combineV2({
    votes: input.votes,
    selfReport: input.selfReport,
    artifacts: input.artifacts,
    explicit_feedback: input.explicit_feedback,
    settleWindowPassed: input.settleWindowPassed,
    normalClosure: input.normalClosure,
  });
}
