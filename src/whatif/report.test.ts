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

function makeUnobservablePred(id: string): VerifiedPrediction {
  return {
    prediction: makePred(id),
    rates: { baseline: 0.1, candidate: 0.1, delta: 0.0, ci: [-0.3, 0.3], n: { baseline: 10, candidate: 10 } },
    verdict: 'unobservable',
    unobservableReason: 'downstream of the episode boundary: the tests must run to completion',
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

  it('unobservable verdict shows 🔭 marker and reason in MD table', () => {
    const vp = makeUnobservablePred('p1');
    const report = makeReport(makeVerifyResult([vp]));
    const md = renderMarkdown(report);
    expect(md).toContain('🔭');
    expect(md).toContain('unobservable');
    expect(md).toContain('episode boundary');
  });

  it('unobservable is not counted as resolved in headline', () => {
    const vp = makeUnobservablePred('p1');
    const verify = makeVerifyResult([vp]);
    // Override predictionAccuracy to undefined (no resolved predictions)
    verify.predictionAccuracy = undefined;
    const report = makeReport(verify);
    // Headline must not claim any predictions were confirmed/refuted; the
    // unobservable one gets its own bucket (#2406 wording + #2409).
    expect(report.headline).toContain('0 confirmed, 0 refuted, 0 unclear, 1 unobservable (of 1 predictions)');
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown: per-prediction evidence (#2403)
// ---------------------------------------------------------------------------

describe('renderMarkdown: per-prediction scope', () => {
  it('shows probe count, n, background rate, and contributing episodes', () => {
    const vp: VerifiedPrediction = {
      ...makeVerifiedPred('p1', 'confirmed'),
      rates: { baseline: 0, candidate: 1, delta: 1, ci: [0.3, 1], n: { baseline: 6, candidate: 6 } },
      scope: {
        episodes: { baseline: ['s1', 's2'], candidate: ['s1', 's2'] },
        targetedEpisodes: 2,
        background: { baseline: 0.1, candidate: 0.15, delta: 0.05, ci: [-0.1, 0.2], n: { baseline: 54, candidate: 54 } },
      },
    };
    const md = renderMarkdown(makeReport(makeVerifyResult([vp])));
    expect(md).toContain('Scored on');
    expect(md).toContain('2 probes, n=6/6');
    expect(md).toContain('10% → 15% (n=54/54)');
    expect(md).toContain('- p1: s1, s2');
    expect(md).toContain('does not affect the result');
  });

  it('zero graded probes renders as unclear with a plain note', () => {
    const vp: VerifiedPrediction = {
      prediction: makePred('p1'),
      rates: { baseline: 0, candidate: 0, delta: 0, ci: [-1, 1], n: { baseline: 0, candidate: 0 } },
      verdict: 'unclear',
      scope: { episodes: { baseline: [], candidate: [] }, targetedEpisodes: 1 },
    };
    const md = renderMarkdown(makeReport(makeVerifyResult([vp])));
    expect(md).toContain('no graded probes (1 planned)');
    expect(md).toContain('- p1: none graded');
    expect(md).toContain('⚪ unclear');
  });

  it('pre-#2403 result without scope still renders n', () => {
    const md = renderMarkdown(makeReport(makeVerifyResult([makeVerifiedPred('p1', 'confirmed')])));
    expect(md).toContain('n=20/20');
    expect(md).not.toContain('Episodes behind each result');
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

  it('unobservable verdict shows 🔭 and reason in terminal render', () => {
    const vp = makeUnobservablePred('p1');
    const report = makeReport(makeVerifyResult([vp]));
    const lines = renderTerminal(report, identityPalette);
    const joined = lines.join('\n');
    expect(joined).toContain('🔭');
    expect(joined).toContain('unobservable');
    expect(joined).toContain('episode boundary');
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

  it('verified with small n: includes MDE limit bullet for underpowered predictions', () => {
    // n=20 per arm → MDE ≈ 62pp > 10pp → limit line should appear
    const vp = makeVerifiedPred('p1', 'unclear');
    const limits = standardLimits({ verified: true, judgeExternal: false, verifiedPredictions: [vp] });
    const mdeLimits = limits.filter((l) => l.includes('p1'));
    expect(mdeLimits.length).toBeGreaterThan(0);
    expect(mdeLimits[0]).toContain('undetectable');
    expect(mdeLimits[0]).toContain('n=20');
  });

  it('verified with large n: no MDE limit bullet when powered', () => {
    // n=769 per arm → MDE ≈ 10pp = threshold → no limit
    const vpLarge: VerifiedPrediction = {
      prediction: makePred('p2'),
      rates: {
        baseline: 0.5, candidate: 0.5, delta: 0, ci: [-0.1, 0.1],
        n: { baseline: 769, candidate: 769 },
      },
      verdict: 'unclear',
    };
    const limits = standardLimits({ verified: true, judgeExternal: false, verifiedPredictions: [vpLarge] });
    const mdeLimits = limits.filter((l) => l.includes('p2'));
    expect(mdeLimits.length).toBe(0);
  });

  it('no verifiedPredictions: no MDE bullets', () => {
    const limits = standardLimits({ verified: true, judgeExternal: false });
    const mdeLimits = limits.filter((l) => l.includes('undetectable'));
    expect(mdeLimits.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown: failed episodes table and arm-imbalance banner (#2411)
// ---------------------------------------------------------------------------

describe('renderMarkdown: failed episodes', () => {
  it('no failed episodes: no Failed Episodes section', () => {
    const vp = makeVerifiedPred('p1', 'confirmed');
    const verify = makeVerifyResult([vp]);
    verify.failedEpisodeRecords = [];
    const md = renderMarkdown(makeReport(verify));
    expect(md).not.toContain('## Failed Episodes');
  });

  it('shows Failed Episodes table with arm, class, duration, message', () => {
    const vp = makeVerifiedPred('p1', 'confirmed');
    const verify = makeVerifyResult([vp]);
    verify.failedEpisodes = 1;
    verify.failedEpisodeRecords = [
      {
        episodeId: 's3',
        arm: 'candidate',
        sample: 0,
        errorClass: 'timeout',
        errorMessage: 'Episode timed out after 180000ms.',
        durationMs: 180007,
      },
    ];
    const md = renderMarkdown(makeReport(verify));
    expect(md).toContain('## Failed Episodes');
    expect(md).toContain('s3');
    expect(md).toContain('candidate');
    expect(md).toContain('timeout');
    expect(md).toContain('180.0s');
    expect(md).toContain('Episode timed out after 180000ms.');
  });

  it('includes probe column when probe is set on a failure record', () => {
    const vp = makeVerifiedPred('p1', 'confirmed');
    const verify = makeVerifyResult([vp]);
    verify.failedEpisodes = 1;
    verify.failedEpisodeRecords = [
      {
        episodeId: 's6',
        arm: 'candidate',
        sample: 0,
        errorClass: 'timeout',
        errorMessage: 'timed out',
        probe: 'p2',
        durationMs: 180000,
      },
    ];
    const md = renderMarkdown(makeReport(verify));
    expect(md).toContain('s6 (p2)');
  });

  it('shows arm-imbalance warning block when armImbalance is set', () => {
    const vp = makeVerifiedPred('p1', 'unclear');
    const verify = makeVerifyResult([vp]);
    verify.failedEpisodes = 6;
    verify.failedEpisodeRecords = [];
    verify.armImbalance = {
      baselineFailRate: 0,
      candidateFailRate: 0.375,
      rateDiff: 0.375,
      allInOneArm: true,
      concentrationArm: 'candidate',
      summary:
        'Arm-imbalance warning: failures are concentrated in one arm (all 6 failures in the candidate arm). This may bias the verdict toward "no change". Consider raising --timeout.',
    };
    const md = renderMarkdown(makeReport(verify));
    expect(md).toContain('[!WARNING]');
    expect(md).toContain('Arm-imbalance warning');
    expect(md).toContain('--timeout');
  });

  it('no arm-imbalance warning when armImbalance is absent', () => {
    const vp = makeVerifiedPred('p1', 'confirmed');
    const md = renderMarkdown(makeReport(makeVerifyResult([vp])));
    expect(md).not.toContain('[!WARNING]');
    expect(md).not.toContain('Arm-imbalance warning');
  });
});

// ---------------------------------------------------------------------------
// renderTerminal: arm-imbalance banner (#2411)
// ---------------------------------------------------------------------------

describe('renderTerminal: arm-imbalance banner', () => {
  const identityPalette = new Proxy(
    {},
    { get: () => (s: string) => s },
  ) as Parameters<typeof renderTerminal>[1];

  it('shows imbalance banner at the top when armImbalance is set', () => {
    const verify = makeVerifyResult([makeVerifiedPred('p1', 'unclear')]);
    verify.armImbalance = {
      baselineFailRate: 0,
      candidateFailRate: 0.5,
      rateDiff: 0.5,
      allInOneArm: true,
      concentrationArm: 'candidate',
      summary: 'Arm-imbalance warning: test summary.',
    };
    const report = makeReport(verify);
    const lines = renderTerminal(report, identityPalette);
    const joined = lines.join('\n');
    expect(joined).toContain('Arm-imbalance warning');
    // Banner must appear before the headline (first non-empty line).
    const bannerIdx = lines.findIndex((l) => l.includes('Arm-imbalance warning'));
    const headlineIdx = lines.findIndex((l) => l === report.headline);
    expect(bannerIdx).toBeLessThan(headlineIdx);
  });

  it('no banner when armImbalance is absent', () => {
    const report = makeReport(makeVerifyResult([makeVerifiedPred('p1', 'confirmed')]));
    const lines = renderTerminal(report, identityPalette);
    expect(lines.every((l) => !l.includes('Arm-imbalance'))).toBe(true);
  });
});
