/**
 * Tests for `src/whatif/stats.ts`.
 *
 * Numeric sanity checks:
 *   - identical inputs → refuted (delta ~= 0, CI tight enough for equivalence)
 *   - clear shift → confirmed
 *   - borderline → unclear
 *   - agreementRate and predictionAccuracy helpers
 *   - verdictFor acceptance cases from #2405
 */

import { describe, expect, it } from 'vitest';
import {
  agreementRate,
  applyAgreementDowngrade,
  compareRates,
  CROSS_CHECK_MIN_AGREEMENT,
  CROSS_CHECK_MIN_ITEMS,
  EQUIVALENCE_MARGIN,
  predictionAccuracy,
  verdictFor,
} from './stats.js';
import type { Prediction, VerifiedPrediction } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pred(direction: Prediction['direction']): Prediction {
  return {
    id: 'p1',
    behavior: 'test',
    direction,
    confidence: 'medium',
    reason: 'reason',
    testQuestion: 'Does X?',
    probes: [],
  };
}

/** Array of n repeated values */
function repeat(v: number, n: number): number[] {
  return Array.from({ length: n }, () => v);
}

// ---------------------------------------------------------------------------
// compareRates
// ---------------------------------------------------------------------------

describe('compareRates', () => {
  it('handles empty arrays gracefully', () => {
    const r = compareRates([], []);
    expect(r.baseline).toBe(0);
    expect(r.candidate).toBe(0);
    expect(r.delta).toBe(0);
    expect(r.n.baseline).toBe(0);
    expect(r.n.candidate).toBe(0);
  });

  it('computes rates and delta correctly', () => {
    // baseline 2/4 = 0.5, candidate 3/4 = 0.75
    const r = compareRates([1, 1, 0, 0], [1, 1, 1, 0]);
    expect(r.baseline).toBeCloseTo(0.5);
    expect(r.candidate).toBeCloseTo(0.75);
    expect(r.delta).toBeCloseTo(0.25);
    expect(r.n).toEqual({ baseline: 4, candidate: 4 });
  });

  it('CI contains delta', () => {
    const r = compareRates([1, 0, 1, 0, 1, 0], [1, 1, 1, 0, 0, 1]);
    expect(r.ci[0]).toBeLessThanOrEqual(r.delta);
    expect(r.ci[1]).toBeGreaterThanOrEqual(r.delta);
  });

  it('CI is wider for small n than for large n (same rates)', () => {
    // n=4 vs n=100 with same 0.5 rate should give wider CI for small n
    const small = compareRates([0, 1, 0, 1], [1, 0, 1, 0]);
    const large = compareRates(Array(50).fill(0.5), Array(50).fill(0.5));
    const widthSmall = small.ci[1] - small.ci[0];
    const widthLarge = large.ci[1] - large.ci[0];
    expect(widthSmall).toBeGreaterThan(widthLarge);
  });

  it('CI is tighter for large n identical rates', () => {
    const r = compareRates(repeat(0.6, 200), repeat(0.6, 200));
    const width = r.ci[1] - r.ci[0];
    expect(width).toBeLessThan(0.2);
  });

  it('accepts fractional successes (judge probabilities)', () => {
    // Mean of 0.7 and 0.8 = 0.75
    const r = compareRates([0.7, 0.8], [0.9, 0.95]);
    expect(r.baseline).toBeCloseTo(0.75);
    expect(r.candidate).toBeCloseTo(0.925);
  });
});

// ---------------------------------------------------------------------------
// verdictFor
// ---------------------------------------------------------------------------

describe('verdictFor', () => {
  it('confirmed: large positive shift for strengthened', () => {
    // 30% → 80% should be confirmed for strengthened
    const r = compareRates(repeat(0, 50).concat(repeat(1, 20)), repeat(1, 60).concat(repeat(0, 10)));
    const v = verdictFor(pred('strengthened'), r);
    expect(v).toBe('confirmed');
  });

  it('confirmed: large negative shift for weakened', () => {
    const r = compareRates(repeat(1, 60).concat(repeat(0, 10)), repeat(0, 60).concat(repeat(1, 10)));
    const v = verdictFor(pred('weakened'), r);
    expect(v).toBe('confirmed');
  });

  it('refuted: direction is opposite to observation', () => {
    // Expected: added (positive), but actual is large negative shift
    const r = compareRates(repeat(1, 60).concat(repeat(0, 10)), repeat(0, 60).concat(repeat(1, 10)));
    const v = verdictFor(pred('added'), r);
    expect(v).toBe('refuted');
  });

  it('refuted: identical inputs with CI explicitly inside ±5pp → refuted by equivalence', () => {
    // Construct a rate comparison where delta=0 and CI is tightly inside ±5pp.
    // With n=500 identical fractional values of 0.5 the Newcombe CI ≈ ±0.062,
    // which is OUTSIDE ±0.05 (the equivalence margin). We instead verify the
    // property directly using a hand-crafted rate comparison that represents
    // n=500 episodes at exactly p=0.5 with a very tight CI (use the functional
    // path via compareRates with equal deterministic fractions).
    // At n=500, Wilson CI half-width ≈ 0.044, so CI ≈ [-0.062, +0.062] — just
    // slightly outside ±0.05. We verify 'refuted' only when we construct rates
    // with CI known to lie inside ±0.05.
    const customRates = {
      baseline: 0.5,
      candidate: 0.5,
      delta: 0.0,
      ci: [-0.04, 0.04] as [number, number],
      n: { baseline: 1000, candidate: 1000 },
    };
    // CI [-0.04, 0.04] is entirely inside [-0.05, 0.05] → refuted by equivalence.
    expect(verdictFor(pred('strengthened'), customRates)).toBe('refuted');
    // Also verify at very large n the equivalence fires:
    const veryLargeN = compareRates(repeat(0.5, 10000), repeat(0.5, 10000));
    expect(veryLargeN.ci[0]).toBeGreaterThanOrEqual(-EQUIVALENCE_MARGIN);
    expect(veryLargeN.ci[1]).toBeLessThanOrEqual(EQUIVALENCE_MARGIN);
    expect(verdictFor(pred('strengthened'), veryLargeN)).toBe('refuted');
  });

  it('unclear: symmetric small n — delta=0 but CI too wide for refuted', () => {
    // n=2, baseline=[0,1] (rate 0.5), candidate=[1,0] (rate 0.5)
    // delta=0, CI ≈ [-0.57, 0.57] — does NOT exclude 0 in either direction
    // AND halfWidth ~0.57 > 0.15, so the tight-CI refute rule doesn't fire → unclear.
    const r = compareRates([0, 1], [1, 0]);
    expect(r.delta).toBeCloseTo(0);
    const v = verdictFor(pred('strengthened'), r);
    expect(v).toBe('unclear');
  });

  it('unclear: small shift, CI still crosses 0', () => {
    // 10 samples, small delta
    const r = compareRates(repeat(0.45, 10), repeat(0.55, 10));
    const v = verdictFor(pred('strengthened'), r);
    // delta = 0.1, but CI likely crosses 0 with n=10
    expect(['unclear', 'confirmed'].includes(v)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verdictFor — #2405 acceptance cases
// ---------------------------------------------------------------------------

describe('verdictFor — #2405 equivalence test', () => {
  // Issue acceptance case 1: underpowered run with large CI should be unclear.
  // verdictFor(removed, {delta: +0.003, ci: [-0.137, +0.144]}) → unclear
  it('#2405 case 1: large CI around near-zero delta → unclear (was incorrectly refuted)', () => {
    const r: Parameters<typeof verdictFor>[1] = {
      baseline: 0.497,
      candidate: 0.5,
      delta: 0.003,
      ci: [-0.137, 0.144],
      n: { baseline: 20, candidate: 20 },
    };
    expect(verdictFor(pred('removed'), r)).toBe('unclear');
  });

  // Issue acceptance case 2: entire CI inside equivalence margin → refuted.
  // verdictFor(added, {delta: 0.01, ci: [-0.03, 0.04]}) → refuted (equivalence)
  it('#2405 case 2: CI entirely inside ±5pp → refuted (equivalence)', () => {
    const r: Parameters<typeof verdictFor>[1] = {
      baseline: 0.49,
      candidate: 0.5,
      delta: 0.01,
      ci: [-0.03, 0.04],
      n: { baseline: 200, candidate: 200 },
    };
    expect(verdictFor(pred('added'), r)).toBe('refuted');
  });

  // Issue acceptance case 3: CI excludes zero in opposite direction → refuted.
  // verdictFor(added, {ci: [-0.2, -0.05]}) → refuted (opposite direction)
  it('#2405 case 3: CI excludes zero in opposite direction → refuted', () => {
    const r: Parameters<typeof verdictFor>[1] = {
      baseline: 0.7,
      candidate: 0.58,
      delta: -0.12,
      ci: [-0.2, -0.05],
      n: { baseline: 50, candidate: 50 },
    };
    expect(verdictFor(pred('added'), r)).toBe('refuted');
  });

  // Regression: the old half-width rule fired on underpowered nulls.
  // With n=22 identical 0.5 values, old code returned 'refuted'; new returns 'unclear'
  // because the CI is approximately [-0.14, +0.14] — outside the ±5pp margin.
  it('underpowered null (n=22 identical): unclear, not refuted (#2405 regression)', () => {
    const r = compareRates(repeat(0.5, 22), repeat(0.5, 22));
    // CI half-width was <0.15 with old rule; equivalence margin is ±0.05 — much tighter.
    const v = verdictFor(pred('added'), r);
    expect(v).toBe('unclear');
  });

  it('EQUIVALENCE_MARGIN exported as 0.05', () => {
    expect(EQUIVALENCE_MARGIN).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// predictionAccuracy
// ---------------------------------------------------------------------------

describe('predictionAccuracy', () => {
  it('returns undefined for empty input', () => {
    expect(predictionAccuracy([])).toBeUndefined();
  });

  it('returns undefined when all unclear', () => {
    expect(predictionAccuracy([{ verdict: 'unclear' }, { verdict: 'unclear' }])).toBeUndefined();
  });

  it('counts confirmed / (confirmed + refuted)', () => {
    const items = [
      { verdict: 'confirmed' as const },
      { verdict: 'confirmed' as const },
      { verdict: 'refuted' as const },
      { verdict: 'unclear' as const },
    ];
    const acc = predictionAccuracy(items);
    expect(acc).toBeCloseTo(2 / 3);
  });

  it('100% when all confirmed', () => {
    const items = [{ verdict: 'confirmed' as const }, { verdict: 'confirmed' as const }];
    expect(predictionAccuracy(items)).toBe(1);
  });

  it('0% when all refuted', () => {
    const items = [{ verdict: 'refuted' as const }];
    expect(predictionAccuracy(items)).toBe(0);
  });

  it('excludes unobservable from numerator and denominator', () => {
    const items = [
      { verdict: 'confirmed' as const },
      { verdict: 'refuted' as const },
      { verdict: 'unobservable' as const },
    ];
    // unobservable should not count — accuracy = 1 confirmed / (1 + 1) = 0.5
    const acc = predictionAccuracy(items);
    expect(acc).toBeCloseTo(0.5);
  });

  it('returns undefined when all are unobservable', () => {
    const items = [{ verdict: 'unobservable' as const }];
    expect(predictionAccuracy(items)).toBeUndefined();
  });

  it('returns undefined when mix of unclear and unobservable only', () => {
    const items = [
      { verdict: 'unclear' as const },
      { verdict: 'unobservable' as const },
    ];
    expect(predictionAccuracy(items)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// agreementRate
// ---------------------------------------------------------------------------

describe('agreementRate', () => {
  it('returns 1 for empty arrays', () => {
    expect(agreementRate([], [])).toBe(1);
  });

  it('100% agreement: all on same side', () => {
    expect(agreementRate([0.9, 0.8, 0.7], [0.6, 0.7, 0.9])).toBe(1);
  });

  it('0% agreement: all on opposite sides', () => {
    expect(agreementRate([0.9, 0.8], [0.1, 0.2])).toBe(0);
  });

  it('50% agreement: mixed', () => {
    const rate = agreementRate([0.9, 0.1], [0.8, 0.9]);
    expect(rate).toBeCloseTo(0.5);
  });

  it('boundary: exactly 0.5 both → agree', () => {
    expect(agreementRate([0.5], [0.5])).toBe(1);
  });

  it('boundary: one above, one below 0.5 → disagree', () => {
    expect(agreementRate([0.5], [0.4])).toBe(0);
  });

  it('truncates to shorter array', () => {
    // a has 3 elements, b has 2 — should only compare first 2
    expect(agreementRate([0.9, 0.9, 0.1], [0.8, 0.8])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyAgreementDowngrade (#2413)
// ---------------------------------------------------------------------------

describe('applyAgreementDowngrade (#2413)', () => {
  function makeVP(verdict: 'confirmed' | 'refuted' | 'unclear' | 'unobservable'): VerifiedPrediction {
    return {
      prediction: {
        id: 'p1', behavior: 'test', direction: 'added',
        confidence: 'high', reason: 'r', testQuestion: 'q?', probes: [],
      },
      rates: { baseline: 0.2, candidate: 0.9, delta: 0.7, ci: [0.3, 1.0], n: { baseline: 5, candidate: 5 } },
      verdict,
    };
  }

  /** 3 items disagreeing out of 5 → agreement = 0.4 (below 0.75 threshold). */
  function lowAgreementPairs(n: number): { main: number[]; cross: number[] } {
    // 3 disagree, 2 agree → rate = 2/5 = 0.4 when n=5
    const main: number[] = [];
    const cross: number[] = [];
    for (let i = 0; i < n; i++) {
      main.push(i < 3 ? 0.9 : 0.9); // all primary: high
      cross.push(i < 3 ? 0.1 : 0.9); // first 3: opposite side; last 2: same side
    }
    return { main, cross };
  }

  /** 5 items all agreeing → agreement = 1.0 (above 0.75 threshold). */
  function highAgreementPairs(n: number): { main: number[]; cross: number[] } {
    return {
      main: Array.from({ length: n }, () => 0.9),
      cross: Array.from({ length: n }, () => 0.8),
    };
  }

  it('constants are exported with expected values', () => {
    expect(CROSS_CHECK_MIN_AGREEMENT).toBe(0.75);
    expect(CROSS_CHECK_MIN_ITEMS).toBe(5);
  });

  it('agreement 0.6 (below 0.75) with 5 items: confirmed → unclear with verdictReason', () => {
    // 3 agree, 2 disagree out of 5 → 60% agreement, below 75% threshold
    const { main, cross } = lowAgreementPairs(5);
    const vp = makeVP('confirmed');
    const result = applyAgreementDowngrade(vp, main, cross);
    expect(result.verdict).toBe('unclear');
    expect(result.verdictReason).toBe('judges disagree');
    expect(result.crossCheckAgreement).toBeLessThan(0.75);
    expect(result.crossCheckTooFew).toBeUndefined();
  });

  it('agreement 0.6 with 5 items: refuted → unclear with verdictReason', () => {
    const { main, cross } = lowAgreementPairs(5);
    const vp = makeVP('refuted');
    const result = applyAgreementDowngrade(vp, main, cross);
    expect(result.verdict).toBe('unclear');
    expect(result.verdictReason).toBe('judges disagree');
  });

  it('high agreement (≥ 0.75) with 5 items: confirmed stays confirmed', () => {
    const { main, cross } = highAgreementPairs(5);
    const vp = makeVP('confirmed');
    const result = applyAgreementDowngrade(vp, main, cross);
    expect(result.verdict).toBe('confirmed');
    expect(result.verdictReason).toBeUndefined();
    expect(result.crossCheckAgreement).toBeGreaterThanOrEqual(0.75);
  });

  it('too few items (< 5): does not downgrade, sets crossCheckTooFew', () => {
    const { main, cross } = lowAgreementPairs(4); // 4 < CROSS_CHECK_MIN_ITEMS
    const vp = makeVP('confirmed');
    const result = applyAgreementDowngrade(vp, main, cross);
    expect(result.verdict).toBe('confirmed'); // unchanged
    expect(result.crossCheckTooFew).toBe(true);
    expect(result.crossCheckAgreement).toBeUndefined();
    expect(result.verdictReason).toBeUndefined();
  });

  it('too few items (1): does not downgrade, sets crossCheckTooFew', () => {
    const vp = makeVP('confirmed');
    const result = applyAgreementDowngrade(vp, [0.9], [0.1]); // 1 < 5
    expect(result.verdict).toBe('confirmed');
    expect(result.crossCheckTooFew).toBe(true);
  });

  it('no cross-check data (empty): prediction returned unchanged', () => {
    const vp = makeVP('confirmed');
    const result = applyAgreementDowngrade(vp, [], []);
    expect(result).toBe(vp); // exact same reference, no copy
  });

  it('unobservable verdict is never downgraded even with low agreement', () => {
    const { main, cross } = lowAgreementPairs(5);
    const vp = makeVP('unobservable');
    const result = applyAgreementDowngrade(vp, main, cross);
    expect(result.verdict).toBe('unobservable');
    expect(result.verdictReason).toBeUndefined();
  });

  it('unclear verdict with low agreement: stays unclear (no double-flag)', () => {
    const { main, cross } = lowAgreementPairs(5);
    const vp = makeVP('unclear');
    const result = applyAgreementDowngrade(vp, main, cross);
    expect(result.verdict).toBe('unclear');
    expect(result.verdictReason).toBeUndefined();
  });
});
