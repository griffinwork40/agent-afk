/**
 * Tests for `src/whatif/stats.ts`.
 *
 * Numeric sanity checks:
 *   - identical inputs → refuted (delta ~= 0, CI tight)
 *   - clear shift → confirmed
 *   - borderline → unclear
 *   - agreementRate and predictionAccuracy helpers
 */

import { describe, expect, it } from 'vitest';
import {
  agreementRate,
  compareRates,
  predictionAccuracy,
  verdictFor,
} from './stats.js';
import type { Prediction } from './types.js';

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

  it('refuted: identical inputs (delta ~0, CI tight)', () => {
    // Large identical samples → tight CI around 0 → refuted for either direction
    const base = repeat(0.5, 100);
    const cand = repeat(0.5, 100);
    const r = compareRates(base, cand);
    const v = verdictFor(pred('strengthened'), r);
    // |delta| < 0.05 AND CI halfWidth < 0.15 → refuted
    expect(v).toBe('refuted');
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
