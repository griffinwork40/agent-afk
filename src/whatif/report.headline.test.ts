/**
 * Tests for `src/whatif/report.headline.ts`.
 *
 * Covers all acceptance criteria from issue #2406:
 *   - All CIs spanning zero → "No clear behavioral difference detected"
 *   - delta 0.30 CI [0.10, 0.50] → "much more often"
 *   - Small significant delta (0.05 CI [0.01, 0.09]) → "slightly"
 *   - Mid delta (0.15) CI [0.01, 0.29] → no adverb ("more often")
 *   - Negative significant → "less often"
 *   - Summary "0 confirmed, 2 refuted, 2 unclear (of 4 predictions)"
 *   - Non-significant larger delta does not beat smaller significant one
 */

import { describe, expect, it } from 'vitest';
import { buildHeadline } from './report.headline.js';
import type {
  FeatureDelta,
  Prediction,
  VerifiedPrediction,
  VerifyResult,
  WhatifReport,
} from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePred(id: string, behavior = 'answered without tools'): Prediction {
  return {
    id,
    behavior,
    direction: 'strengthened',
    confidence: 'high',
    reason: 'A rule changed.',
    testQuestion: 'Did the agent answer without tools?',
    probes: ['Fix the bug.'],
  };
}

function makeVP(
  id: string,
  delta: number,
  ci: [number, number],
  verdict: 'confirmed' | 'refuted' | 'unclear' | 'unobservable',
  behavior = 'answered without tools',
): VerifiedPrediction {
  const baseline = 0.5;
  const candidate = baseline + delta;
  return {
    prediction: makePred(id, behavior),
    rates: { baseline, candidate, delta, ci, n: { baseline: 20, candidate: 20 } },
    verdict,
  };
}

function makeFeature(
  label: string,
  delta: number,
  ci: [number, number],
): FeatureDelta {
  const baseline = 0.4;
  const candidate = baseline + delta;
  return {
    label,
    rates: { baseline, candidate, delta, ci, n: { baseline: 20, candidate: 20 } },
  };
}

function makeVerify(
  predictions: VerifiedPrediction[],
  features: FeatureDelta[] = [],
  predictionAccuracy?: number,
): VerifyResult {
  return {
    predictions,
    discovered: [],
    features,
    episodes: 20,
    samples: 2,
    judge: { name: 'claude', external: false },
    predictionAccuracy,
    truncatedByBudget: false,
    failedEpisodes: 0,
  };
}

function makeReport(verify?: VerifyResult): Omit<WhatifReport, 'headline'> {
  return {
    spec: { title: 'Test spec', changes: [] },
    structural: {
      baseline: { model: 'claude-sonnet-5', system: '', tools: [], firstUserMessage: '' },
      candidate: { model: 'claude-sonnet-5', system: '', tools: [], firstUserMessage: '' },
      systemDiff: '',
      toolsAdded: [],
      toolsRemoved: [],
      toolsChanged: [],
      userMessageDiff: '',
      tokens: { baseline: 1000, candidate: 1000 },
      modelChanged: false,
    },
    predictions: [],
    verify,
    costUsd: 0.01,
    runDir: '/tmp/test',
    limits: [],
  };
}

// ---------------------------------------------------------------------------
// Tests: headline gated on significance
// ---------------------------------------------------------------------------

describe('buildHeadline — significance gate', () => {
  it('all CIs spanning zero → "No clear behavioral difference detected"', () => {
    // Two predictions with CIs that both span zero
    const vps = [
      makeVP('p1', 0.07, [-0.077, 0.145], 'unclear'), // the real-world example from the bug
      makeVP('p2', 0.05, [-0.05, 0.10], 'unclear'),
    ];
    const features = [makeFeature('asked before acting', 0.12, [-0.05, 0.25])];
    const h = buildHeadline(makeReport(makeVerify(vps, features, undefined)));
    expect(h).toContain('No clear behavioral difference detected');
    expect(h).not.toContain('more often');
    expect(h).not.toContain('less often');
  });

  it('all CIs spanning zero → never says "more often" or "less often"', () => {
    const vps = [makeVP('p1', 0.20, [-0.02, 0.42], 'unclear')];
    const h = buildHeadline(makeReport(makeVerify(vps, [], undefined)));
    expect(h).not.toContain('more often');
    expect(h).not.toContain('less often');
  });

  it('includes observed shift note when a non-significant delta exists', () => {
    const vps = [makeVP('p1', 0.07, [-0.077, 0.145], 'unclear', 'answered without tools')];
    const h = buildHeadline(makeReport(makeVerify(vps, [], undefined)));
    // Should include fallback note with pct values
    expect(h).toContain('not significant');
    expect(h).toContain('answered without tools');
  });
});

// ---------------------------------------------------------------------------
// Tests: adverb scaling
// ---------------------------------------------------------------------------

describe('buildHeadline — adverb scaling', () => {
  it('delta 0.30 CI [0.10, 0.50] → "much more often"', () => {
    const vps = [makeVP('p1', 0.30, [0.10, 0.50], 'confirmed', 'answered without tools')];
    const h = buildHeadline(makeReport(makeVerify(vps, [], 1)));
    expect(h).toContain('much more often');
  });

  it('small significant delta (0.05 CI [0.01, 0.09]) → "slightly"', () => {
    const vps = [makeVP('p1', 0.05, [0.01, 0.09], 'confirmed', 'answered without tools')];
    const h = buildHeadline(makeReport(makeVerify(vps, [], 1)));
    expect(h).toContain('slightly');
    expect(h).toContain('more often');
  });

  it('mid delta (0.15 CI [0.01, 0.29]) → no adverb ("more often" without "much" or "slightly")', () => {
    const vps = [makeVP('p1', 0.15, [0.01, 0.29], 'confirmed', 'answered without tools')];
    const h = buildHeadline(makeReport(makeVerify(vps, [], 1)));
    expect(h).toContain('more often');
    expect(h).not.toContain('much');
    expect(h).not.toContain('slightly');
  });

  it('negative significant delta → "less often"', () => {
    // CI [−0.40, −0.10] → both negative → excludes zero
    const vp: VerifiedPrediction = {
      prediction: makePred('p1', 'answered without tools'),
      rates: { baseline: 0.6, candidate: 0.4, delta: -0.20, ci: [-0.40, -0.10], n: { baseline: 20, candidate: 20 } },
      verdict: 'refuted',
    };
    const h = buildHeadline(makeReport(makeVerify([vp], [], 0)));
    expect(h).toContain('less often');
    expect(h).not.toContain('more often');
  });

  it('boundary: delta exactly 0.10 → no adverb (threshold is exclusive <0.10)', () => {
    const vps = [makeVP('p1', 0.10, [0.01, 0.19], 'confirmed')];
    const h = buildHeadline(makeReport(makeVerify(vps, [], 1)));
    expect(h).not.toContain('slightly');
    expect(h).not.toContain('much');
  });

  it('boundary: delta exactly 0.25 → no adverb (threshold is exclusive >0.25)', () => {
    const vps = [makeVP('p1', 0.25, [0.01, 0.49], 'confirmed')];
    const h = buildHeadline(makeReport(makeVerify(vps, [], 1)));
    expect(h).not.toContain('much');
    expect(h).not.toContain('slightly');
  });
});

// ---------------------------------------------------------------------------
// Tests: prediction summary total
// ---------------------------------------------------------------------------

describe('buildHeadline — prediction summary', () => {
  it('names total count: "0 confirmed, 2 refuted, 2 unclear (of 4 predictions)"', () => {
    const vps2 = [
      makeVP('p1', 0.07, [-0.077, 0.145], 'unclear'),
      makeVP('p2', 0.05, [-0.05, 0.10], 'unclear'),
      makeVP('p3', -0.20, [-0.40, -0.10], 'refuted'),
      makeVP('p4', -0.15, [-0.35, -0.05], 'refuted'),
    ];
    const h = buildHeadline(makeReport(makeVerify(vps2, [], 0)));
    expect(h).toContain('0 confirmed');
    expect(h).toContain('2 refuted');
    expect(h).toContain('2 unclear');
    expect(h).toContain('(of 4 predictions)');
  });

  it('always names total even when all predictions confirmed', () => {
    const vps = [
      makeVP('p1', 0.30, [0.10, 0.50], 'confirmed'),
      makeVP('p2', 0.20, [0.02, 0.38], 'confirmed'),
    ];
    const h = buildHeadline(makeReport(makeVerify(vps, [], 1)));
    expect(h).toContain('(of 2 predictions)');
    expect(h).toContain('2 confirmed');
  });

  it('still names unclear predictions when every verdict is unclear (predictionAccuracy undefined)', () => {
    const vps = [
      makeVP('p1', 0.07, [-0.077, 0.145], 'unclear'),
      makeVP('p2', 0.05, [-0.05, 0.10], 'unclear'),
    ];
    const h = buildHeadline(makeReport(makeVerify(vps, [], undefined)));
    expect(h).toContain('0 confirmed, 0 refuted, 2 unclear (of 2 predictions)');
  });

  it('names unobservable predictions as their own bucket (#2409)', () => {
    const vps = [
      makeVP('p1', 0.30, [0.10, 0.50], 'confirmed', 'asked clarifying questions'),
      makeVP('p2', -0.20, [-0.40, -0.10], 'refuted'),
      makeVP('p3', 0.05, [-0.05, 0.10], 'unclear'),
      makeVP('p4', 0.02, [-0.05, 0.08], 'unclear'),
      makeVP('p5', 0.0, [-0.1, 0.1], 'unobservable'),
    ];
    const h = buildHeadline(makeReport(makeVerify(vps, [], 0.5)));
    expect(h).toContain('1 confirmed, 1 refuted, 2 unclear, 1 unobservable (of 5 predictions)');
  });

  it('omits the unobservable bucket when there are none', () => {
    const vps = [makeVP('p1', 0.07, [-0.077, 0.145], 'unclear')];
    const h = buildHeadline(makeReport(makeVerify(vps, [], undefined)));
    expect(h).not.toContain('unobservable');
  });

  it('never headlines an unobservable prediction as an effect, even if its CI excludes zero', () => {
    const vps = [
      makeVP('p1', -0.40, [-0.60, -0.20], 'unobservable', 'spawned a subagent'),
      makeVP('p2', 0.05, [-0.05, 0.10], 'unclear', 'answered without tools'),
    ];
    const h = buildHeadline(makeReport(makeVerify(vps, [], undefined)));
    expect(h).not.toContain('spawned a subagent');
    expect(h).toContain('No clear behavioral difference detected');
    expect(h).toContain('0 confirmed, 0 refuted, 1 unclear, 1 unobservable (of 2 predictions)');
  });

  it('no accuracy string when the verify run has no predictions', () => {
    const h = buildHeadline(makeReport(makeVerify([], [], undefined)));
    expect(h).not.toContain('predictions)');
  });
});

// ---------------------------------------------------------------------------
// Tests: non-significant larger delta does not beat smaller significant one
// ---------------------------------------------------------------------------

describe('buildHeadline — significant beats non-significant', () => {
  it('a non-significant larger delta does not beat a smaller significant one', () => {
    // sig: delta=0.15 CI=[0.01, 0.29] (significant, smaller)
    // nonsig: delta=0.40 CI=[-0.02, 0.82] (not significant, bigger absolute value)
    const vps = [
      makeVP('p1', 0.15, [0.01, 0.29], 'confirmed', 'asked clarifying questions'),
      makeVP('p2', 0.40, [-0.02, 0.82], 'unclear', 'answered without tools'),
    ];
    const h = buildHeadline(makeReport(makeVerify(vps, [], 1)));
    // Should mention the significant one (asked clarifying questions) not the bigger non-sig one
    expect(h).toContain('asked clarifying questions');
    expect(h).not.toContain('answered without tools');
    expect(h).toContain('more often');
    expect(h).not.toContain('much');
  });
});

// ---------------------------------------------------------------------------
// Tests: feature deltas
// ---------------------------------------------------------------------------

describe('buildHeadline — feature deltas', () => {
  it('significant feature delta wins over non-significant prediction delta', () => {
    const vps = [makeVP('p1', 0.07, [-0.05, 0.19], 'unclear', 'answered without tools')];
    const features = [makeFeature('used tools', 0.30, [0.10, 0.50])];
    const h = buildHeadline(makeReport(makeVerify(vps, features, undefined)));
    expect(h).toContain('used tools');
    expect(h).toContain('much more often');
    expect(h).not.toContain('No clear');
  });
});

// ---------------------------------------------------------------------------
// Tests: predict-only branch unchanged
// ---------------------------------------------------------------------------

describe('buildHeadline — predict-only (unchanged)', () => {
  it('predict-only: returns prediction description', () => {
    const report = makeReport(undefined);
    (report as WhatifReport & { predictions: Prediction[] }).predictions = [makePred('p1', 'asks clarifying questions')];
    const h = buildHeadline(report);
    expect(h).toContain('Predicted (not yet measured)');
    expect(h).toContain('asks clarifying questions');
  });

  it('predict-only: no predictions → "No behavioral changes"', () => {
    const h = buildHeadline(makeReport(undefined));
    expect(h).toContain('No behavioral changes');
  });
});
