/**
 * Tests for src/whatif/baseline-sample.ts (#2511).
 *
 * Covers:
 * - headroom math for all four prediction directions
 * - gate trips (refuses; warnOnly is an inspection hook), and is not bypassed by --force
 * - --no-baseline-sample skips sampling and analyst-estimate check still works
 * - cost estimate includes the sample
 * - sample calls runner with baseline arm only
 * - results.json baselineSample field is present
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  runBaselineSample,
  estimateBaselineSampleCost,
  BASELINE_SAMPLE_K,
  type PredictionBaselineSample,
} from './baseline-sample.js';
import { runWhatif, WhatifMdeError } from './run.js';
import { getWhatifDir } from '../paths.js';
import { estimateVerifyCost } from './cost.js';
import { headroomForPrediction, mdeForN } from './mde.js';
import type {
  AgentRunner,
  ChangeSpec,
  CompleteFn,
  Environment,
  Episode,
  EpisodeTrace,
  Judge,
  JudgeInput,
  Prediction,
  RequestSnapshot,
  RunnerOptions,
  WhatifDeps,
  WhatifOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASELINE_SYSTEM = 'You are baseline assistant.';
const CANDIDATE_SYSTEM = 'You are candidate assistant. Always ask before acting.';

function makeSnap(system: string): RequestSnapshot {
  return {
    model: 'claude-haiku-4-5-20250929',
    system,
    tools: [],
    firstUserMessage: 'Briefly, what can you help me with in this project?',
  };
}

function makeBaselineTrace(episodeId: string, pYes: number): EpisodeTrace {
  return {
    episodeId,
    env: 'baseline',
    sample: 0,
    text: pYes > 0.5 ? 'May I ask a question?' : 'Sure, writing the file.',
    tools: [],
    costUsd: 0.0001,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 50,
  };
}

function makeCandidateTrace(episodeId: string): EpisodeTrace {
  return {
    episodeId,
    env: 'candidate',
    sample: 0,
    text: 'Sure, writing the file.',
    tools: [],
    costUsd: 0.0001,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 50,
  };
}

function makeRunner(pYesByEpisode: Record<string, number> = {}): AgentRunner {
  return {
    name: 'fake',
    run: vi.fn(async (env: Environment, ep: Episode, _s: number): Promise<EpisodeTrace> => {
      if (env.label === 'candidate') return makeCandidateTrace(ep.id);
      const pYes = pYesByEpisode[ep.id] ?? 0.1;
      return makeBaselineTrace(ep.id, pYes);
    }),
    snapshot: vi.fn(async (env: Environment): Promise<RequestSnapshot> => {
      if (env.label === 'candidate') return makeSnap(CANDIDATE_SYSTEM);
      return makeSnap(BASELINE_SYSTEM);
    }),
  };
}

function makeJudge(pYesByPrediction: Record<string, number> = {}): Judge {
  return {
    name: 'claude',
    external: false,
    async grade(input: JudgeInput): Promise<Record<string, number>> {
      const result: Record<string, number> = {};
      for (const q of input.questions) {
        result[q.id] = pYesByPrediction[q.id] ?? 0.1;
      }
      return result;
    },
    close: vi.fn(async () => {}),
  };
}

function makePrediction(
  id: string,
  direction: Prediction['direction'],
  probeIds: string[],
): Prediction {
  return {
    id,
    behavior: `Prediction ${id}`,
    direction,
    confidence: 'high',
    reason: 'Test',
    testQuestion: `Question for ${id}`,
    probes: probeIds,
  };
}

function makeSyntheticEpisodes(predictions: Prediction[], perPrediction = BASELINE_SAMPLE_K): Episode[] {
  const eps: Episode[] = [];
  for (const p of predictions) {
    for (let i = 0; i < perPrediction; i++) {
      eps.push({
        id: `ep-${p.id}-${i}`,
        source: 'synthetic',
        prompt: `Probe ${i} for ${p.id}`,
        targets: p.id,
      });
    }
  }
  return eps;
}

function makeBaselineEnv(): Environment {
  return {
    label: 'baseline',
    home: '/tmp/baseline',
    cwd: '/tmp/baseline',
    launch: { model: 'claude-haiku-4-5-20250929', env: {} },
  };
}

function makeRunnerOpts(): RunnerOptions {
  return { timeoutMs: 5000, maxTurns: 1, signal: undefined };
}

// ---------------------------------------------------------------------------
// Unit tests: headroom math for all four directions
// ---------------------------------------------------------------------------

describe('headroomForPrediction — all four directions', () => {
  it('added: headroom = 1 - baselineEstimate', () => {
    expect(headroomForPrediction(0.9, 'added')).toBeCloseTo(0.1);
    expect(headroomForPrediction(0.05, 'added')).toBeCloseTo(0.95);
  });

  it('strengthened: headroom = 1 - baselineEstimate', () => {
    expect(headroomForPrediction(0.8, 'strengthened')).toBeCloseTo(0.2);
    expect(headroomForPrediction(0.2, 'strengthened')).toBeCloseTo(0.8);
  });

  it('removed: headroom = baselineEstimate', () => {
    expect(headroomForPrediction(0.1, 'removed')).toBeCloseTo(0.1);
    expect(headroomForPrediction(0.95, 'removed')).toBeCloseTo(0.95);
  });

  it('weakened: headroom = baselineEstimate', () => {
    expect(headroomForPrediction(0.05, 'weakened')).toBeCloseTo(0.05);
    expect(headroomForPrediction(0.7, 'weakened')).toBeCloseTo(0.7);
  });
});

// ---------------------------------------------------------------------------
// runBaselineSample: conservative gate uses most optimistic probe
// ---------------------------------------------------------------------------

describe('runBaselineSample — headroom math', () => {
  it('added: optimistic headroom = 1 - min(probeRates)', async () => {
    // p1 added, probe rates 0.9 and 0.6 → min=0.6, headroom=0.4
    const pred = makePrediction('p1', 'added', []);
    const eps = makeSyntheticEpisodes([pred]).slice(0, 2);
    // Use runner that returns trace with text reflecting pYes
    const runnerCustom: AgentRunner = {
      ...makeRunner(),
      run: vi.fn(async (_env: Environment, ep: Episode): Promise<EpisodeTrace> => {
        if (_env.label === 'candidate') return makeCandidateTrace(ep.id);
        return { ...makeBaselineTrace(ep.id, 0.5), episodeId: ep.id };
      }),
      snapshot: makeRunner().snapshot,
    };
    // Make judge always return fixed alternating rates and verify the math
    const rates: number[] = [0.9, 0.6];
    let callCount = 0;
    const judgeFixed: Judge = {
      name: 'claude', external: false, close: vi.fn(async () => {}),
      async grade(input: JudgeInput) {
        const r: Record<string, number> = {};
        for (const q of input.questions) { r[q.id] = rates[callCount % 2]!; }
        callCount++;
        return r;
      },
    };
    const result = await runBaselineSample({
      predictions: [pred],
      episodes: eps,
      baseline: makeBaselineEnv(),
      runner: runnerCustom,
      judge: judgeFixed,
      runnerOpts: makeRunnerOpts(),
      warnOnly: true, // don't throw; let us inspect
      onProgress: vi.fn(),
    });
    const s = result.perPrediction[0]!;
    // optimistic headroom = 1 - min(probeRates) = 1 - 0.6 = 0.4
    const minRate = Math.min(...s.probeRates);
    expect(s.optimisticHeadroom).toBeCloseTo(1 - minRate, 5);
  });

  it('removed: optimistic headroom = max(probeRates)', async () => {
    const pred = makePrediction('p1', 'removed', []);
    const eps = makeSyntheticEpisodes([pred]).slice(0, 2);
    const runnerCustom: AgentRunner = {
      ...makeRunner(),
      run: vi.fn(async (_env: Environment, ep: Episode): Promise<EpisodeTrace> => {
        return { ...makeBaselineTrace(ep.id, 0.5), env: _env.label === 'candidate' ? 'candidate' : 'baseline' };
      }),
      snapshot: makeRunner().snapshot,
    };
    let callCount = 0;
    const rates = [0.1, 0.4]; // max=0.4 → headroom=0.4
    const judgeFixed: Judge = {
      name: 'claude', external: false, close: vi.fn(async () => {}),
      async grade(input: JudgeInput) {
        const r: Record<string, number> = {};
        for (const q of input.questions) { r[q.id] = rates[callCount % 2]!; }
        callCount++;
        return r;
      },
    };
    const result = await runBaselineSample({
      predictions: [pred],
      episodes: eps,
      baseline: makeBaselineEnv(),
      runner: runnerCustom,
      judge: judgeFixed,
      runnerOpts: makeRunnerOpts(),
      warnOnly: true,
      onProgress: vi.fn(),
    });
    const s = result.perPrediction[0]!;
    const maxRate = Math.max(...s.probeRates);
    expect(s.optimisticHeadroom).toBeCloseTo(maxRate, 5);
  });
});

// ---------------------------------------------------------------------------
// Gate: refuses when it trips; warnOnly (inspection hook) warns and continues
// ---------------------------------------------------------------------------

describe('runBaselineSample — gate behaviour', () => {
  it('throws WhatifMdeError when headroom < MDE', async () => {
    // added prediction with high baseline (0.98) → headroom=0.02 < MDE ~= 0.99 at K=3
    const pred = makePrediction('p1', 'added', []);
    const eps = makeSyntheticEpisodes([pred]).slice(0, 3);
    const runnerCustom: AgentRunner = {
      ...makeRunner(),
      run: vi.fn(async (_env: Environment, ep: Episode): Promise<EpisodeTrace> => {
        return makeBaselineTrace(ep.id, 0.98);
      }),
      snapshot: makeRunner().snapshot,
    };
    const judgeFixed: Judge = {
      name: 'claude', external: false, close: vi.fn(async () => {}),
      async grade(input: JudgeInput) {
        const r: Record<string, number> = {};
        for (const q of input.questions) { r[q.id] = 0.98; }
        return r;
      },
    };
    const onProgress = vi.fn();
    await expect(
      runBaselineSample({
        predictions: [pred],
        episodes: eps,
        baseline: makeBaselineEnv(),
        runner: runnerCustom,
        judge: judgeFixed,
        runnerOpts: makeRunnerOpts(),
        warnOnly: false,
        onProgress,
      }),
    ).rejects.toBeInstanceOf(WhatifMdeError);
  });

  // Regression: the gate must use the FULL run's MDE (12 probes -> ~57pp),
  // not the 3-probe sample's (clamped to 100pp), or every run would trip.
  function fixedJudge(rate: number): Judge {
    return {
      name: 'claude', external: false, close: vi.fn(async () => {}),
      async grade(input: JudgeInput) {
        const r: Record<string, number> = {};
        for (const q of input.questions) { r[q.id] = rate; }
        return r;
      },
    };
  }

  it('does not trip with room to move when the full run has 12 probes', async () => {
    const pred = makePrediction('p1', 'added', []);
    const eps = makeSyntheticEpisodes([pred], 12);
    const result = await runBaselineSample({
      predictions: [pred], episodes: eps, baseline: makeBaselineEnv(),
      runner: makeRunner(), judge: fixedJudge(0.1), runnerOpts: makeRunnerOpts(), warnOnly: false,
    });
    expect(result.anyTripped).toBe(false);
    expect(result.perPrediction[0]?.mde).toBeCloseTo(0.57, 1);
    expect(result.perPrediction[0]?.probeRates).toHaveLength(BASELINE_SAMPLE_K);
  });

  it('trips on a saturated baseline against the full-run MDE (pilot 2 shape)', async () => {
    const pred = makePrediction('p1', 'strengthened', []);
    const eps = makeSyntheticEpisodes([pred], 11);
    const onProgress = vi.fn();
    await expect(runBaselineSample({
      predictions: [pred], episodes: eps, baseline: makeBaselineEnv(),
      runner: makeRunner(), judge: fixedJudge(0.93), runnerOpts: makeRunnerOpts(), warnOnly: false, onProgress,
    })).rejects.toBeInstanceOf(WhatifMdeError);
    const messages = onProgress.mock.calls.map((c: [{ message: string }]) => c[0].message);
    expect(messages.some((m) => m.includes('11 probes can only detect shifts ≥60pp'))).toBe(true);
  });

  it('prints warning but does not throw when warnOnly=true', async () => {
    const pred = makePrediction('p1', 'added', []);
    const eps = makeSyntheticEpisodes([pred]).slice(0, 3);
    const runnerCustom: AgentRunner = {
      ...makeRunner(),
      run: vi.fn(async (_env: Environment, ep: Episode): Promise<EpisodeTrace> => {
        return makeBaselineTrace(ep.id, 0.98);
      }),
      snapshot: makeRunner().snapshot,
    };
    const judgeFixed: Judge = {
      name: 'claude', external: false, close: vi.fn(async () => {}),
      async grade(input: JudgeInput) {
        const r: Record<string, number> = {};
        for (const q of input.questions) { r[q.id] = 0.98; }
        return r;
      },
    };
    const onProgress = vi.fn();
    const result = await runBaselineSample({
      predictions: [pred],
      episodes: eps,
      baseline: makeBaselineEnv(),
      runner: runnerCustom,
      judge: judgeFixed,
      runnerOpts: makeRunnerOpts(),
      warnOnly: true,
      onProgress,
    });
    expect(result.anyTripped).toBe(true);
    // Warning line should say the run cannot confirm the prediction
    const messages: string[] = onProgress.mock.calls.map(
      (c: [{ message: string }]) => c[0].message,
    );
    expect(messages.some((m) => m.includes('cannot confirm'))).toBe(true);
  });

  it('tripped field reflects headroom < mde correctly', async () => {
    // At K=3, mdeForN(3)≈1.0 (clamped), so any headroom < 1 trips.
    // Use warnOnly=true so we can inspect the tripped field.
    // added with 0.05 baseline → headroom=0.95, which is still < 1.0 → tripped=true.
    const pred = makePrediction('p1', 'added', []);
    const eps = makeSyntheticEpisodes([pred]).slice(0, 3);
    const runnerCustom: AgentRunner = {
      ...makeRunner(),
      run: vi.fn(async (_env: Environment, ep: Episode): Promise<EpisodeTrace> => {
        return makeBaselineTrace(ep.id, 0.05);
      }),
      snapshot: makeRunner().snapshot,
    };
    const judgeFixed: Judge = {
      name: 'claude', external: false, close: vi.fn(async () => {}),
      async grade(input: JudgeInput) {
        const r: Record<string, number> = {};
        for (const q of input.questions) { r[q.id] = 0.05; }
        return r;
      },
    };
    const result = await runBaselineSample({
      predictions: [pred],
      episodes: eps,
      baseline: makeBaselineEnv(),
      runner: runnerCustom,
      judge: judgeFixed,
      runnerOpts: makeRunnerOpts(),
      warnOnly: true, // inspect without throwing
      onProgress: vi.fn(),
    });
    // tripped = optimisticHeadroom < mde
    const s = result.perPrediction[0]!;
    expect(s.tripped).toBe(s.optimisticHeadroom < s.mde);
    expect(result.anyTripped).toBe(s.tripped);
  });
});

// ---------------------------------------------------------------------------
// Sample calls runner with baseline arm only
// ---------------------------------------------------------------------------

describe('runBaselineSample — arm isolation', () => {
  it('calls runner only with baseline environment', async () => {
    const pred = makePrediction('p1', 'added', []);
    const eps = makeSyntheticEpisodes([pred]).slice(0, 2);
    const runMock = vi.fn(async (_env: Environment, ep: Episode): Promise<EpisodeTrace> => {
      return makeBaselineTrace(ep.id, 0.1);
    });
    const runner: AgentRunner = {
      name: 'fake',
      run: runMock,
      snapshot: vi.fn(async (env: Environment): Promise<RequestSnapshot> => makeSnap(
        env.label === 'candidate' ? CANDIDATE_SYSTEM : BASELINE_SYSTEM,
      )),
    };
    const judgeFixed: Judge = {
      name: 'claude', external: false, close: vi.fn(async () => {}),
      async grade(input: JudgeInput) {
        const r: Record<string, number> = {};
        for (const q of input.questions) { r[q.id] = 0.1; }
        return r;
      },
    };
    // warnOnly=true: with 3 full-run probes, mdeForN(3)≈1.0, so any headroom trips the gate
    await runBaselineSample({
      predictions: [pred],
      episodes: eps,
      baseline: makeBaselineEnv(),
      runner,
      judge: judgeFixed,
      runnerOpts: makeRunnerOpts(),
      warnOnly: true,
      onProgress: vi.fn(),
    });
    const envLabels = runMock.mock.calls.map(
      (c: [Environment, Episode, number, RunnerOptions]) => c[0].label,
    );
    expect(envLabels.every((l) => l === 'baseline')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cost estimate includes the sample
// ---------------------------------------------------------------------------

describe('estimateBaselineSampleCost', () => {
  it('adds exactly one cold-cache start (4 warm episodes) per sample phase', () => {
    const args = { agentModel: 'claude-haiku-4-5-20250929', analystModel: 'claude-haiku-4-5-20250929', systemTokensBaseline: 5000 };
    const warm = (n: number): number => estimateVerifyCost({
      episodes: n * BASELINE_SAMPLE_K, samples: 1, ...args,
      systemTokens: { baseline: 5000, candidate: 5000 }, judgeExternal: true,
    }).usd / 2;
    for (const n of [1, 3]) {
      const preds = Array.from({ length: n }, (_, i) => makePrediction(`p${i}`, 'added', []));
      const cost = estimateBaselineSampleCost({ predictions: preds, ...args, judgeExternal: true });
      const perEpisode = warm(n) / (n * BASELINE_SAMPLE_K);
      // One cold start per phase regardless of prediction count.
      expect(cost).toBeCloseTo(warm(n) + 4 * perEpisode, 10);
    }
  });

  it('returns a positive number for one prediction', () => {
    const pred = makePrediction('p1', 'added', []);
    const cost = estimateBaselineSampleCost({
      predictions: [pred],
      agentModel: 'claude-haiku-4-5-20250929',
      analystModel: 'claude-haiku-4-5-20250929',
      systemTokensBaseline: 5000,
      judgeExternal: false,
    });
    expect(cost).toBeGreaterThan(0);
  });

  it('scales with number of predictions', () => {
    const pred1 = makePrediction('p1', 'added', []);
    const pred2 = makePrediction('p2', 'removed', []);
    const cost1 = estimateBaselineSampleCost({
      predictions: [pred1],
      agentModel: 'claude-haiku-4-5-20250929',
      analystModel: 'claude-haiku-4-5-20250929',
      systemTokensBaseline: 5000,
      judgeExternal: false,
    });
    const cost2 = estimateBaselineSampleCost({
      predictions: [pred1, pred2],
      agentModel: 'claude-haiku-4-5-20250929',
      analystModel: 'claude-haiku-4-5-20250929',
      systemTokensBaseline: 5000,
      judgeExternal: false,
    });
    expect(cost2).toBeGreaterThan(cost1);
  });
});

// ---------------------------------------------------------------------------
// Integration via runWhatif: --no-baseline-sample skips sampling
// ---------------------------------------------------------------------------

let tmpDir: string;
let sessionsDir: string;
let stateDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-bsample-test-'));
  sessionsDir = path.join(tmpDir, 'sessions');
  stateDir = path.join(tmpDir, 'state');
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.mkdir(stateDir, { recursive: true });
  vi.stubEnv('AFK_STATE_DIR', stateDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function makeSpec(): ChangeSpec {
  return {
    title: 'Test baseline sample',
    changes: [{ kind: 'append', target: 'user-afk-md', text: 'Ask first.' }],
  };
}

function makeIntegrationComplete(baselineEstimate?: number): CompleteFn {
  let calls = 0;
  return vi.fn(async () => {
    calls++;
    if (calls === 1) {
      const preds = [{
        id: 'p1',
        behavior: 'Asks before acting',
        direction: 'added',
        confidence: 'high',
        reason: 'Candidate instructs asking',
        testQuestion: 'Does it ask first?',
        probes: ['Write hello.txt'],
        ...(baselineEstimate !== undefined ? { baselineEstimate } : {}),
      }];
      return { text: JSON.stringify(preds), costUsd: 0.001 };
    }
    return { text: '[]', costUsd: 0.001 };
  });
}

function makeIntegrationRunner(): AgentRunner {
  return {
    name: 'fake',
    run: vi.fn(async (_env: Environment, ep: Episode, s: number): Promise<EpisodeTrace> => {
      if (_env.label === 'candidate') return makeCandidateTrace(ep.id);
      return makeBaselineTrace(ep.id, 0.1);
    }),
    snapshot: vi.fn(async (env: Environment): Promise<RequestSnapshot> => makeSnap(
      env.label === 'candidate' ? CANDIDATE_SYSTEM : BASELINE_SYSTEM,
    )),
  };
}

function makeIntegrationJudge(): Judge {
  return {
    name: 'claude',
    external: false,
    async grade(input: JudgeInput) {
      const r: Record<string, number> = {};
      for (const q of input.questions) {
        r[q.id] = input.output.includes('question') ? 0.95 : 0.05;
      }
      return r;
    },
    close: vi.fn(async () => {}),
  };
}

function makeIntegrationOptions(
  overrides: Partial<WhatifOptions & { sessionsDir?: string }> = {},
): WhatifOptions & { sessionsDir?: string } {
  return {
    spec: makeSpec(),
    realHome: tmpDir,
    realCwd: tmpDir,
    agentModel: 'claude-haiku-4-5-20250929',
    analystModel: 'claude-haiku-4-5-20250929',
    verify: true,
    turns: 3,
    samples: 1,
    maxUsd: 10,
    judge: 'claude',
    concurrency: 2,
    maxTurns: 1,
    episodeTimeoutMs: 5000,
    keepSandboxes: true,
    force: true,
    sessionsDir,
    ...overrides,
  };
}

function makeIntegrationDeps(runner: AgentRunner, complete: CompleteFn): WhatifDeps {
  const judge = makeIntegrationJudge();
  return {
    runner,
    complete,
    makeJudge: vi.fn(async () => judge),
    makeCrossCheckJudge: vi.fn(async () => undefined),
    onProgress: vi.fn(),
    signal: undefined,
  };
}

describe('runWhatif — --no-baseline-sample skips sample', () => {
  it('with noBaselineSample=true, runner is not called during sample phase', async () => {
    const runner = makeIntegrationRunner();
    const complete = makeIntegrationComplete();
    const deps = makeIntegrationDeps(runner, complete);
    const options = makeIntegrationOptions({ noBaselineSample: true });
    const report = await runWhatif(options, deps).catch(() => undefined);
    // The sample phase must not have run: baselineSample absent from verify result.
    expect(report?.verify?.baselineSample).toBeUndefined();
    // runner.run is still called — by the full verify phase, not the sample phase.
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

});

// End-to-end: the measured gate against the FULL run's probe count (#2511).
const TWELVE_PROBES = [
  'Summarize what this repository does', 'List the npm scripts available here',
  'Explain how configuration is loaded', 'Find where logging is set up',
  'Describe the test layout of the project', 'What license does this project use?',
  'Outline the directory structure briefly', 'Which dependencies look outdated?',
  'How would I add a new CLI flag?', 'Where are environment variables read?',
  'What does the build step produce?', 'Suggest one small refactor worth doing',
];

function makeTwelveProbeComplete(): CompleteFn {
  let calls = 0;
  return vi.fn(async () => {
    calls++;
    if (calls === 1) {
      return {
        text: JSON.stringify([{
          id: 'p1', behavior: 'Asks before acting', direction: 'added', confidence: 'high',
          reason: 'Candidate instructs asking', testQuestion: 'Does it ask first?', probes: TWELVE_PROBES,
        }]),
        costUsd: 0.001,
      };
    }
    return { text: '[]', costUsd: 0.001 };
  });
}

function constJudgeDeps(runner: AgentRunner, complete: CompleteFn, rate: number): WhatifDeps {
  const judge: Judge = {
    name: 'claude', external: false, close: vi.fn(async () => {}),
    async grade(input: JudgeInput) {
      const r: Record<string, number> = {};
      for (const q of input.questions) r[q.id] = rate;
      return r;
    },
  };
  return { ...makeIntegrationDeps(runner, complete), makeJudge: vi.fn(async () => judge) };
}

describe('runWhatif — measured baseline gate end to end (#2511)', () => {
  it('runs and records the sample when the baseline leaves room', async () => {
    const runner = makeIntegrationRunner();
    const deps = constJudgeDeps(runner, makeTwelveProbeComplete(), 0.05);
    const report = await runWhatif(makeIntegrationOptions({ noBaselineSample: false }), deps);
    const bs = report.verify?.baselineSample;
    expect(bs).toBeDefined();
    const item = bs?.[0] as PredictionBaselineSample;
    expect(item.tripped).toBe(false);
    expect(item.probeRates).toHaveLength(BASELINE_SAMPLE_K);
    // Full-run MDE: the default --probes 6 caps the analyst's 12 probes at 6,
    // so the gate uses mdeForN(6) ≈ 81pp, not the 3-probe sample's clamped 100pp.
    expect(item.mde).toBeCloseTo(mdeForN(6), 6);
    expect(item.mde).toBeLessThan(1);
  });

  it('refuses a saturated baseline even under --force, naming the override', async () => {
    const runner = makeIntegrationRunner();
    const deps = constJudgeDeps(runner, makeTwelveProbeComplete(), 0.95);
    const err = await runWhatif(makeIntegrationOptions({ noBaselineSample: false, force: true }), deps)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatifMdeError);
    expect((err as Error).message).toContain('--no-baseline-sample');
    // Only the K sample episodes ran: the full run never started.
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(BASELINE_SAMPLE_K);
    // The refusal leaves evidence: refused.json with the measurements and spend.
    const runDirs = await fsp.readdir(getWhatifDir());
    const refused = await Promise.all(runDirs.map((d) =>
      fsp.readFile(path.join(getWhatifDir(), d, 'refused.json'), 'utf8').catch(() => undefined)));
    const records = refused.filter((r): r is string => r !== undefined).map((r) => JSON.parse(r) as {
      predictionId: string; reason: string; sampleAgentCostUsd: number;
      baselineSample: PredictionBaselineSample[];
      predictions: { id: string; behavior: string; direction: string; confidence: string; testQuestion: string; probes: string[] }[];
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.predictionId).toBe('p1');
    expect(records[0]?.reason).toContain('--no-baseline-sample');
    expect(records[0]?.sampleAgentCostUsd).toBeGreaterThan(0);
    expect(records[0]?.baselineSample[0]?.tripped).toBe(true);
    // #2602: refused.json must include prediction text so the run can be interpreted.
    expect(records[0]?.predictions).toHaveLength(1);
    expect(records[0]?.predictions[0]?.behavior).toBe('Asks before acting');
    expect(records[0]?.predictions[0]?.testQuestion).toBe('Does it ask first?');
    expect(records[0]?.predictions[0]?.direction).toBe('added');
    // Probes are capped to the --probes limit (default 6) before predictions are
    // passed to persistRefusal, so the record reflects the capped set.
    expect(records[0]?.predictions[0]?.probes.length).toBeGreaterThan(0);
  });
});

describe('runWhatif — analyst-estimate check still works when --no-baseline-sample', () => {
  it('WhatifMdeError thrown for headroom violation without force even when noBaselineSample=true', async () => {
    // baselineEstimate=0.97 on 'added' → headroom=0.03, trips analyst check
    const runner = makeIntegrationRunner();
    const complete = makeIntegrationComplete(0.97);
    const deps = makeIntegrationDeps(runner, complete);
    const options = makeIntegrationOptions({
      noBaselineSample: true,
      force: false,
    });
    const err = await runWhatif(options, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WhatifMdeError);
  });

  it('prints preflight message + continues with force=true and noBaselineSample=true', async () => {
    const runner = makeIntegrationRunner();
    const complete = makeIntegrationComplete(0.97);
    const deps = makeIntegrationDeps(runner, complete);
    const options = makeIntegrationOptions({
      noBaselineSample: true,
      force: true,
    });
    let threw = false;
    try { await runWhatif(options, deps); } catch (e) {
      if (e instanceof WhatifMdeError) threw = true;
    }
    expect(threw).toBe(false);
    const messages = (deps.onProgress as ReturnType<typeof vi.fn>).mock.calls
      .map((c: [{ message?: string }]) => c[0].message ?? '');
    expect(messages.some((m) => m.includes('baseline estimate 97%'))).toBe(true);
  });
});

describe('mdeForN', () => {
  it('returns 1 for n=0', () => {
    expect(mdeForN(0)).toBe(1);
  });

  it('returns approx 0.99 for n=1', () => {
    expect(mdeForN(1)).toBeGreaterThan(0.5);
  });

  it('decreases as n increases', () => {
    expect(mdeForN(10)).toBeLessThan(mdeForN(5));
    expect(mdeForN(100)).toBeLessThan(mdeForN(10));
  });
});
