/**
 * Unit tests for combiner v2 (combine-v2.ts).
 *
 * Tests every rule independently and covers backward-compat severity mapping.
 * All inputs are pure data — no I/O, no filesystem.
 */

import { describe, it, expect } from 'vitest';
import {
  combineV2,
  collapseSingleCountVotes,
  effectiveSeverity,
  computeConfidenceV2,
} from './combine-v2.js';
import type { Vote } from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pastTime = '2024-01-01T00:00:00.000Z';
const laterTime = '2024-01-02T00:00:00.000Z';

const emptyArtifacts = { commits: [], prs: [], repo: null };
const withArtifacts = { commits: ['abc123'], prs: [], repo: null };

function makeVote(
  lf: string,
  vote: 1 | -1 | 0,
  strength: 'strong' | 'weak',
  opts: Partial<Vote> = {},
): Vote {
  return {
    lf,
    vote,
    strength,
    evidence: `${lf} evidence`,
    observed_at: pastTime,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// effectiveSeverity backward compat
// ---------------------------------------------------------------------------

describe('effectiveSeverity', () => {
  it('returns severity field when present', () => {
    const v = makeVote('test', -1, 'strong', { severity: 'critical' });
    expect(effectiveSeverity(v)).toBe('critical');
  });

  it('maps strong → major when severity absent', () => {
    const v = makeVote('test', -1, 'strong');
    expect(effectiveSeverity(v)).toBe('major');
  });

  it('maps weak → minor when severity absent', () => {
    const v = makeVote('test', -1, 'weak');
    expect(effectiveSeverity(v)).toBe('minor');
  });
});

// ---------------------------------------------------------------------------
// Rule 0: explicit_feedback
// ---------------------------------------------------------------------------

describe('combineV2 rule 0: explicit_feedback', () => {
  it('/good → succeeded 1.0 proven', () => {
    const r = combineV2({
      votes: [makeVote('error_tail', -1, 'strong', { severity: 'major' })],
      selfReport: 'none',
      artifacts: emptyArtifacts,
      explicit_feedback: 'good',
    });
    expect(r.label).toBe('succeeded');
    expect(r.confidence).toBe(1.0);
    expect(r.basis).toBe('proven');
  });

  it('/bad → failed 1.0 proven', () => {
    const r = combineV2({
      votes: [makeVote('pr_fate', 1, 'strong')],
      selfReport: 'none',
      artifacts: emptyArtifacts,
      explicit_feedback: 'bad',
    });
    expect(r.label).toBe('failed');
    expect(r.confidence).toBe(1.0);
    expect(r.basis).toBe('proven');
  });
});

// ---------------------------------------------------------------------------
// Rule 1: closure abort + no artifacts → interrupted
// ---------------------------------------------------------------------------

describe('combineV2 rule 1: interrupted', () => {
  it('closure abort with no artifacts → interrupted', () => {
    const r = combineV2({
      votes: [makeVote('closure', -1, 'strong', { severity: 'major' })],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('interrupted');
    expect(r.basis).toBe('proven');
  });

  it('closure abort WITH artifacts → not interrupted (falls through to rule 3)', () => {
    const r = combineV2({
      votes: [makeVote('closure', -1, 'strong', { severity: 'major' })],
      selfReport: 'none',
      artifacts: withArtifacts,
    });
    expect(r.label).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Rule 2: blocked
// ---------------------------------------------------------------------------

describe('combineV2 rule 2: blocked', () => {
  it('self_report=blocked → blocked', () => {
    const r = combineV2({
      votes: [],
      selfReport: 'blocked',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// Rule 3: critical/major negative not outweighed by later positive → failed
// ---------------------------------------------------------------------------

describe('combineV2 rule 3: critical/major negative', () => {
  it('major negative with no positive → failed', () => {
    const r = combineV2({
      votes: [makeVote('error_tail', -1, 'strong', { severity: 'major' })],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('failed');
    expect(r.basis).toBe('proven');
  });

  it('critical negative with no positive → failed', () => {
    const r = combineV2({
      votes: [makeVote('commit_survival', -1, 'strong', { severity: 'critical' })],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('failed');
  });

  it('major negative with LATER strong positive → not failed (rule 3 skipped)', () => {
    // Positive is later than negative: not unoutweighed
    const r = combineV2({
      votes: [
        makeVote('error_tail', -1, 'strong', { severity: 'major', observed_at: pastTime }),
        makeVote('pr_fate', 1, 'strong', { observed_at: laterTime }),
      ],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    // Rule 3 skipped → rule 5 applies (strong positive, no unoutweighed critical/major neg)
    expect(r.label).toBe('succeeded');
    expect(r.basis).toBe('proven');
  });

  it('major negative with EARLIER (not later) positive → failed (positive not later)', () => {
    const r = combineV2({
      votes: [
        makeVote('pr_fate', 1, 'strong', { observed_at: pastTime }),
        makeVote('error_tail', -1, 'strong', { severity: 'major', observed_at: laterTime }),
      ],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('failed');
  });

  it('strength-mapped major (strong without severity) → failed', () => {
    // Back-compat: strength=strong, no severity → mapped to major
    const r = combineV2({
      votes: [makeVote('error_tail', -1, 'strong')],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Rule 4: two or more minor negatives → failed
// ---------------------------------------------------------------------------

describe('combineV2 rule 4: two or more minor negatives', () => {
  it('two minor negatives → failed', () => {
    const r = combineV2({
      votes: [
        makeVote('in_session_correction', -1, 'weak', { severity: 'minor' }),
        makeVote('budget_cap', -1, 'weak', { severity: 'minor' }),
      ],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('failed');
    expect(r.basis).toBe('proven');
  });

  it('one minor negative → does not trigger rule 4', () => {
    const r = combineV2({
      votes: [makeVote('budget_cap', -1, 'weak', { severity: 'minor' })],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    // Falls through to rule 6/7/8 depending on settleWindowPassed
    expect(r.label).not.toBe('failed');
  });

  it('many fix_of_fix votes alone count once → not failed (design: fof never flips alone)', () => {
    const fof = (n: number): Vote =>
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: `PR #${n} mentions it` });
    const r = combineV2({
      votes: [fof(1), fof(2), fof(3), fof(4)],
      selfReport: 'done',
      artifacts: withArtifacts,
      settleWindowPassed: true,
    });
    // Collapsed to one minor negative → rule 7, not rule 4
    expect(r.label).toBe('succeeded');
    expect(r.confidence).toBe(0.3);
    expect(r.basis).toBe('no_bad_signals');
  });

  it('N fix_of_fix votes + strong positive → same confidence as one fix_of_fix', () => {
    const fof = (n: number): Vote =>
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: `PR #${n} mentions it` });
    const pos = makeVote('pr_fate', 1, 'strong');
    const one = combineV2({ votes: [pos, fof(1)], selfReport: 'done', artifacts: withArtifacts });
    const many = combineV2({
      votes: [pos, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(fof)],
      selfReport: 'done',
      artifacts: withArtifacts,
    });
    expect(one.label).toBe('succeeded');
    expect(one.basis).toBe('proven');
    expect(many.label).toBe('succeeded');
    expect(many.basis).toBe('proven');
    expect(one.confidence).toBe(0.92);
    expect(many.confidence).toBe(one.confidence);
  });

  it('one fix_of_fix plus a different minor negative → still failed', () => {
    const r = combineV2({
      votes: [
        makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #1' }),
        makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #2' }),
        makeVote('budget_cap', -1, 'weak', { severity: 'minor' }),
      ],
      selfReport: 'none',
      artifacts: withArtifacts,
    });
    expect(r.label).toBe('failed');
  });

  it('two red-CI votes from the same ci LF still count twice → failed', () => {
    const r = combineV2({
      votes: [
        makeVote('ci', -1, 'weak', { evidence: 'gh pr checks PR-1: failed' }),
        makeVote('ci', -1, 'weak', { evidence: 'gh pr checks PR-2: failed' }),
      ],
      selfReport: 'none',
      artifacts: withArtifacts,
    });
    expect(r.label).toBe('failed');
  });

  it('strength-mapped minor (weak without severity) counted for rule 4', () => {
    const r = combineV2({
      votes: [
        makeVote('cross_session_reask', -1, 'weak'),
        makeVote('budget_cap', -1, 'weak'),
      ],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Rule 5: strong positive + no major/critical negative → succeeded (proven)
// ---------------------------------------------------------------------------

describe('combineV2 rule 5: strong positive proven', () => {
  it('strong positive, no negatives → succeeded proven', () => {
    const r = combineV2({
      votes: [makeVote('verification', 1, 'strong')],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('succeeded');
    expect(r.basis).toBe('proven');
  });

  it('strong positive + minor negative → succeeded proven (minor does not block rule 5)', () => {
    const r = combineV2({
      votes: [
        makeVote('verification', 1, 'strong'),
        makeVote('budget_cap', -1, 'weak', { severity: 'minor' }),
      ],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('succeeded');
    expect(r.basis).toBe('proven');
  });
});

// ---------------------------------------------------------------------------
// Rule 6: good-by-default (no negatives, past settle window)
// ---------------------------------------------------------------------------

describe('combineV2 rule 6: good-by-default', () => {
  it('no negatives + settleWindowPassed + done → succeeded 0.6 no_bad_signals', () => {
    const r = combineV2({
      votes: [makeVote('self_report', 0, 'weak')],
      selfReport: 'done',
      artifacts: emptyArtifacts,
      settleWindowPassed: true,
    });
    expect(r.label).toBe('succeeded');
    expect(r.confidence).toBe(0.6);
    expect(r.basis).toBe('no_bad_signals');
  });

  it('no negatives + settleWindowPassed + none self_report → succeeded 0.5', () => {
    const r = combineV2({
      votes: [],
      selfReport: 'none',
      artifacts: emptyArtifacts,
      settleWindowPassed: true,
    });
    expect(r.label).toBe('succeeded');
    expect(r.confidence).toBe(0.5);
    expect(r.basis).toBe('no_bad_signals');
  });

  it('no negatives + settleWindowPassed NOT passed → unknown', () => {
    const r = combineV2({
      votes: [],
      selfReport: 'none',
      artifacts: emptyArtifacts,
      settleWindowPassed: false,
    });
    expect(r.label).toBe('unknown');
  });

  it('no negatives + settleWindowPassed absent → unknown', () => {
    const r = combineV2({
      votes: [],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('unknown');
  });

  it('normal closure required (abnormal closure skips rule 6)', () => {
    const r = combineV2({
      votes: [],
      selfReport: 'none',
      artifacts: emptyArtifacts,
      settleWindowPassed: true,
      normalClosure: false,
    });
    // normalClosure=false skips rules 6 and 7
    expect(r.label).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Rule 7: one minor negative + past window → succeeded 0.3
// ---------------------------------------------------------------------------

describe('combineV2 rule 7: one minor past window', () => {
  it('one minor negative + settleWindowPassed → succeeded 0.3 no_bad_signals', () => {
    const r = combineV2({
      votes: [makeVote('budget_cap', -1, 'weak', { severity: 'minor' })],
      selfReport: 'none',
      artifacts: emptyArtifacts,
      settleWindowPassed: true,
    });
    expect(r.label).toBe('succeeded');
    expect(r.confidence).toBe(0.3);
    expect(r.basis).toBe('no_bad_signals');
  });

  it('one minor + one major → rule 3 fires first (major unoutweighed)', () => {
    const r = combineV2({
      votes: [
        makeVote('budget_cap', -1, 'weak', { severity: 'minor' }),
        makeVote('error_tail', -1, 'strong', { severity: 'major' }),
      ],
      selfReport: 'none',
      artifacts: emptyArtifacts,
      settleWindowPassed: true,
    });
    expect(r.label).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Rule 8: unknown
// ---------------------------------------------------------------------------

describe('combineV2 rule 8: unknown', () => {
  it('no votes + no settle window → unknown', () => {
    const r = combineV2({
      votes: [],
      selfReport: 'none',
      artifacts: emptyArtifacts,
    });
    expect(r.label).toBe('unknown');
    expect(r.confidence).toBe(0);
    expect(r.basis).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collapseSingleCountVotes
// ---------------------------------------------------------------------------

describe('collapseSingleCountVotes', () => {
  it('collapses multiple fix_of_fix negative votes to one', () => {
    const votes = [
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #1' }),
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #2' }),
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #3' }),
    ];
    const result = collapseSingleCountVotes(votes);
    expect(result).toHaveLength(1);
    expect(result[0]!.lf).toBe('fix_of_fix');
    expect(result[0]!.evidence).toBe('PR #1'); // first one kept
  });

  it('passes through a single fix_of_fix vote unchanged', () => {
    const votes = [
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #1' }),
    ];
    const result = collapseSingleCountVotes(votes);
    expect(result).toHaveLength(1);
  });

  it('does not collapse non-SINGLE_COUNT_LFS votes (e.g. ci)', () => {
    const votes = [
      makeVote('ci', -1, 'weak', { evidence: 'PR-1 failed' }),
      makeVote('ci', -1, 'weak', { evidence: 'PR-2 failed' }),
    ];
    const result = collapseSingleCountVotes(votes);
    expect(result).toHaveLength(2);
  });

  it('passes through fix_of_fix votes with vote !== -1 (non-negative guard)', () => {
    // If lf-fof ever gains a positive emission path, those votes must not be collapsed
    const votes = [
      makeVote('fix_of_fix', 1, 'weak', { evidence: 'hypothetical positive #1' }),
      makeVote('fix_of_fix', 1, 'weak', { evidence: 'hypothetical positive #2' }),
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #3' }),
    ];
    const result = collapseSingleCountVotes(votes);
    // Both positive votes pass through; the single negative vote is kept
    expect(result).toHaveLength(3);
    const positives = result.filter((v) => v.vote === 1);
    const negatives = result.filter((v) => v.vote === -1);
    expect(positives).toHaveLength(2);
    expect(negatives).toHaveLength(1);
    // Evidence fields must be preserved exactly — collapsing must never strip metadata
    expect(positives[0]!.evidence).toBe('hypothetical positive #1');
    expect(positives[1]!.evidence).toBe('hypothetical positive #2');
    expect(negatives[0]!.evidence).toBe('PR #3');
  });

  it('passes through fix_of_fix votes with vote === 0 (abstain) without collapsing', () => {
    // vote === 0 (abstain) is not emitted by any LF today but the guard
    // `v.vote !== -1` must pass it through unconditionally — abstains must
    // never be silently de-duplicated if a future LF emits them.
    const votes = [
      makeVote('fix_of_fix', 0, 'weak', { evidence: 'hypothetical abstain #1' }),
      makeVote('fix_of_fix', 0, 'weak', { evidence: 'hypothetical abstain #2' }),
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #3' }),
    ];
    const result = collapseSingleCountVotes(votes);
    // Both abstain votes pass through; the single negative is kept (first seen)
    expect(result).toHaveLength(3);
    const abstains = result.filter((v) => v.vote === 0);
    const negatives = result.filter((v) => v.vote === -1);
    expect(abstains).toHaveLength(2);
    expect(negatives).toHaveLength(1);
  });

  it('handles mixed lf names: collapses fix_of_fix independently of other lfs', () => {
    const votes = [
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #1' }),
      makeVote('fix_of_fix', -1, 'weak', { severity: 'minor', evidence: 'PR #2' }),
      makeVote('budget_cap', -1, 'weak', { severity: 'minor' }),
      makeVote('budget_cap', -1, 'weak', { severity: 'minor' }),
    ];
    const result = collapseSingleCountVotes(votes);
    // fix_of_fix collapses to 1; budget_cap is not in SINGLE_COUNT_LFS → both kept
    const fof = result.filter((v) => v.lf === 'fix_of_fix');
    const bc = result.filter((v) => v.lf === 'budget_cap');
    expect(fof).toHaveLength(1);
    expect(bc).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// computeConfidenceV2
// ---------------------------------------------------------------------------

describe('computeConfidenceV2', () => {
  it('unknown → 0', () => {
    expect(computeConfidenceV2('unknown', [])).toBe(0);
  });

  it('one strong positive agreeing, no disagreers → 1.0', () => {
    const votes = [makeVote('v', 1, 'strong')];
    expect(computeConfidenceV2('succeeded', votes)).toBe(1.0);
  });

  it('penalises critical disagreer by 0.2', () => {
    const votes = [
      makeVote('pos', 1, 'strong'),
      makeVote('neg', -1, 'strong', { severity: 'critical' }),
    ];
    // base = 0.5 (1 of 2 strong agree), penalty from critical = 0.2
    expect(computeConfidenceV2('succeeded', votes)).toBe(0.3);
  });

  it('penalises major disagreer by 0.15', () => {
    const votes = [
      makeVote('pos', 1, 'strong'),
      makeVote('neg', -1, 'strong', { severity: 'major' }),
    ];
    // base = 0.5, penalty = 0.15
    expect(computeConfidenceV2('succeeded', votes)).toBe(0.35);
  });

  it('penalises minor disagreer by 0.08', () => {
    const votes = [
      makeVote('pos', 1, 'strong'),
      makeVote('neg', -1, 'weak', { severity: 'minor' }),
    ];
    // base = 1.0 (only strong vote agrees), penalty = 0.08
    expect(computeConfidenceV2('succeeded', votes)).toBe(0.92);
  });

  it('floors at 0', () => {
    const votes = [
      makeVote('pos', 1, 'strong'),
      makeVote('c1', -1, 'strong', { severity: 'critical' }),
      makeVote('c2', -1, 'strong', { severity: 'critical' }),
      makeVote('c3', -1, 'strong', { severity: 'critical' }),
    ];
    expect(computeConfidenceV2('succeeded', votes)).toBe(0);
  });
});
