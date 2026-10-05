/**
 * Combiner v1 — ordered rules + confidence calculation.
 *
 * Evaluated top to bottom; first match wins:
 *   1. closure=abort and no artifacts → interrupted
 *   2. self_report == blocked         → blocked
 *   3. Any strong -1 and no later strong +1 → failed
 *   4. Any strong +1 and no strong -1      → succeeded
 *   5. Otherwise                           → unknown
 *
 * Confidence = strong votes agreeing ÷ strong votes cast,
 *   discounted by 0.2 for each weak vote that disagrees.
 *   unknown → 0.
 *
 * explicit_feedback overrides the combiner entirely: /good → succeeded (1.0),
 * /bad → failed (1.0), settled immediately.
 */

import type { Vote, OutcomeLabel, SelfReport, Artifacts } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CombinerInput {
  votes: Vote[];
  selfReport: SelfReport;
  artifacts: Artifacts;
  explicit_feedback?: 'good' | 'bad'; // M0 has no source; supported for completeness
}

export interface CombinerResult {
  label: OutcomeLabel;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Vote helpers
// ---------------------------------------------------------------------------

function strongVotes(votes: Vote[]): Vote[] {
  return votes.filter((v) => v.strength === 'strong');
}

function hasStrongPositive(votes: Vote[]): boolean {
  return strongVotes(votes).some((v) => v.vote === 1);
}

function hasStrongNegative(votes: Vote[]): boolean {
  return strongVotes(votes).some((v) => v.vote === -1);
}

function hasClosureAbort(votes: Vote[]): boolean {
  return votes.some((v) => v.lf === 'closure' && v.vote === -1);
}

function hasArtifacts(artifacts: Artifacts): boolean {
  return artifacts.commits.length > 0 || artifacts.prs.length > 0;
}

// ---------------------------------------------------------------------------
// Confidence calculation
// ---------------------------------------------------------------------------

/**
 * Compute confidence in [0, 1].
 *
 * Base: strong votes agreeing with the chosen label ÷ strong votes cast.
 * Penalty: 0.2 per weak vote that disagrees with the chosen label.
 * unknown always returns 0.
 */
export function computeConfidence(
  label: OutcomeLabel,
  votes: Vote[],
): number {
  if (label === 'unknown') return 0;

  const sVotes = strongVotes(votes);
  if (sVotes.length === 0) return 0;

  // Determine "agreeing" direction for this label
  const agreeDir: 1 | -1 =
    label === 'succeeded' ? 1
    : label === 'failed' ? -1
    : label === 'interrupted' ? -1
    : label === 'blocked' ? -1
    : 1;

  const agreeing = sVotes.filter((v) => v.vote === agreeDir).length;
  const base = agreeing / sVotes.length;

  // Penalty from weak disagreers
  const weakDisagree = votes.filter(
    (v) => v.strength === 'weak' && v.vote !== 0 && v.vote !== agreeDir,
  ).length;

  const confidence = Math.max(0, base - weakDisagree * 0.2);
  return Math.round(confidence * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main combiner
// ---------------------------------------------------------------------------

export function combine(input: CombinerInput): CombinerResult {
  const { votes, selfReport, artifacts } = input;

  // Explicit feedback overrides everything (M0 has no source, but combiner
  // respects it when present so M2+ can pass it through unchanged)
  if (input.explicit_feedback === 'good') {
    return { label: 'succeeded', confidence: 1.0 };
  }
  if (input.explicit_feedback === 'bad') {
    return { label: 'failed', confidence: 1.0 };
  }

  // Rule 1: abort closure + no artifacts → interrupted
  if (hasClosureAbort(votes) && !hasArtifacts(artifacts)) {
    return {
      label: 'interrupted',
      confidence: computeConfidence('interrupted', votes),
    };
  }

  // Rule 2: self_report == blocked → blocked
  if (selfReport === 'blocked') {
    return {
      label: 'blocked',
      confidence: computeConfidence('blocked', votes),
    };
  }

  // Rule 3: any strong -1 and no later strong +1 → failed
  if (hasStrongNegative(votes) && !hasStrongPositive(votes)) {
    return {
      label: 'failed',
      confidence: computeConfidence('failed', votes),
    };
  }

  // Rule 4: any strong +1 and no strong -1 → succeeded
  if (hasStrongPositive(votes) && !hasStrongNegative(votes)) {
    return {
      label: 'succeeded',
      confidence: computeConfidence('succeeded', votes),
    };
  }

  // Rule 5: unknown
  return { label: 'unknown', confidence: 0 };
}
