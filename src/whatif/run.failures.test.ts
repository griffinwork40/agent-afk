/**
 * Tests for `src/whatif/run.failures.ts`.
 *
 * Covers per-arm failure listing, imbalance flag on/off, and no-failure cases.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFailedEpisodeRecords,
  detectArmImbalance,
  IMBALANCE_RATE_THRESHOLD,
  IMBALANCE_MIN_FAILURES,
} from './run.failures.js';
import type { EpisodeTrace } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTrace(
  episodeId: string,
  env: 'baseline' | 'candidate',
  sample: number,
  error?: string,
  durationMs = 5000,
): EpisodeTrace {
  return {
    episodeId,
    env,
    sample,
    text: error ? '' : 'some output',
    tools: [],
    costUsd: 0.001,
    inputTokens: 100,
    outputTokens: 50,
    durationMs,
    ...(error !== undefined ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// buildFailedEpisodeRecords
// ---------------------------------------------------------------------------

describe('buildFailedEpisodeRecords', () => {
  it('returns empty array when no traces failed', () => {
    const traces = [
      makeTrace('s1', 'baseline', 0),
      makeTrace('s1', 'candidate', 0),
    ];
    const result = buildFailedEpisodeRecords(traces, new Map());
    expect(result).toHaveLength(0);
  });

  it('returns one record per failed trace', () => {
    const traces = [
      makeTrace('s1', 'baseline', 0),
      makeTrace('s1', 'candidate', 0, 'Episode timed out after 180000ms.', 180007),
      makeTrace('s2', 'candidate', 0, 'Process exited with code 1', 3000),
    ];
    const result = buildFailedEpisodeRecords(traces, new Map());
    expect(result).toHaveLength(2);
  });

  it('classifies timeout errors as "timeout"', () => {
    const traces = [makeTrace('s1', 'candidate', 0, 'Episode timed out after 180000ms.', 180007)];
    const [rec] = buildFailedEpisodeRecords(traces, new Map());
    expect(rec?.errorClass).toBe('timeout');
    expect(rec?.arm).toBe('candidate');
    expect(rec?.episodeId).toBe('s1');
    expect(rec?.durationMs).toBe(180007);
  });

  it('classifies non-timeout errors as "error"', () => {
    const traces = [makeTrace('s1', 'baseline', 0, 'Process exited with code 1', 2000)];
    const [rec] = buildFailedEpisodeRecords(traces, new Map());
    expect(rec?.errorClass).toBe('error');
  });

  it('truncates error message to 120 chars', () => {
    const longMsg = 'A'.repeat(200);
    const traces = [makeTrace('s1', 'candidate', 0, longMsg)];
    const [rec] = buildFailedEpisodeRecords(traces, new Map());
    expect((rec?.errorMessage ?? '').length).toBeLessThanOrEqual(120);
  });

  it('uses only the first line of a multiline error', () => {
    const traces = [makeTrace('s1', 'candidate', 0, 'First line\nSecond line\nThird line')];
    const [rec] = buildFailedEpisodeRecords(traces, new Map());
    expect(rec?.errorMessage).toBe('First line');
  });

  it('includes probe field when episodeTargets map has a match', () => {
    const traces = [makeTrace('s3', 'candidate', 0, 'timed out', 180000)];
    const targets = new Map([['s3', 'p2']]);
    const [rec] = buildFailedEpisodeRecords(traces, targets);
    expect(rec?.probe).toBe('p2');
  });

  it('omits probe field when episode has no target', () => {
    const traces = [makeTrace('s1', 'candidate', 0, 'timed out')];
    const [rec] = buildFailedEpisodeRecords(traces, new Map());
    expect(rec).not.toHaveProperty('probe');
  });

  it('records the correct arm for each failure', () => {
    const traces = [
      makeTrace('s1', 'baseline', 0, 'error in baseline'),
      makeTrace('s2', 'candidate', 1, 'error in candidate'),
    ];
    const records = buildFailedEpisodeRecords(traces, new Map());
    const arms = records.map((r) => r.arm);
    expect(arms).toContain('baseline');
    expect(arms).toContain('candidate');
  });
});

// ---------------------------------------------------------------------------
// detectArmImbalance — no failures
// ---------------------------------------------------------------------------

describe('detectArmImbalance: no failures', () => {
  it('returns undefined when records array is empty', () => {
    expect(detectArmImbalance([], 10, 10)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectArmImbalance — rate-difference criterion
// ---------------------------------------------------------------------------

describe('detectArmImbalance: rate-difference criterion', () => {
  it('fires when absolute rate diff >= IMBALANCE_RATE_THRESHOLD', () => {
    // 3/10 candidate (30%) vs 0/10 baseline (0%) → 30 pp >= 20 pp
    const records = [
      makeTrace('s1', 'candidate', 0, 'timed out'),
      makeTrace('s2', 'candidate', 0, 'timed out'),
      makeTrace('s3', 'candidate', 0, 'timed out'),
    ].map((t) => buildFailedEpisodeRecords([t], new Map())[0]!);
    const result = detectArmImbalance(records, 10, 10);
    expect(result).not.toBeUndefined();
    expect(result?.rateDiff).toBeCloseTo(0.3, 5);
    expect(result?.summary).toContain('bias');
  });

  it('uses "failure rates differ significantly" when only rate criterion fires (not allInOneArm)', () => {
    // 4/10 candidate (40%) vs 0.5/10 baseline (5%) → 35 pp rate diff fires,
    // but failures exist in BOTH arms so allInOneArm is false.
    const records = [
      // baseline failure — ensures failures are in both arms
      makeTrace('b1', 'baseline', 0, 'timed out'),
      // enough candidate failures to exceed both the rate threshold and MIN_FAILURES
      makeTrace('c1', 'candidate', 0, 'timed out'),
      makeTrace('c2', 'candidate', 0, 'timed out'),
      makeTrace('c3', 'candidate', 0, 'timed out'),
      makeTrace('c4', 'candidate', 0, 'timed out'),
      // extra baseline success traces (total baseline = 20, so 1/20 = 5%)
    ].map((t) => buildFailedEpisodeRecords([t], new Map())[0]!);
    const result = detectArmImbalance(records, 20, 10);
    expect(result).not.toBeUndefined();
    expect(result?.allInOneArm).toBe(false);
    expect(result?.summary).toContain('failure rates differ significantly between arms');
    expect(result?.summary).not.toContain('failures are concentrated in one arm');
  });

  it('does NOT fire when rate diff is below threshold (17pp < 20pp)', () => {
    // 1/6 candidate (17%) vs 0/6 baseline (0%) → 17 pp < 20 pp
    // AND only 1 failure < IMBALANCE_MIN_FAILURES=2 so one-arm criterion also off
    const records = [makeTrace('s1', 'candidate', 0, 'timed out')]
      .map((t) => buildFailedEpisodeRecords([t], new Map())[0]!);
    expect(detectArmImbalance(records, 6, 6)).toBeUndefined();
  });

  it('fires symmetrically when baseline fails more than candidate', () => {
    // 3/10 baseline (30%) vs 0/10 candidate (0%) → 30 pp, negative rateDiff
    const records = [
      makeTrace('s1', 'baseline', 0, 'timed out'),
      makeTrace('s2', 'baseline', 0, 'timed out'),
      makeTrace('s3', 'baseline', 0, 'timed out'),
    ].map((t) => buildFailedEpisodeRecords([t], new Map())[0]!);
    const result = detectArmImbalance(records, 10, 10);
    expect(result).not.toBeUndefined();
    expect(result?.rateDiff).toBeCloseTo(-0.3, 5);
  });
});

// ---------------------------------------------------------------------------
// detectArmImbalance — one-arm concentration criterion
// ---------------------------------------------------------------------------

describe('detectArmImbalance: one-arm concentration criterion', () => {
  it('fires when all failures are in candidate and count >= MIN_FAILURES', () => {
    // 2/4 candidate, 0/4 baseline → all in one arm, 2 >= 2
    const records = [
      makeTrace('s1', 'candidate', 0, 'timed out'),
      makeTrace('s2', 'candidate', 0, 'timed out'),
    ].map((t) => buildFailedEpisodeRecords([t], new Map())[0]!);
    const result = detectArmImbalance(records, 4, 4);
    expect(result).not.toBeUndefined();
    expect(result?.allInOneArm).toBe(true);
    expect(result?.concentrationArm).toBe('candidate');
  });

  it('does NOT fire when only 1 failure (below MIN_FAILURES)', () => {
    // 1/10 candidate (10%) — below rate threshold AND below MIN_FAILURES
    const records = [makeTrace('s1', 'candidate', 0, 'timed out')]
      .map((t) => buildFailedEpisodeRecords([t], new Map())[0]!);
    expect(detectArmImbalance(records, 10, 10)).toBeUndefined();
  });

  it('does NOT fire when failures are in both arms', () => {
    // 1/4 baseline, 1/4 candidate — equal, neither criterion triggers
    const records = [
      makeTrace('s1', 'baseline', 0, 'timed out'),
      makeTrace('s2', 'candidate', 0, 'timed out'),
    ].map((t) => buildFailedEpisodeRecords([t], new Map())[0]!);
    expect(detectArmImbalance(records, 4, 4)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectArmImbalance — pilot scenario
// ---------------------------------------------------------------------------

describe('detectArmImbalance: pilot scenario (6 candidate, 0 baseline)', () => {
  it('fires on both criteria and names the candidate arm', () => {
    // Mirrors the 20260928 pilot: 6/16 candidate timeouts, 0/26 baseline
    const records = Array.from({ length: 6 }, (_, i) =>
      makeTrace(`s${i + 1}`, 'candidate', 0, 'Episode timed out after 180000ms.', 180007),
    ).map((t) => buildFailedEpisodeRecords([t], new Map())[0]!);

    const result = detectArmImbalance(records, 26, 16);
    expect(result).not.toBeUndefined();
    expect(result?.allInOneArm).toBe(true);
    expect(result?.concentrationArm).toBe('candidate');
    expect(result?.candidateFailRate).toBeCloseTo(6 / 16, 5);
    expect(result?.baselineFailRate).toBe(0);
    expect(result?.summary).toContain('Arm-imbalance warning');
    expect(result?.summary).toContain('--timeout');
  });
});

// ---------------------------------------------------------------------------
// buildFailedEpisodeRecords — zero-duration edge case
// ---------------------------------------------------------------------------

describe('buildFailedEpisodeRecords: durationMs = 0', () => {
  it('records durationMs as 0 and renders as "0.0s" in the report table', () => {
    const traces = [makeTrace('s1', 'candidate', 0, 'instant failure', 0)];
    const [rec] = buildFailedEpisodeRecords(traces, new Map());
    expect(rec?.durationMs).toBe(0);
    // Verify the rendering used in report.ts: (durationMs / 1000).toFixed(1) + 's'
    expect((rec!.durationMs / 1000).toFixed(1) + 's').toBe('0.0s');
  });
});

// ---------------------------------------------------------------------------
// Threshold constants
// ---------------------------------------------------------------------------

describe('threshold constants', () => {
  it('IMBALANCE_RATE_THRESHOLD is 0.20', () => {
    expect(IMBALANCE_RATE_THRESHOLD).toBe(0.20);
  });
  it('IMBALANCE_MIN_FAILURES is 2', () => {
    expect(IMBALANCE_MIN_FAILURES).toBe(2);
  });
});
