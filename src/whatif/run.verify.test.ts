/**
 * Tests for per-prediction episode scoping in the verify phase (#2403).
 *
 * Fakes only: no model, judge, or subprocess calls.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRun, type VerifyRunInput } from './run.verify.js';
import { scorePrediction, scoresForQuestion, traceKey, type JudgeResults } from './run.verify.scoring.js';
import type {
  AgentRunner,
  Environment,
  Episode,
  EpisodeTrace,
  Judge,
  JudgeInput,
  JudgeResult,
  Prediction,
  StructuralImpact,
} from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function pred(id: string, overrides: Partial<Prediction> = {}): Prediction {
  return {
    id,
    behavior: `behavior ${id}`,
    direction: 'added',
    confidence: 'high',
    reason: 'test',
    testQuestion: `Does the output show ${id}?`,
    probes: ['probe'],
    ...overrides,
  };
}

function env(label: 'baseline' | 'candidate'): Environment {
  return { label, home: `/tmp/${label}`, cwd: '/tmp', launch: { env: {} } };
}

function trace(episodeId: string, e: 'baseline' | 'candidate', sample: number, text: string, error?: string): EpisodeTrace {
  return {
    episodeId, env: e, sample, text, tools: [],
    costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1,
    ...(error ? { error } : {}),
  };
}

/** 2 synthetic probes targeting p1, then `untargeted` real episodes. */
function acceptanceEpisodes(untargeted = 18): Episode[] {
  const eps: Episode[] = [
    { id: 's1', source: 'synthetic', prompt: 'probe one', targets: 'p1' },
    { id: 's2', source: 'synthetic', prompt: 'probe two', targets: 'p1' },
  ];
  for (let i = 1; i <= untargeted; i++) eps.push({ id: `r${i}`, source: 'real', prompt: `real turn ${i}` });
  return eps;
}

/**
 * Candidate outputs on p1's probes say "BEHAVIOR"; everything else does not.
 * So the judge scores 1.0 vs 0.0 on the targeted probes, 0 in both arms elsewhere.
 */
function acceptanceRunner(episodes: Episode[], failIds: string[] = []): AgentRunner {
  const byId = new Map(episodes.map((e) => [e.id, e]));
  return {
    name: 'fake',
    run: vi.fn(async (en: Environment, ep: Episode, sample: number) => {
      if (failIds.includes(ep.id)) return trace(ep.id, en.label, sample, '', 'boom');
      const hit = en.label === 'candidate' && byId.get(ep.id)?.targets === 'p1';
      return trace(ep.id, en.label, sample, hit ? 'BEHAVIOR shown' : 'plain answer');
    }),
    snapshot: vi.fn(),
  } as unknown as AgentRunner;
}

function keywordJudge(): Judge & { grade: ReturnType<typeof vi.fn> } {
  return {
    name: 'claude',
    external: false,
    grade: vi.fn(async (input: JudgeInput): Promise<JudgeResult> => {
      const out: JudgeResult = {};
      for (const q of input.questions) out[q.id] = input.output.includes('BEHAVIOR') ? 1 : 0;
      return out;
    }),
  };
}

let tmp: string;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-verify-test-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

function input(episodes: Episode[], predictions: Prediction[], overrides: Partial<VerifyRunInput> = {}): VerifyRunInput {
  return {
    episodes,
    baseline: env('baseline'),
    candidate: env('candidate'),
    predictions,
    structural: {} as StructuralImpact,
    judge: keywordJudge(),
    crossCheckJudge: undefined,
    runner: acceptanceRunner(episodes),
    complete: vi.fn(async () => ({ text: '[]', costUsd: 0 })),
    analystModel: 'test-model',
    options: {
      samples: 3,
      concurrency: 4,
      maxTurns: 1,
      episodeTimeoutMs: 1000,
      maxUsdRemaining: 100,
      changeKinds: ['append'],
      calibrationFile: path.join(tmp, 'ledger.jsonl'),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Acceptance (#2403)
// ---------------------------------------------------------------------------

describe('verifyRun: prediction scoring is scoped to targeted probes (#2403)', () => {
  it('2 targeted probes at 1.0 vs 0.0 plus 18 untargeted zeros gives delta ~1.0, not ~0.1', async () => {
    const episodes = acceptanceEpisodes();
    const { verifyResult } = await verifyRun(input(episodes, [pred('p1')]));
    const vp = verifyResult.predictions[0]!;

    expect(vp.rates.delta).toBeCloseTo(1.0, 5);
    expect(vp.rates.baseline).toBe(0);
    expect(vp.rates.candidate).toBe(1);
    expect(vp.rates.n).toEqual({ baseline: 6, candidate: 6 }); // 2 probes × 3 samples
    expect(vp.verdict).toBe('confirmed');

    expect(vp.scope?.episodes).toEqual({ baseline: ['s1', 's2'], candidate: ['s1', 's2'] });
    expect(vp.scope?.targetedEpisodes).toBe(2);
    // The 18 untargeted episodes are reported separately, not pooled.
    expect(vp.scope?.background?.delta).toBe(0);
    expect(vp.scope?.background?.n).toEqual({ baseline: 54, candidate: 54 });
  });

  it('the old pooled computation would have diluted the same data to ~0.1', async () => {
    // Guard against a regression back to pooling: the same run, every
    // episode pooled, is what produced the ~10x dilution.
    const episodes = acceptanceEpisodes();
    const judge = keywordJudge();
    const runner = acceptanceRunner(episodes);
    const { allTraces } = await verifyRun(input(episodes, [pred('p1')], { judge, runner }));
    const results: JudgeResults = new Map();
    for (const t of allTraces) results.set(traceKey(t), { p1: t.text.includes('BEHAVIOR') ? 1 : 0 });
    const b = scoresForQuestion('p1', 'baseline', allTraces, results);
    const c = scoresForQuestion('p1', 'candidate', allTraces, results);
    const pooledDelta = c.reduce((s, v) => s + v, 0) / c.length - b.reduce((s, v) => s + v, 0) / b.length;
    expect(pooledDelta).toBeCloseTo(0.1, 5);
  });

  it('results.json-bound scope records which episodes contributed per arm', async () => {
    const episodes = acceptanceEpisodes(2);
    const { verifyResult } = await verifyRun(input(episodes, [pred('p1')]));
    const json = JSON.parse(JSON.stringify(verifyResult)) as typeof verifyResult;
    expect(json.predictions[0]!.scope!.episodes.candidate).toEqual(['s1', 's2']);
  });

  it('keeps the measured-feature table on every episode', async () => {
    const episodes = acceptanceEpisodes();
    const { verifyResult } = await verifyRun(input(episodes, [pred('p1')]));
    for (const f of verifyResult.features) {
      expect(f.rates.n).toEqual({ baseline: 60, candidate: 60 }); // 20 episodes × 3 samples
    }
  });

  it('grades each output once: no extra judge calls for scoping', async () => {
    const episodes = acceptanceEpisodes();
    const judge = keywordJudge();
    await verifyRun(input(episodes, [pred('p1'), pred('p2')], { judge }));
    expect(judge.grade).toHaveBeenCalledTimes(20 * 2 * 3);
  });
});

// ---------------------------------------------------------------------------
// Zero applicable episodes
// ---------------------------------------------------------------------------

describe('verifyRun: prediction with zero graded probes', () => {
  it('is unclear, never confirmed or refuted, when it has no probes in the run', async () => {
    const episodes = acceptanceEpisodes();
    // p2 has no targeted episode at all (e.g. probes dropped upstream).
    const { verifyResult } = await verifyRun(input(episodes, [pred('p1'), pred('p2', { direction: 'removed' })]));
    const vp2 = verifyResult.predictions.find((v) => v.prediction.id === 'p2')!;
    expect(vp2.verdict).toBe('unclear');
    expect(vp2.rates.n).toEqual({ baseline: 0, candidate: 0 });
    expect(vp2.scope?.episodes).toEqual({ baseline: [], candidate: [] });
    expect(vp2.scope?.targetedEpisodes).toBe(0);
    // It still gets a background row from the other episodes.
    expect(vp2.scope?.background?.n.baseline).toBe(60);
  });

  it('is unclear when every targeted probe failed to run', async () => {
    const episodes = acceptanceEpisodes();
    const runner = acceptanceRunner(episodes, ['s1', 's2']);
    const { verifyResult } = await verifyRun(input(episodes, [pred('p1')], { runner }));
    const vp = verifyResult.predictions[0]!;
    expect(vp.verdict).toBe('unclear');
    expect(vp.scope?.targetedEpisodes).toBe(2);
    expect(vp.scope?.episodes.baseline).toEqual([]);
  });

  it('a would-be refuted empty sample stays unclear', () => {
    // compareRates on empty arms yields delta 0; with a narrow enough CI the
    // refuted rule could fire. The scope guard must prevent that.
    const episodes: Episode[] = [{ id: 's1', source: 'synthetic', prompt: 'x', targets: 'p1' }];
    const vp = scorePrediction(pred('p1'), episodes, [], new Map());
    expect(vp.verdict).toBe('unclear');
    expect(vp.scope?.background).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// scorePrediction unit behavior
// ---------------------------------------------------------------------------

describe('scorePrediction', () => {
  it('excludes probes that target a different prediction', () => {
    const episodes: Episode[] = [
      { id: 's1', source: 'synthetic', prompt: 'a', targets: 'p1' },
      { id: 's2', source: 'synthetic', prompt: 'b', targets: 'p2' },
    ];
    const traces = [
      trace('s1', 'baseline', 0, ''), trace('s1', 'candidate', 0, ''),
      trace('s2', 'baseline', 0, ''), trace('s2', 'candidate', 0, ''),
    ];
    const results: JudgeResults = new Map([
      [traceKey(traces[0]!), { p1: 0 }], [traceKey(traces[1]!), { p1: 1 }],
      [traceKey(traces[2]!), { p1: 1 }], [traceKey(traces[3]!), { p1: 0 }],
    ]);
    const vp = scorePrediction(pred('p1'), episodes, traces, results);
    expect(vp.rates.delta).toBe(1);
    expect(vp.scope?.episodes.candidate).toEqual(['s1']);
    expect(vp.scope?.background?.delta).toBe(-1);
  });

  it('lists only episodes whose outputs were actually graded, per arm', () => {
    const episodes: Episode[] = [
      { id: 's1', source: 'synthetic', prompt: 'a', targets: 'p1' },
      { id: 's2', source: 'synthetic', prompt: 'b', targets: 'p1' },
    ];
    const traces = [
      trace('s1', 'baseline', 0, ''), trace('s1', 'candidate', 0, ''),
      trace('s2', 'baseline', 0, ''), trace('s2', 'candidate', 0, ''),
    ];
    // s2 candidate ungraded (judge failure).
    const results: JudgeResults = new Map([
      [traceKey(traces[0]!), { p1: 0 }], [traceKey(traces[1]!), { p1: 1 }],
      [traceKey(traces[2]!), { p1: 0 }],
    ]);
    const vp = scorePrediction(pred('p1'), episodes, traces, results);
    expect(vp.scope?.episodes).toEqual({ baseline: ['s1', 's2'], candidate: ['s1'] });
    expect(vp.rates.n).toEqual({ baseline: 2, candidate: 1 });
  });
});
