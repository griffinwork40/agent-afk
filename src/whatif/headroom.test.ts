/**
 * Tests for the baseline headroom feature (#2504).
 *
 * Covers:
 *   (a) Zod schema accepting and omitting baselineEstimate (via predict.ts)
 *   (b) headroomForPrediction computation for all four directions + absent case
 *   (c) isHeadroomUnderpowered / headroomPreflightLine — preflight/gate
 *       integration (underpowered on low headroom, bypassed by --force)
 *   (d) headroomLimitLine — post-hoc limit appearing and not appearing
 *
 * @module whatif/headroom.test
 */

import { describe, it, expect, vi } from 'vitest';
import { predictChanges } from './predict.js';
import {
  headroomForPrediction,
  isHeadroomUnderpowered,
  headroomPreflightLine,
  headroomLimitLine,
  mdeForN,
} from './mde.js';
import type { CompleteFn, Prediction, StructuralImpact } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyStructural(): StructuralImpact {
  return {
    baseline: { model: 'haiku', system: 'sys', tools: [], firstUserMessage: 'hi' },
    candidate: { model: 'haiku', system: 'sys', tools: [], firstUserMessage: 'hi' },
    systemDiff: '',
    toolsAdded: [],
    toolsRemoved: [],
    toolsChanged: [],
    userMessageDiff: '',
    tokens: { baseline: 100, candidate: 110 },
    modelChanged: false,
  };
}

function makeFake(text: string): CompleteFn {
  return vi.fn().mockResolvedValue({ text, costUsd: 0.001 });
}

function makePrediction(
  direction: Prediction['direction'],
  baselineEstimate?: number,
): Prediction {
  return {
    id: 'p1',
    behavior: 'test behavior',
    direction,
    confidence: 'medium',
    reason: 'test reason',
    testQuestion: 'Does the response do the thing?',
    probes: ['probe 1'],
    observable: 'decision',
    ...(baselineEstimate !== undefined ? { baselineEstimate } : {}),
  };
}

// ---------------------------------------------------------------------------
// (a) Schema: accepting and omitting baselineEstimate
// ---------------------------------------------------------------------------

describe('predict schema: baselineEstimate', () => {
  const MODEL = 'claude-haiku-4-5-20250929';

  it('parses and retains baselineEstimate when present and in [0,1]', async () => {
    const payload = [
      {
        id: 'p1',
        behavior: 'uses its own tools',
        direction: 'strengthened',
        confidence: 'medium',
        reason: 'reason',
        testQuestion: 'Does the response call a tool?',
        probes: ['Fix the typo in README.md', 'Show me the config'],
        observable: 'decision',
        baselineEstimate: 0.15,
      },
    ];
    const fn = makeFake(JSON.stringify(payload));
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      fn,
      MODEL,
    );
    expect(result).toHaveLength(1);
    expect(result[0].baselineEstimate).toBe(0.15);
  });

  it('accepts baselineEstimate = 0', async () => {
    const payload = [
      {
        id: 'p1',
        behavior: 'asks clarifying question',
        direction: 'added',
        confidence: 'low',
        reason: 'r',
        testQuestion: 'Does the response ask a question?',
        probes: ['do something ambiguous'],
        observable: 'decision',
        baselineEstimate: 0,
      },
    ];
    const fn = makeFake(JSON.stringify(payload));
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      fn,
      MODEL,
    );
    expect(result[0].baselineEstimate).toBe(0);
  });

  it('accepts baselineEstimate = 1', async () => {
    const payload = [
      {
        id: 'p1',
        behavior: 'delegates',
        direction: 'weakened',
        confidence: 'high',
        reason: 'r',
        testQuestion: 'Does the response delegate?',
        probes: ['complex task'],
        observable: 'decision',
        baselineEstimate: 1,
      },
    ];
    const fn = makeFake(JSON.stringify(payload));
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      fn,
      MODEL,
    );
    expect(result[0].baselineEstimate).toBe(1);
  });

  it('omits baselineEstimate when not present (backward compatible)', async () => {
    const payload = [
      {
        id: 'p1',
        behavior: 'legacy prediction',
        direction: 'added',
        confidence: 'medium',
        reason: 'r',
        testQuestion: 'Does the response do it?',
        probes: ['probe'],
        observable: 'decision',
      },
    ];
    const fn = makeFake(JSON.stringify(payload));
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      fn,
      MODEL,
    );
    expect(result[0].baselineEstimate).toBeUndefined();
  });

  it('clamps out-of-range baselineEstimate to [0,1]', async () => {
    const payload = [
      {
        id: 'p1',
        behavior: 'something',
        direction: 'added',
        confidence: 'low',
        reason: 'r',
        testQuestion: 'Does the response do it?',
        probes: ['probe'],
        observable: 'decision',
        baselineEstimate: 1.5,
      },
    ];
    const fn = makeFake(JSON.stringify(payload));
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      fn,
      MODEL,
    );
    // Clamped to 1
    expect(result[0].baselineEstimate).toBe(1);
  });

  it('drops non-numeric baselineEstimate', async () => {
    const payload = [
      {
        id: 'p1',
        behavior: 'something',
        direction: 'added',
        confidence: 'low',
        reason: 'r',
        testQuestion: 'Does the response do it?',
        probes: ['probe'],
        observable: 'decision',
        baselineEstimate: 'high',
      },
    ];
    const fn = makeFake(JSON.stringify(payload));
    const result = await predictChanges(
      { spec: { title: 't', changes: [] }, changeDescriptions: [], structural: emptyStructural() },
      fn,
      MODEL,
    );
    expect(result[0].baselineEstimate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (b) headroomForPrediction: all four directions + absent case
// ---------------------------------------------------------------------------

describe('headroomForPrediction', () => {
  it('added: headroom = 1 - baselineEstimate', () => {
    expect(headroomForPrediction(0.93, 'added')).toBeCloseTo(0.07);
    expect(headroomForPrediction(0.0, 'added')).toBeCloseTo(1.0);
    expect(headroomForPrediction(1.0, 'added')).toBeCloseTo(0.0);
  });

  it('strengthened: headroom = 1 - baselineEstimate', () => {
    expect(headroomForPrediction(0.93, 'strengthened')).toBeCloseTo(0.07);
    expect(headroomForPrediction(0.2, 'strengthened')).toBeCloseTo(0.8);
  });

  it('removed: headroom = baselineEstimate', () => {
    expect(headroomForPrediction(0.93, 'removed')).toBeCloseTo(0.93);
    expect(headroomForPrediction(0.0, 'removed')).toBeCloseTo(0.0);
    expect(headroomForPrediction(1.0, 'removed')).toBeCloseTo(1.0);
  });

  it('weakened: headroom = baselineEstimate', () => {
    expect(headroomForPrediction(0.7, 'weakened')).toBeCloseTo(0.7);
    expect(headroomForPrediction(0.05, 'weakened')).toBeCloseTo(0.05);
  });

  it('returns undefined when baselineEstimate is absent', () => {
    expect(headroomForPrediction(undefined, 'added')).toBeUndefined();
    expect(headroomForPrediction(undefined, 'removed')).toBeUndefined();
    expect(headroomForPrediction(undefined, 'strengthened')).toBeUndefined();
    expect(headroomForPrediction(undefined, 'weakened')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (c) Preflight / gate integration
// ---------------------------------------------------------------------------

describe('isHeadroomUnderpowered', () => {
  it('returns false when baselineEstimate is absent', () => {
    const pred = makePrediction('strengthened'); // no baselineEstimate
    expect(isHeadroomUnderpowered(pred, 11)).toBe(false);
  });

  it('returns true for added with high baseline (pilot 2 scenario: 93% baseline, 11 probes)', () => {
    // mdeForN(11) ≈ 59pp; headroom = 1 - 0.93 = 7pp < 59pp → underpowered
    const pred = makePrediction('strengthened', 0.93);
    expect(isHeadroomUnderpowered(pred, 11)).toBe(true);
  });

  it('returns false when headroom exceeds MDE', () => {
    // mdeForN(11) ≈ 59pp; headroom = 1 - 0.2 = 80pp > 59pp → powered
    const pred = makePrediction('strengthened', 0.2);
    expect(isHeadroomUnderpowered(pred, 11)).toBe(false);
  });

  it('returns true for removed with low baseline (room to decrease is small)', () => {
    // headroom for removed = baselineEstimate = 0.05; mdeForN(11) ≈ 59pp → underpowered
    const pred = makePrediction('removed', 0.05);
    expect(isHeadroomUnderpowered(pred, 11)).toBe(true);
  });

  it('returns false for removed with high baseline (plenty of room to decrease)', () => {
    // headroom for removed = baselineEstimate = 0.90; mdeForN(11) ≈ 59pp → powered
    const pred = makePrediction('removed', 0.90);
    expect(isHeadroomUnderpowered(pred, 11)).toBe(false);
  });

  it('returns false at the boundary: headroom exactly equals MDE', () => {
    // Find a probeCount where mde matches a round number and set headroom equal.
    // mdeForN(n) for n=11: compute directly.
    const mde = mdeForN(11);
    // headroom = mde means exactly at boundary → not underpowered (< not ≤)
    const baselineEstimate = 1 - mde; // for 'added': headroom = 1 - estimate = mde
    const pred = makePrediction('added', baselineEstimate);
    expect(isHeadroomUnderpowered(pred, 11)).toBe(false);
  });
});

describe('headroomPreflightLine', () => {
  it('mentions the prediction id, direction, estimate, headroom, and MDE', () => {
    const pred = makePrediction('strengthened', 0.93);
    const line = headroomPreflightLine(pred, 11);
    expect(line).toContain('p1');
    expect(line).toContain('strengthened');
    expect(line).toContain('93%'); // a rate renders as a percent; differences as pp
    expect(line).toContain('7pp'); // headroom (1-0.93)
    // MDE at 11 probes ≈ 59pp
    expect(line).toMatch(/\d{2,}pp/); // at least some MDE mention
  });

  it('says increase for added/strengthened directions', () => {
    const added = makePrediction('added', 0.9);
    expect(headroomPreflightLine(added, 11)).toContain('increase');

    const strengthened = makePrediction('strengthened', 0.9);
    expect(headroomPreflightLine(strengthened, 11)).toContain('increase');
  });

  it('says decrease for removed/weakened directions', () => {
    const removed = makePrediction('removed', 0.05);
    expect(headroomPreflightLine(removed, 11)).toContain('decrease');

    const weakened = makePrediction('weakened', 0.05);
    expect(headroomPreflightLine(weakened, 11)).toContain('decrease');
  });

  it('includes underpowered language', () => {
    const pred = makePrediction('strengthened', 0.93);
    const line = headroomPreflightLine(pred, 11);
    expect(line).toContain('underpowered');
  });
});

// ---------------------------------------------------------------------------
// (d) Post-hoc limit line
// ---------------------------------------------------------------------------

describe('headroomLimitLine', () => {
  it('returns undefined when headroom >= MDE (no warning needed)', () => {
    // Observed baseline 0.2 for 'strengthened' at n=11:
    // headroom = 0.8; mdeForN(11) ≈ 0.59pp → 0.8 > 0.59 → no warning
    expect(headroomLimitLine(0.2, 'strengthened', 11, 'p1')).toBeUndefined();
  });

  it('returns a line when headroom < MDE (pilot 2 scenario)', () => {
    // Observed baseline 0.93 for 'strengthened' at n=11:
    // headroom = 0.07; mdeForN(11) ≈ 0.59 → 0.07 < 0.59 → warning
    const line = headroomLimitLine(0.93, 'strengthened', 11, 'p1');
    expect(line).toBeDefined();
    expect(line).toContain('p1');
    expect(line).toContain('93%'); // a rate renders as a percent; differences as pp
    expect(line).toContain('7pp');
    expect(line).toContain('increase');
  });

  it('returns undefined when headroom exactly equals MDE', () => {
    const mde = mdeForN(11);
    const observedBaseline = 1 - mde; // headroom = mde for 'added'
    // boundary case: headroom >= mde → undefined
    expect(headroomLimitLine(observedBaseline, 'added', 11, 'p1')).toBeUndefined();
  });

  it('returns a line for removed direction with low observed baseline', () => {
    // Observed baseline 0.05 for 'removed': headroom = 0.05; mdeForN(11) ≈ 0.59 → warning
    const line = headroomLimitLine(0.05, 'removed', 11, 'p2');
    expect(line).toBeDefined();
    expect(line).toContain('p2');
    expect(line).toContain('5%'); // baseline rate as a percent
    expect(line).toContain('5pp'); // headroom (a difference) in pp
    expect(line).toContain('decrease');
  });

  it('returns undefined for removed when observed baseline is high', () => {
    // Observed baseline 0.9 for 'removed': headroom = 0.9 > mdeForN(11) ≈ 0.59 → no warning
    expect(headroomLimitLine(0.9, 'removed', 11, 'p1')).toBeUndefined();
  });

  it('mentions the MDE in the limit line', () => {
    const line = headroomLimitLine(0.93, 'strengthened', 11, 'p1');
    expect(line).toBeDefined();
    // Should mention the MDE in pp
    expect(line).toMatch(/\d{2,}pp/);
  });

  it('mentions "could not confirm" in the limit line', () => {
    const line = headroomLimitLine(0.93, 'strengthened', 11, 'p1');
    expect(line).toContain('could not confirm');
  });
});
