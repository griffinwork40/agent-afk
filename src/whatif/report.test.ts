/**
 * Tests for `src/whatif/report.ts`.
 *
 * Snapshot-ish assertions on key strings; no model calls, no I/O.
 */

import { describe, expect, it } from 'vitest';
import {
  buildHeadline,
  renderMarkdown,
  renderTerminal,
  standardLimits,
} from './report.js';
import type {
  ChangeSpec,
  FeatureDelta,
  Prediction,
  RequestSnapshot,
  StructuralImpact,
  VerifiedPrediction,
  VerifyResult,
  WhatifReport,
} from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(model = 'claude-sonnet-5'): RequestSnapshot {
  return {
    model,
    system: 'System prompt.',
    tools: [{ name: 'bash', description: 'Run shell commands.' }],
    firstUserMessage: 'Hello.',
  };
}

function makeStructural(): StructuralImpact {
  return {
    baseline: makeSnapshot(),
    candidate: makeSnapshot(),
    systemDiff: '',
    toolsAdded: [],
    toolsRemoved: [],
    toolsChanged: [],
    userMessageDiff: '',
    tokens: { baseline: 5000, candidate: 5200 },
    perTurnCostDeltaUsd: 0.0004,
    modelChanged: false,
  };
}

function makePred(id: string): Prediction {
  return {
    id,
    behavior: 'asks clarifying questions',
    direction: 'strengthened',
    confidence: 'high',
    reason: 'A rule was added to AFK.md.',
    testQuestion: 'Does the agent ask a clarifying question?',
    probes: ['Fix the bug.'],
  };
}

function makeSpec(): ChangeSpec {
  return {
    title: 'Add always-ask rule to AFK.md',
    changes: [{ kind: 'append', target: 'user-afk-md', text: 'Always ask.' }],
  };
}

function makeVerifiedPred(id: string, verdict: 'confirmed' | 'refuted' | 'unclear'): VerifiedPrediction {
  return {
    prediction: makePred(id),
    rates: { baseline: 0.3, candidate: 0.7, delta: 0.4, ci: [0.1, 0.7], n: { baseline: 20, candidate: 20 } },
    verdict,
  };
}

function makeFeatureDelta(label: string): FeatureDelta {
  return {
    label,
    rates: { baseline: 0.4, candidate: 0.6, delta: 0.2, ci: [-0.1, 0.5], n: { baseline: 20, candidate: 20 } },
  };
}

function makeVerifyResult(
  predictions: VerifiedPrediction[],
): VerifyResult {
  return {
    predictions,
    discovered: [],
    features: [makeFeatureDelta('Asked before acting')],
    episodes: 20,
    samples: 2,
    judge: { name: 'claude', external: false, crossCheckAgreement: 0.88 },
    predictionAccuracy: 0.75,
    truncatedByBudget: false,
    failedEpisodes: 0,
  };
}

function makeReport(verify?: VerifyResult): WhatifReport {
  const report: Omit<WhatifReport, 'headline'> = {
    spec: makeSpec(),
    structural: makeStructural(),
    predictions: [makePred('p1'), makePred('p2')],
    verify,
    costUsd: 0.042,
    runDir: '/tmp/whatif-run-1',
    limits: standardLimits({ verified: !!verify, judgeExternal: false }),
  };
  return { ...report, headline: buildHeadline(report) };
}

// ---------------------------------------------------------------------------
// buildHeadline
// ---------------------------------------------------------------------------

describe('buildHeadline', () => {
  it('predict-only: mentions the first prediction behavior', () => {
    const report = makeReport();
    const h = report.headline;
    expect(h).toContain('asks clarifying questions');
    expect(h).toContain('Predicted');
  });

  it('predict-only: no predictions → "No behavioral changes"', () => {
    const report: Omit<WhatifReport, 'headline'> = {
      ...makeReport(),
      predictions: [],
    };
    const h = buildHeadline(report);
    expect(h).toContain('No behavioral changes');
  });

  it('verified: mentions a rate shift', () => {
    const vp = makeVerifiedPred('p1', 'confirmed');
    const report = makeReport(makeVerifyResult([vp]));
    const h = report.headline;
    // Should mention rates (30% → 70%)
    expect(h).toMatch(/30|40|70/);
  });

  it('verified: contains prediction accuracy info when present', () => {
    const vp = makeVerifiedPred('p1', 'confirmed');
    const verify = makeVerifyResult([vp]);
    verify.predictionAccuracy = 0.75;
    const report = makeReport(verify);
    // Should mention confirmed predictions
    expect(report.headline).toMatch(/prediction|confirmed/i);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  it('contains the headline', () => {
    const report = makeReport();
    const md = renderMarkdown(report);
    expect(md).toContain(report.headline);
  });

  it('contains the spec title', () => {
    const report = makeReport();
    const md = renderMarkdown(report);
    expect(md).toContain('Add always-ask rule to AFK.md');
  });

  it('contains "Predictions" section', () => {
    const report = makeReport();
    const md = renderMarkdown(report);
    expect(md).toContain('## Predictions');
  });

  it('predict-only: contains "guesses" label', () => {
    const report = makeReport();
    const md = renderMarkdown(report);
    expect(md).toContain('guess');
  });

  it('verified: contains Confirmed/Refuted/Unclear', () => {
    const vps = [
      makeVerifiedPred('p1', 'confirmed'),
      makeVerifiedPred('p2', 'refuted'),
    ];
    const report = makeReport(makeVerifyResult(vps));
    const md = renderMarkdown(report);
    expect(md).toContain('confirmed');
    expect(md).toContain('refuted');
  });

  it('verified: contains Measured Behaviors section', () => {
    const vp = makeVerifiedPred('p1', 'confirmed');
    const report = makeReport(makeVerifyResult([vp]));
    const md = renderMarkdown(report);
    expect(md).toContain('Measured Behaviors');
    expect(md).toContain('Asked before acting');
  });

  it('contains Structural Impact section with token delta', () => {
    const report = makeReport();
    const md = renderMarkdown(report);
    expect(md).toContain('Structural Impact');
    expect(md).toContain('5,000');
    expect(md).toContain('5,200');
  });

  it('model change appears when modelChanged is true', () => {
    const report = makeReport();
    report.structural = {
      ...makeStructural(),
      baseline: makeSnapshot('claude-sonnet-5'),
      candidate: makeSnapshot('claude-opus-5'),
      modelChanged: true,
    };
    const md = renderMarkdown(report);
    expect(md).toContain('claude-opus-5');
    expect(md).toContain('Model');
  });

  it('contains Limits section', () => {
    const report = makeReport();
    const md = renderMarkdown(report);
    expect(md).toContain('## Limits');
    expect(md).toContain('side effects');
  });

  it('contains cost and run folder', () => {
    const report = makeReport();
    const md = renderMarkdown(report);
    expect(md).toContain('0.0420');
    expect(md).toContain('/tmp/whatif-run-1');
  });

  it('system diff appears in <details> block when present', () => {
    const report = makeReport();
    report.structural.systemDiff = '+Added line\n-Removed line';
    const md = renderMarkdown(report);
    expect(md).toContain('<details>');
    expect(md).toContain('```diff');
    expect(md).toContain('+Added line');
  });

  it('tools added/removed appear', () => {
    const report = makeReport();
    report.structural.toolsAdded = ['new_tool'];
    report.structural.toolsRemoved = ['old_tool'];
    const md = renderMarkdown(report);
    expect(md).toContain('new_tool');
    expect(md).toContain('old_tool');
  });

  it('judge line appears in verified report', () => {
    const vp = makeVerifiedPred('p1', 'confirmed');
    const report = makeReport(makeVerifyResult([vp]));
    const md = renderMarkdown(report);
    expect(md).toContain('claude');
    expect(md).toContain('88%');
  });
});

// ---------------------------------------------------------------------------
// renderTerminal
// ---------------------------------------------------------------------------

describe('renderTerminal', () => {
  // Build a mock palette with identity functions.
  const identityPalette = new Proxy(
    {},
    {
      get: () => (s: string) => s,
    },
  ) as Parameters<typeof renderTerminal>[1];

  it('returns an array of strings', () => {
    const report = makeReport();
    const lines = renderTerminal(report, identityPalette);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.every((l) => typeof l === 'string')).toBe(true);
  });

  it('contains the headline', () => {
    const report = makeReport();
    const lines = renderTerminal(report, identityPalette);
    const joined = lines.join('\n');
    expect(joined).toContain(report.headline);
  });

  it('contains prediction behaviors', () => {
    const report = makeReport();
    const lines = renderTerminal(report, identityPalette);
    const joined = lines.join('\n');
    expect(joined).toContain('asks clarifying questions');
  });

  it('verified: shows verdict labels', () => {
    const vp = makeVerifiedPred('p1', 'confirmed');
    const report = makeReport(makeVerifyResult([vp]));
    const lines = renderTerminal(report, identityPalette);
    const joined = lines.join('\n');
    expect(joined).toContain('confirmed');
  });

  it('contains cost at end', () => {
    const report = makeReport();
    const lines = renderTerminal(report, identityPalette);
    const joined = lines.join('\n');
    expect(joined).toContain('0.0420');
  });
});

// ---------------------------------------------------------------------------
// standardLimits
// ---------------------------------------------------------------------------

describe('standardLimits', () => {
  it('always includes side-effects note', () => {
    const limits = standardLimits({ verified: false, judgeExternal: false });
    expect(limits.some((l) => l.includes('side effects'))).toBe(true);
  });

  it('predict-only: includes guesses note', () => {
    const limits = standardLimits({ verified: false, judgeExternal: false });
    expect(limits.some((l) => l.includes('guesses'))).toBe(true);
  });

  it('verified: does not include guesses note', () => {
    const limits = standardLimits({ verified: true, judgeExternal: false });
    expect(limits.every((l) => !l.includes('guesses'))).toBe(true);
  });

  it('verified: includes stripped context note', () => {
    const limits = standardLimits({ verified: true, judgeExternal: false });
    expect(limits.some((l) => l.includes('context stripped'))).toBe(true);
  });

  it('external judge: includes Jev note', () => {
    const limits = standardLimits({ verified: false, judgeExternal: true });
    expect(limits.some((l) => l.toLowerCase().includes('jev') || l.includes('external'))).toBe(true);
  });
});
