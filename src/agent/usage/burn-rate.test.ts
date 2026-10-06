/**
 * Tests for src/agent/usage/burn-rate.ts
 *
 * Required by the issue: idle session (decaying utilization) must produce no
 * projection, and steady burn must produce a sane ETA before resetsAt.
 */

import { describe, it, expect } from 'vitest';
import {
  computeBurnRate,
  appendSample,
  MIN_SAMPLES,
  MAX_SAMPLE_AGE_MS,
  RING_SIZE,
  type WindowObservationSample,
} from './burn-rate.js';

const NOW = 1_800_000_000_000;
const MIN_MS = 60_000;

/** Build a series of evenly spaced samples with given utilizations. */
function samples(utils: number[], startMs: number, stepMs: number): WindowObservationSample[] {
  return utils.map((u, i) => ({ observedAt: startMs + i * stepMs, utilization: u }));
}

describe('computeBurnRate — suppression: too few samples', () => {
  it('returns null with fewer than MIN_SAMPLES samples', () => {
    const s = samples([0.5, 0.6], NOW - 2 * MIN_MS, MIN_MS);
    expect(computeBurnRate(s, NOW)).toBeNull();
  });

  it('returns null with exactly MIN_SAMPLES - 1 recent samples', () => {
    const s = samples(Array(MIN_SAMPLES - 1).fill(0.5).map((v, i) => v + i * 0.05), NOW - (MIN_SAMPLES - 1) * MIN_MS, MIN_MS);
    expect(s.length).toBe(MIN_SAMPLES - 1);
    expect(computeBurnRate(s, NOW)).toBeNull();
  });
});

describe('computeBurnRate — suppression: plateau-then-cool (rule 5)', () => {
  it('returns null for rising-start / declining-tail with positive net delta', () => {
    // Codex P1 scenario: [0.50, 0.80, 0.79, 0.78].
    // Rule 3 passes (0.50→0.80 is a rising pair).
    // Net delta is +0.28 so the old code would project an ETA.
    // Rule 5 (latest delta must be positive) suppresses: 0.79→0.78 is declining.
    const s = samples([0.50, 0.80, 0.79, 0.78], NOW - 4 * MIN_MS, MIN_MS);
    expect(computeBurnRate(s, NOW)).toBeNull();
  });

  it('returns null when last pair is flat after a rise', () => {
    // [0.50, 0.70, 0.70]: rule 3 passes, rule 5 suppresses (0.70 === 0.70).
    const s = samples([0.50, 0.70, 0.70], NOW - 3 * MIN_MS, MIN_MS);
    expect(computeBurnRate(s, NOW)).toBeNull();
  });

  it('returns a projection when the tail pair is still rising after a plateau', () => {
    // [0.50, 0.80, 0.79, 0.81]: last pair 0.79→0.81 is rising — ETA allowed.
    const s = samples([0.50, 0.80, 0.79, 0.81], NOW - 4 * MIN_MS, MIN_MS);
    const result = computeBurnRate(s, NOW);
    expect(result).not.toBeNull();
    expect(result!.ratePerMs).toBeGreaterThan(0);
  });
});

describe('computeBurnRate — suppression: falling-start / rising-tail (deltaUtilization guard)', () => {
  it('returns null when Rule 5 passes but net oldest-to-newest delta is zero', () => {
    // Series [0.70, 0.80, 0.60, 0.70]:
    //   Rule 3 passes (0.70->0.80 is a rising adjacent pair).
    //   Rule 5 passes (last pair 0.60->0.70 is rising, latest delta > 0).
    //   BUT oldest=0.70, newest=0.70 => deltaUtilization=0 => ratePerMs=0.
    //   Without the deltaUtilization <= 0 guard the result would be
    //   { capsAtMs: Infinity, ratePerMs: 0 }. The guard suppresses it.
    //   Removing the guard makes this test fail, pinning it as live.
    const s = samples([0.70, 0.80, 0.60, 0.70], NOW - 4 * MIN_MS, MIN_MS);
    expect(computeBurnRate(s, NOW)).toBeNull();
  });
});

describe('computeBurnRate — suppression: idle / decaying session', () => {
  it('returns null when utilization is flat (no rising pair)', () => {
    const s = samples([0.6, 0.6, 0.6, 0.6], NOW - 4 * MIN_MS, MIN_MS);
    expect(computeBurnRate(s, NOW)).toBeNull();
  });

  it('returns null when utilization is strictly decreasing (idle/decay)', () => {
    // Regression test: rolling window slides, dropping old usage, so utilization
    // falls when the session is idle. A naive delta would project a negative rate.
    const s = samples([0.8, 0.75, 0.70, 0.65], NOW - 4 * MIN_MS, MIN_MS);
    expect(computeBurnRate(s, NOW)).toBeNull();
  });

  it('suppresses when mid-series rises but the last pair falls (rule 5)', () => {
    // Pattern: falls, rises, falls — e.g. [0.9, 0.8, 0.85, 0.82].
    // Rule 3 passes (0.8→0.85 is a rising adjacent pair).
    // Rule 5 suppresses: the last pair 0.85→0.82 is declining, so an ETA
    // would mislead users about a session that is cooling off.
    const s = samples([0.9, 0.8, 0.85, 0.82], NOW - 4 * MIN_MS, MIN_MS);
    expect(computeBurnRate(s, NOW)).toBeNull();
  });
});

describe('computeBurnRate — suppression: stale samples', () => {
  it('returns null when all samples are older than MAX_SAMPLE_AGE_MS', () => {
    const old = NOW - MAX_SAMPLE_AGE_MS - MIN_MS;
    const s = samples([0.5, 0.6, 0.7, 0.8], old - 3 * MIN_MS, MIN_MS);
    // All samples are well before the cutoff.
    expect(computeBurnRate(s, NOW)).toBeNull();
  });

  it('returns null when fewer than MIN_SAMPLES remain after age filter', () => {
    // Two recent + many old
    const old = [0.3, 0.35, 0.40].map((u, i) => ({
      observedAt: NOW - MAX_SAMPLE_AGE_MS - (3 - i) * MIN_MS,
      utilization: u,
    }));
    const recent = [
      { observedAt: NOW - 2 * MIN_MS, utilization: 0.6 },
      { observedAt: NOW - MIN_MS, utilization: 0.65 },
    ];
    const s = [...old, ...recent];
    expect(computeBurnRate(s, NOW)).toBeNull();
  });
});

describe('computeBurnRate — suppression: cap after reset', () => {
  it('returns null when projected cap is after resetsAt', () => {
    // Slow burn: caps in ~10h, but window resets in 1h.
    const STEP = 10 * MIN_MS;
    const s = samples([0.5, 0.51, 0.52, 0.53], NOW - 4 * STEP, STEP);
    const resetsAt = NOW + 60 * MIN_MS; // resets in 1h
    const result = computeBurnRate(s, NOW, resetsAt);
    // Rate: 0.03 / (4*10min) = 0.03/2400s ≈ 5% per hour → caps at 0.47/0.005/hr
    // In practice: 0.53 current → 0.47 remaining / (0.03/2400000ms) ≈ 37,600 min
    // That's way after the 60min reset — should be suppressed.
    expect(result).toBeNull();
  });
});

describe('computeBurnRate — steady burn produces sane ETA', () => {
  it('returns a positive capsAtMs in the future before resetsAt', () => {
    // Burn 5% per 2 minutes → at 50%, caps in ~20 more minutes.
    // All samples must fit within MAX_SAMPLE_AGE_MS (12 min), so use 2 min steps.
    const STEP = 2 * MIN_MS;
    const utils = [0.3, 0.35, 0.40, 0.45, 0.50];
    // Last sample at NOW - 0*STEP = NOW
    const s = samples(utils, NOW - (utils.length - 1) * STEP, STEP);
    // resetsAt far enough in future that cap precedes it
    const resetsAt = NOW + 60 * MIN_MS; // resets in 1h

    const result = computeBurnRate(s, NOW, resetsAt);
    expect(result).not.toBeNull();
    expect(result!.capsAtMs).toBeGreaterThan(NOW);
    expect(result!.capsAtMs).toBeLessThan(resetsAt);
    expect(result!.ratePerMs).toBeGreaterThan(0);

    // Rate: 0.20 utilization over 4*2min = 8min
    // msToCapFromNewest = 0.50 / (0.20 / (4 * STEP)) = 0.50 * 4 * STEP / 0.20 = 10 * STEP = 20min
    const expectedCap = s[s.length - 1]!.observedAt + (0.5 / (0.2 / (4 * STEP)));
    expect(result!.capsAtMs).toBeCloseTo(expectedCap, -1);
  });

  it('omits resetsAt and still returns a projection', () => {
    // 2 min steps fit within 12 min window
    const STEP = 2 * MIN_MS;
    const s = samples([0.6, 0.65, 0.70, 0.75], NOW - (4 - 1) * STEP, STEP);
    const result = computeBurnRate(s, NOW, undefined);
    expect(result).not.toBeNull();
    expect(result!.capsAtMs).toBeGreaterThan(NOW);
  });

  it('ratePerMs is consistent with the utilization delta over the span', () => {
    const STEP = MIN_MS; // 1 min steps
    const s = samples([0.5, 0.6, 0.7, 0.8], NOW - (4 - 1) * STEP, STEP);
    const result = computeBurnRate(s, NOW);
    expect(result).not.toBeNull();
    // 0.30 utilization over 3 minutes = 0.30 / (3 * 60_000) ms
    const expectedRate = 0.30 / (3 * STEP);
    expect(result!.ratePerMs).toBeCloseTo(expectedRate, 10);
  });
});

describe('computeBurnRate — edge: exactly MIN_SAMPLES rising samples', () => {
  it('returns a result at exactly MIN_SAMPLES samples', () => {
    const STEP = MIN_MS;
    const utils = Array.from({ length: MIN_SAMPLES }, (_, i) => 0.5 + i * 0.05);
    const s = samples(utils, NOW - (MIN_SAMPLES - 1) * STEP, STEP);
    expect(computeBurnRate(s, NOW)).not.toBeNull();
  });
});

describe('appendSample', () => {
  it('appends a sample to an empty ring', () => {
    const s: WindowObservationSample = { observedAt: NOW, utilization: 0.5 };
    expect(appendSample([], s)).toEqual([s]);
  });

  it('trims the ring to RING_SIZE when full', () => {
    const full = samples(Array(RING_SIZE).fill(0).map((_, i) => i * 0.05), NOW - RING_SIZE * MIN_MS, MIN_MS);
    const one: WindowObservationSample = { observedAt: NOW, utilization: 0.99 };
    const result = appendSample(full, one);
    expect(result).toHaveLength(RING_SIZE);
    expect(result[result.length - 1]).toEqual(one);
  });

  it('does not mutate the input ring', () => {
    const ring = samples([0.3, 0.4], NOW - 2 * MIN_MS, MIN_MS);
    const frozen = [...ring];
    appendSample(ring, { observedAt: NOW, utilization: 0.5 });
    expect(ring).toEqual(frozen);
  });
});
