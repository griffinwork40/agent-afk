/**
 * Tests for the paired per-probe sign-flip analysis (#2477 step 3).
 *
 * Includes a pilot-data reproduction test asserting that the implementation
 * matches the exact p-value and per-probe differences from the step-2 pilot
 * run (20260928-153056-015fbb, pilot_analyze.py).
 *
 * @module whatif/probe-signflip.test
 */

import { describe, expect, it } from 'vitest';
import { computeProbeSignFlip, ZERO_TOLERANCE } from './probe-signflip.js';
import type { ArmSamples } from './probe-signflip.js';
import pilotFixture from './__test-utils__/pilot-fixture.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Helper: build an ArmSamples map from the fixture
// ---------------------------------------------------------------------------

function buildArmSamples(episodes: typeof pilotFixture.episodes): Map<string, ArmSamples> {
  const map = new Map<string, ArmSamples>();
  for (const ep of episodes) {
    map.set(ep.id, {
      baseline: ep.baselineSamples,
      candidate: ep.candidateSamples,
    });
  }
  return map;
}

function episodeOrder(episodes: typeof pilotFixture.episodes): string[] {
  return episodes.map((e) => e.id);
}

// ---------------------------------------------------------------------------
// Pilot data reproduction test
//
// The step-2 pilot (20260928-153056-015fbb, pilot_analyze.py) computed:
//   - per-probe differences: [+0.48, 0, +0.02, +0.02, 0, 0, 0, -0.14, 0, +0.43]
//     (rounded to 2dp from exact [0.48, 0.0, 0.025, 0.025, 0.0, 0.0, 0.0, -0.145, 0.005, 0.43])
//   - exact sign-flip p on continuous P(yes) probe means: 0.2812 (= 18/64)
//   - 2 unpaired probes (s3: baseline only, s12: baseline only)
//   - 10 paired probes, 6 with |d| > ZERO_TOLERANCE (1e-9)
//   - min achievable p = 2/2^6 = 0.03125
// ---------------------------------------------------------------------------

describe('pilot reproduction (20260928-153056-015fbb)', () => {
  const armSamples = buildArmSamples(pilotFixture.episodes);
  const order = episodeOrder(pilotFixture.episodes);
  const result = computeProbeSignFlip(armSamples, order);

  it('counts paired and unpaired probes correctly', () => {
    // s3 and s12 have no candidate samples → unpaired
    expect(result.nPaired).toBe(10);
    expect(result.nUnpaired).toBe(2);
  });

  it('computes per-probe differences matching the pilot', () => {
    // Paired episodes in order: s1, s2, s4, s5, s6, s7, s8, s9, s10, s11
    // Exact diffs:  0.48, 0.0, 0.025, 0.025, 0.0, 0.0, 0.0, -0.145, 0.005, 0.43
    const expected = [0.48, 0.0, 0.025, 0.025, 0.0, 0.0, 0.0, -0.145, 0.005, 0.43];
    expect(result.probeDiffs).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(result.probeDiffs[i]).toBeCloseTo(expected[i]!, 6);
    }
  });

  it('identifies 6 nonzero differences', () => {
    // |d| > 1e-9 for: 0.48, 0.025, 0.025, -0.145, 0.005, 0.43
    expect(result.nNonzero).toBe(6);
  });

  it('reproduces the pilot exact sign-flip p = 0.2812', () => {
    // Pilot pilot_analyze.py: "sign-flip exact p=0.2812"
    // 18 out of 64 sign assignments have |sum| >= |sum(nonzero diffs)| = 0.820
    expect(result.p).toBeCloseTo(18 / 64, 6); // 0.28125
  });

  it('uses exact enumeration (k=6 <= 16)', () => {
    expect(result.method).toBe('exact');
  });

  it('reports minimum achievable p = 2/64 ≈ 0.03125', () => {
    expect(result.minAchievableP).toBeCloseTo(2 / 64, 6);
  });

  it('is not underpowered for significance (min_p < 0.05)', () => {
    // 2/64 = 0.03125 < 0.05
    expect(result.underpoweredForSig).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ZERO_TOLERANCE documented value
// ---------------------------------------------------------------------------

describe('ZERO_TOLERANCE', () => {
  it('is 1e-9', () => {
    expect(ZERO_TOLERANCE).toBe(1e-9);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('computeProbeSignFlip edge cases', () => {
  it('returns null p when no paired probes', () => {
    // All episodes have only baseline data
    const map = new Map<string, ArmSamples>([
      ['ep1', { baseline: [0.5], candidate: [] }],
    ]);
    const r = computeProbeSignFlip(map, ['ep1']);
    expect(r.nPaired).toBe(0);
    expect(r.nUnpaired).toBe(1);
    expect(r.p).toBeNull();
  });

  it('returns p=1.0 when all paired differences are zero', () => {
    const map = new Map<string, ArmSamples>([
      ['ep1', { baseline: [0.3], candidate: [0.3] }],
      ['ep2', { baseline: [0.7], candidate: [0.7] }],
    ]);
    const r = computeProbeSignFlip(map, ['ep1', 'ep2']);
    expect(r.nNonzero).toBe(0);
    expect(r.p).toBe(1.0);
    expect(r.minAchievableP).toBeNull();
  });

  it('returns p=1.0 (exact) for a perfectly symmetric single difference', () => {
    // One nonzero diff; all sign assignments: +d and -d, both have |sum|=|d|
    // So 2/2 = 1.0
    const map = new Map<string, ArmSamples>([
      ['ep1', { baseline: [0.2], candidate: [0.8] }],
    ]);
    const r = computeProbeSignFlip(map, ['ep1']);
    expect(r.nNonzero).toBe(1);
    expect(r.p).toBeCloseTo(1.0, 9);
    expect(r.minAchievableP).toBeCloseTo(1.0, 9); // 2/2^1 = 1.0
  });

  it('returns p=0.5 for two equal-magnitude differences in same direction', () => {
    // d = [+0.2, +0.2]; obs=0.4
    // Assignments: (++):0.4✓ (+-):0.0 (-+):0.0 (--):0.4✓ → 2/4=0.5
    const map = new Map<string, ArmSamples>([
      ['ep1', { baseline: [0.3], candidate: [0.5] }],
      ['ep2', { baseline: [0.1], candidate: [0.3] }],
    ]);
    const r = computeProbeSignFlip(map, ['ep1', 'ep2']);
    expect(r.nNonzero).toBe(2);
    expect(r.p).toBeCloseTo(0.5, 9);
    expect(r.minAchievableP).toBeCloseTo(0.5, 9); // 2/2^2 = 0.5
    expect(r.underpoweredForSig).toBe(true); // 0.5 > 0.05
  });

  it('computes correct meanDelta including zeros', () => {
    const map = new Map<string, ArmSamples>([
      ['ep1', { baseline: [0.0], candidate: [0.4] }], // d = +0.4
      ['ep2', { baseline: [0.5], candidate: [0.5] }], // d = 0.0
    ]);
    const r = computeProbeSignFlip(map, ['ep1', 'ep2']);
    // meanDelta = (0.4 + 0.0) / 2 = 0.2
    expect(r.meanDelta).toBeCloseTo(0.2, 9);
    expect(r.nNonzero).toBe(1);
  });

  it('respects episode order from the provided array', () => {
    const map = new Map<string, ArmSamples>([
      ['ep_a', { baseline: [0.2], candidate: [0.8] }], // d = +0.6
      ['ep_b', { baseline: [0.8], candidate: [0.2] }], // d = -0.6
    ]);
    // Order a then b
    const rAB = computeProbeSignFlip(map, ['ep_a', 'ep_b']);
    expect(rAB.probeDiffs[0]).toBeCloseTo(0.6, 9);
    expect(rAB.probeDiffs[1]).toBeCloseTo(-0.6, 9);
    // Order b then a
    const rBA = computeProbeSignFlip(map, ['ep_b', 'ep_a']);
    expect(rBA.probeDiffs[0]).toBeCloseTo(-0.6, 9);
    expect(rBA.probeDiffs[1]).toBeCloseTo(0.6, 9);
  });
});

// ---------------------------------------------------------------------------
// Min achievable p sanity checks
// ---------------------------------------------------------------------------

describe('minimum achievable p', () => {
  it('is 2/2 = 1.0 for k=1', () => {
    const map = new Map<string, ArmSamples>([
      ['ep1', { baseline: [0.1], candidate: [0.9] }],
    ]);
    const r = computeProbeSignFlip(map, ['ep1']);
    expect(r.minAchievableP).toBeCloseTo(1.0, 9);
    expect(r.underpoweredForSig).toBe(true);
  });

  it('is 2/4 = 0.5 for k=2', () => {
    const map = new Map<string, ArmSamples>([
      ['ep1', { baseline: [0.1], candidate: [0.9] }],
      ['ep2', { baseline: [0.2], candidate: [0.8] }],
    ]);
    const r = computeProbeSignFlip(map, ['ep1', 'ep2']);
    expect(r.minAchievableP).toBeCloseTo(0.5, 9);
    expect(r.underpoweredForSig).toBe(true);
  });

  it('is 2/8 = 0.25 for k=3', () => {
    const map = new Map<string, ArmSamples>([
      ['ep1', { baseline: [0.1], candidate: [0.9] }],
      ['ep2', { baseline: [0.2], candidate: [0.8] }],
      ['ep3', { baseline: [0.3], candidate: [0.7] }],
    ]);
    const r = computeProbeSignFlip(map, ['ep1', 'ep2', 'ep3']);
    expect(r.minAchievableP).toBeCloseTo(0.25, 9);
    expect(r.underpoweredForSig).toBe(true);
  });

  it('is 2/64 = 0.03125 for k=6 (below 0.05)', () => {
    const map = new Map<string, ArmSamples>([
      ['ep1', { baseline: [0.1], candidate: [0.9] }],
      ['ep2', { baseline: [0.2], candidate: [0.8] }],
      ['ep3', { baseline: [0.3], candidate: [0.7] }],
      ['ep4', { baseline: [0.4], candidate: [0.6] }],
      ['ep5', { baseline: [0.5], candidate: [0.9] }],
      ['ep6', { baseline: [0.1], candidate: [0.5] }],
    ]);
    const r = computeProbeSignFlip(map, ['ep1', 'ep2', 'ep3', 'ep4', 'ep5', 'ep6']);
    expect(r.minAchievableP).toBeCloseTo(2 / 64, 9);
    expect(r.underpoweredForSig).toBe(false);
  });
});
