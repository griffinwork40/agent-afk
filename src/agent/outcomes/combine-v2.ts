/**
 * Combiner v2 — severity-aware outcome combiner.
 *
 * Ordered rules (first match wins):
 *   0. explicit_feedback override  (/good → succeeded 1.0, /bad → failed 1.0)
 *   1. interrupted: closure=abort and no artifacts → interrupted
 *   2. blocked: self_report == blocked → blocked
 *   3. critical or major negative not outweighed by a later strong positive → failed
 *   4. Two or more minor negatives → failed
 *   5. Strong positive and no major/critical negative → succeeded (proven)
 *   6. Good-by-default: past settle window, normal closure, no negatives
 *      → succeeded (no_bad_signals) with lower confidence
 *   7. Exactly one minor negative (past settle window) → succeeded (0.3)
 *   8. Otherwise → unknown
 *
 * Backward compatibility: votes without `severity` are back-mapped via strength:
 *   strong → major, weak → minor
 *
 * The combiner is a pure function — no I/O, no side effects.
 *
 * @module agent/outcomes/combine-v2
 */

import type { Vote, OutcomeLabel, SelfReport, Artifacts, VoteSeverity } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CombinerV2Input {
  votes: Vote[];
  selfReport: SelfReport;
  artifacts: Artifacts;
  explicit_feedback?: 'good' | 'bad';
  /**
   * Whether the settle window has passed. Required for good-by-default rule.
   * When absent (undefined), rules 6 and 7 are skipped.
   */
  settleWindowPassed?: boolean;
  /**
   * Whether the closure was normal (not abort, not iteration_cap).
   * Required for good-by-default rule. Defaults to true when absent.
   */
  normalClosure?: boolean;
}

export interface CombinerV2Result {
  label: OutcomeLabel;
  confidence: number;
  /** How the label was established. Absent on unknown/blocked. */
  basis?: 'proven' | 'no_bad_signals';
}

// ---------------------------------------------------------------------------
// Severity resolution (backward compat)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective severity of a vote. Votes without `severity` are
 * back-mapped from `strength`: strong → major, weak → minor.
 */
export function effectiveSeverity(vote: Vote): VoteSeverity {
  if (vote.severity !== undefined) return vote.severity;
  return vote.strength === 'strong' ? 'major' : 'minor';
}

// ---------------------------------------------------------------------------
// Vote helpers
// ---------------------------------------------------------------------------

function negativeVotes(votes: Vote[]): Vote[] {
  return votes.filter((v) => v.vote === -1);
}

function positiveVotes(votes: Vote[]): Vote[] {
  return votes.filter((v) => v.vote === 1);
}

function hasStrongPositive(votes: Vote[]): boolean {
  return votes.some((v) => v.vote === 1 && v.strength === 'strong');
}

function hasClosureAbort(votes: Vote[]): boolean {
  return votes.some((v) => v.lf === 'closure' && v.vote === -1);
}

function hasArtifacts(artifacts: Artifacts): boolean {
  return artifacts.commits.length > 0 || artifacts.prs.length > 0;
}

/**
 * True if there is a strong positive whose observed_at is LATER than the
 * given negative vote's observed_at. "Later" means string comparison on
 * ISO-8601 strings (lexicographic, which equals chronological for UTC).
 */
function hasLaterStrongPositive(votes: Vote[], negVote: Vote): boolean {
  return positiveVotes(votes).some(
    (pos) => pos.strength === 'strong' && pos.observed_at > negVote.observed_at,
  );
}

// ---------------------------------------------------------------------------
// Confidence calculation (v2 — severity-aware)
// ---------------------------------------------------------------------------

/**
 * Compute confidence in [0, 1] for combiner v2.
 *
 * Proven path: ratio of agreeing strong votes to total strong votes, penalised
 * 0.15 per critical/major disagreer and 0.08 per minor disagreer.
 * unknown always returns 0.
 */
export function computeConfidenceV2(
  label: OutcomeLabel,
  votes: Vote[],
): number {
  if (label === 'unknown') return 0;

  const agreeDir: 1 | -1 =
    label === 'succeeded' ? 1
    : label === 'failed' ? -1
    : label === 'interrupted' ? -1
    : label === 'blocked' ? -1
    : 1;

  const strongVotes = votes.filter((v) => v.strength === 'strong');
  if (strongVotes.length === 0) return 0;

  const agreeing = strongVotes.filter((v) => v.vote === agreeDir).length;
  const base = agreeing / strongVotes.length;

  // Penalty by severity of disagreeing votes
  let penalty = 0;
  for (const v of votes) {
    if (v.vote === 0 || v.vote === agreeDir) continue;
    const sev = effectiveSeverity(v);
    if (sev === 'critical') penalty += 0.2;
    else if (sev === 'major') penalty += 0.15;
    else penalty += 0.08;
  }

  return Math.max(0, Math.round((base - penalty) * 100) / 100);
}

// ---------------------------------------------------------------------------
// Main combiner v2
// ---------------------------------------------------------------------------

export function combineV2(input: CombinerV2Input): CombinerV2Result {
  const { votes, selfReport, artifacts, settleWindowPassed, normalClosure = true } = input;

  // Rule 0: Explicit feedback overrides everything
  if (input.explicit_feedback === 'good') {
    return { label: 'succeeded', confidence: 1.0, basis: 'proven' };
  }
  if (input.explicit_feedback === 'bad') {
    return { label: 'failed', confidence: 1.0, basis: 'proven' };
  }

  const negVotes = negativeVotes(votes);

  // Rule 1: abort closure + no artifacts → interrupted
  if (hasClosureAbort(votes) && !hasArtifacts(artifacts)) {
    return {
      label: 'interrupted',
      confidence: computeConfidenceV2('interrupted', votes),
      basis: 'proven',
    };
  }

  // Rule 2: self_report == blocked → blocked
  if (selfReport === 'blocked') {
    return {
      label: 'blocked',
      confidence: computeConfidenceV2('blocked', votes),
    };
  }

  // Partition negative votes by severity
  const critOrMajNeg = negVotes.filter((v) => {
    const sev = effectiveSeverity(v);
    return sev === 'critical' || sev === 'major';
  });
  const minorNeg = negVotes.filter((v) => effectiveSeverity(v) === 'minor');

  // Rule 3: critical or major negative not outweighed by a later strong positive → failed
  const unoutweighedCritMaj = critOrMajNeg.filter(
    (v) => !hasLaterStrongPositive(votes, v),
  );
  if (unoutweighedCritMaj.length > 0) {
    return {
      label: 'failed',
      confidence: computeConfidenceV2('failed', votes),
      basis: 'proven',
    };
  }

  // Rule 4: two or more minor negatives → failed
  if (minorNeg.length >= 2) {
    return {
      label: 'failed',
      confidence: computeConfidenceV2('failed', votes),
      basis: 'proven',
    };
  }

  // Rule 5: strong positive and no UNOUTWEIGHED major/critical negative → succeeded (proven)
  // A major/critical negative that IS outweighed by a later strong positive (rule 3 spared it)
  // does not block rule 5.
  if (hasStrongPositive(votes) && unoutweighedCritMaj.length === 0) {
    return {
      label: 'succeeded',
      confidence: computeConfidenceV2('succeeded', votes),
      basis: 'proven',
    };
  }

  // Rules 6 & 7 only apply after the settle window has passed
  if (settleWindowPassed === true && normalClosure) {
    // Rule 6: no negative votes at all → good-by-default
    if (negVotes.length === 0) {
      // Confidence 0.6 when self_report is done, 0.5 otherwise
      const confidence = selfReport === 'done' ? 0.6 : 0.5;
      return { label: 'succeeded', confidence, basis: 'no_bad_signals' };
    }

    // Rule 7: exactly one minor negative → succeeded at low confidence
    if (minorNeg.length === 1 && critOrMajNeg.length === 0) {
      return { label: 'succeeded', confidence: 0.3, basis: 'no_bad_signals' };
    }
  }

  // Rule 8: unknown
  return { label: 'unknown', confidence: 0 };
}
