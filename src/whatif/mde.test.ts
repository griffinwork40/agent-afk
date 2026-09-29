/**
 * Tests for `src/whatif/mde.ts`.
 *
 * Covers:
 *   - mdeForN at canonical probe counts (n=20 and n=200)
 *   - nForMde inversion
 *   - isUnderpowered gate predicate
 *   - mdePreflightLine formatting (per-prediction probe basis)
 *   - mdeLimitLine (shown when > 10 pp; absent otherwise)
 *   - mdeGateRefusedMessage content
 *
 * Formula: MDE = (Z_ALPHA + Z_POWER) × sqrt(0.5/n)
 *              = (1.96 + 0.8416) × sqrt(0.5/n)
 *              ≈ 2.8016 × sqrt(0.5/n)
 *
 * Convention: alpha = 0.05 two-sided, 80% power, worst-case p = 0.5.
 */

import { describe, expect, it } from 'vitest';
import {
  MDE_GATE_THRESHOLD,
  headroomLimitLine,
  headroomPreflightLine,
  isUnderpowered,
  mdeForN,
  mdeGateRefusedMessage,
  mdeLimitLine,
  mdePreflightLine,
  nForMde,
  Z_ALPHA,
  Z_POWER,
} from './mde.js';
import type { Prediction } from './types.js';

// ---------------------------------------------------------------------------
// mdeForN
// ---------------------------------------------------------------------------

describe('mdeForN', () => {
  it('returns 1 for n=0 (no information)', () => {
    expect(mdeForN(0)).toBe(1);
  });

  it('n=20: MDE ≈ 44pp (80% power, worst-case variance)', () => {
    // (1.96 + 0.8416) × sqrt(0.5/20) = 2.8016 × 0.1581 ≈ 0.443
    const mde = mdeForN(20);
    expect(mde).toBeGreaterThan(0.41);
    expect(mde).toBeLessThan(0.47);
  });

  it('n=200: MDE ≈ 14pp (80% power, worst-case variance)', () => {
    // (1.96 + 0.8416) × sqrt(0.5/200) = 2.8016 × 0.05 ≈ 0.140
    const mde = mdeForN(200);
    expect(mde).toBeGreaterThan(0.13);
    expect(mde).toBeLessThan(0.15);
  });

  it('MDE decreases as n increases', () => {
    expect(mdeForN(10)).toBeGreaterThan(mdeForN(100));
    expect(mdeForN(100)).toBeGreaterThan(mdeForN(1000));
  });

  it('returns a value in (0, 1] for positive n', () => {
    for (const n of [1, 5, 20, 100, 500]) {
      const mde = mdeForN(n);
      expect(mde).toBeGreaterThan(0);
      expect(mde).toBeLessThanOrEqual(1);
    }
  });

  it('uses Z_ALPHA and Z_POWER constants consistently', () => {
    // Spot-check: mdeForN(n) == (Z_ALPHA + Z_POWER) * sqrt(0.5/n) for n=50
    const n = 50;
    const expected = (Z_ALPHA + Z_POWER) * Math.sqrt(0.5 / n);
    expect(mdeForN(n)).toBeCloseTo(expected, 6);
  });
});

// ---------------------------------------------------------------------------
// nForMde
// ---------------------------------------------------------------------------

describe('nForMde', () => {
  it('returns Infinity for mde=0', () => {
    expect(nForMde(0)).toBe(Infinity);
  });

  it('returns 1 for mde=1', () => {
    expect(nForMde(1)).toBe(1);
  });

  it('nForMde(0.10) gives expected probe count for 10pp target', () => {
    // ceil((Z_ALPHA+Z_POWER)^2 × 0.5 / 0.01) = ceil(3.924/0.01) = ceil(392.4) = 393
    const n = nForMde(0.10);
    expect(n).toBeGreaterThanOrEqual(392);
    expect(n).toBeLessThanOrEqual(394);
  });

  it('nForMde(0.20) → threshold for the gate', () => {
    // ceil((Z_ALPHA+Z_POWER)^2 × 0.5 / 0.04) = ceil(3.924/0.04) = ceil(98.1) = 99
    const n = nForMde(MDE_GATE_THRESHOLD);
    expect(n).toBeGreaterThanOrEqual(98);
    expect(n).toBeLessThanOrEqual(100);
  });

  it('inverses round-trip: mdeForN(nForMde(x)) ≤ x (within tolerance)', () => {
    for (const target of [0.05, 0.10, 0.20, 0.30]) {
      const n = nForMde(target);
      const achieved = mdeForN(n);
      // nForMde uses ceil, so achieved should be ≤ target (or just above due to ceil)
      expect(achieved).toBeLessThanOrEqual(target + 0.01);
    }
  });
});

// ---------------------------------------------------------------------------
// isUnderpowered
// ---------------------------------------------------------------------------

describe('isUnderpowered', () => {
  it('returns true for n=2 (MDE >> 20pp; typical 2-probe-per-prediction cap)', () => {
    expect(isUnderpowered(2)).toBe(true);
  });

  it('returns true for n=20 (MDE >> 20pp threshold)', () => {
    expect(isUnderpowered(20)).toBe(true);
  });

  it('returns true for n=0', () => {
    expect(isUnderpowered(0)).toBe(true);
  });

  it('returns false for n=200 (MDE ≈ 14pp < 20pp threshold)', () => {
    // mdeForN(200) ≈ 0.140 < 0.20
    expect(isUnderpowered(200)).toBe(false);
  });

  it('returns false for large n (clearly powered)', () => {
    expect(isUnderpowered(1000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mdePreflightLine
// ---------------------------------------------------------------------------

describe('mdePreflightLine', () => {
  it('mentions probe count per prediction and detected shift', () => {
    const line = mdePreflightLine(2);
    expect(line).toContain('2 probes/prediction');
    // MDE(2) ≈ 2.8016 × sqrt(0.25) ≈ 140pp → clamped to 100pp? No: sqrt(0.5/2)=0.5, 2.8016*0.5≈1.40 → clamped to 1 → 100pp
    // Actually n=2: (1.96+0.8416)*sqrt(0.5/2) = 2.8016*0.5 = 1.4 → clamped to 1 → 100pp
    expect(line).toContain('100pp');
  });

  it('mentions 80% power', () => {
    const line = mdePreflightLine(2);
    expect(line).toContain('80% power');
  });

  it('mentions the default target (10pp) and needed probe count', () => {
    const line = mdePreflightLine(2);
    expect(line).toContain('10pp');
    // nForMde(0.10) ≈ 785
    expect(line).toMatch(/\d{3,} probes\/prediction/);
  });

  it('handles n=200 with custom target', () => {
    const line = mdePreflightLine(200, 0.05);
    expect(line).toContain('200 probes/prediction');
    expect(line).toContain('5pp');
  });

  it('handles n=1 (singular)', () => {
    const line = mdePreflightLine(1);
    expect(line).toContain('1 probe/prediction');
    expect(line).not.toContain('1 probes/prediction');
  });

  it('returns a "No episodes" message for n=0', () => {
    const line = mdePreflightLine(0);
    expect(line).toContain('No episodes');
  });
});

// ---------------------------------------------------------------------------
// mdeLimitLine
// ---------------------------------------------------------------------------

describe('mdeLimitLine', () => {
  it('returns undefined when MDE ≤ 10pp (sufficient probes)', () => {
    // nForMde(0.10) ≈ 785; at n=785 MDE ≈ 10pp → just at boundary
    const n = nForMde(0.10);
    expect(mdeLimitLine(n, 'p1')).toBeUndefined();
  });

  it('returns a line for n=2 (MDE clamped to 100pp >> 10pp)', () => {
    const line = mdeLimitLine(2, 'p1');
    expect(line).toBeDefined();
    expect(line).toContain('p1');
    expect(line).toContain('n=2');
  });

  it('returns a line for n=20 (MDE ≈ 44pp > 10pp)', () => {
    const line = mdeLimitLine(20, 'p1');
    expect(line).toBeDefined();
    expect(line).toContain('p1');
    expect(line).toContain('n=20');
    // MDE ≈ 44pp
    expect(line).toMatch(/4[0-9]pp/);
  });

  it('returns a line for n=200 (MDE ≈ 14pp > 10pp)', () => {
    // mdeForN(200) ≈ 0.140 > 0.10 → should warn
    const line = mdeLimitLine(200, 'p2');
    expect(line).toBeDefined();
    expect(line).toContain('p2');
  });

  it('includes "undetectable" in the message', () => {
    const line = mdeLimitLine(20, 'pred1');
    expect(line).toContain('undetectable');
  });

  it('mentions 80% power in the limit line', () => {
    const line = mdeLimitLine(20, 'p1');
    expect(line).toContain('80% power');
  });
});

// ---------------------------------------------------------------------------
// mdeGateRefusedMessage
// ---------------------------------------------------------------------------

describe('mdeGateRefusedMessage', () => {
  it('mentions the probe count and threshold', () => {
    const msg = mdeGateRefusedMessage(2);
    expect(msg).toContain('2 probes/prediction');
    expect(msg).toContain(`${Math.round(MDE_GATE_THRESHOLD * 100)}pp`);
  });

  it('mentions --force', () => {
    const msg = mdeGateRefusedMessage(2);
    expect(msg).toContain('--force');
  });

  it('mentions the needed probe count to pass', () => {
    const msg = mdeGateRefusedMessage(2);
    // nForMde(0.20) ≈ 197
    expect(msg).toMatch(/\d{2,} probes\/prediction/);
  });

  it('mentions issue #2477 (configurable probe count tracking issue)', () => {
    const msg = mdeGateRefusedMessage(2);
    expect(msg).toContain('#2477');
  });

  it('mentions 80% power', () => {
    const msg = mdeGateRefusedMessage(2);
    expect(msg).toContain('80% power');
  });
});

// ---------------------------------------------------------------------------
// headroomPreflightLine — Item 3: narrowed parameter type; missing estimate
// ---------------------------------------------------------------------------

function makePred(
  direction: Prediction['direction'],
  baselineEstimate: number,
): Prediction & { baselineEstimate: number } {
  return {
    id: 'p1',
    behavior: 'test behavior',
    direction,
    confidence: 'medium',
    reason: 'test reason',
    testQuestion: 'Does the response do the thing?',
    probes: ['probe 1'],
    baselineEstimate,
  };
}

describe('headroomPreflightLine', () => {
  it('returns a string for a prediction with baselineEstimate present', () => {
    const pred = makePred('added', 0.93);
    const line = headroomPreflightLine(pred, 11);
    expect(typeof line).toBe('string');
    expect(line).toContain('p1');
    expect(line).toContain('93%');
    expect(line).toContain('underpowered');
  });

  it('type-safe: the function signature requires baselineEstimate (compile-time contract)', () => {
    // This test documents that the function CANNOT be called with a bare
    // Prediction lacking baselineEstimate — narrowing is enforced by the type.
    // Runtime guard: passing a value satisfies the narrowed type.
    const pred = makePred('strengthened', 0.5);
    expect(() => headroomPreflightLine(pred, 11)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// headroomLimitLine — Item 6: boundary tests
// ---------------------------------------------------------------------------

describe('headroomLimitLine — boundary cases', () => {
  it('observedBaseline=1.0, direction=added: headroom=0 → always warns', () => {
    // headroom = 1 - 1.0 = 0, which is always < mdeForN(n) for any n
    const line = headroomLimitLine(1.0, 'added', 11, 'p1');
    expect(line).toBeDefined();
    expect(line).toContain('p1');
    expect(line).toContain('increase');
  });

  it('observedBaseline=0.0, direction=removed: headroom=0 → always warns', () => {
    // headroom for removed = baselineEstimate = 0.0 < mdeForN(n) for any n
    const line = headroomLimitLine(0.0, 'removed', 11, 'p2');
    expect(line).toBeDefined();
    expect(line).toContain('p2');
    expect(line).toContain('decrease');
  });
});
