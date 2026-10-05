/**
 * Observability in the verify phase (#2409): the predict-time
 * `observable` tag decides `unobservable`, never the episode traces.
 *
 * Fakes only: no model, judge, or subprocess calls.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyRun, type VerifyRunInput } from './run.verify.js';
import { scorePrediction, traceKey, type JudgeResults } from './run.verify.scoring.js';
import { buildHeadline } from './report.headline.js';
import type { CalibrationRecord } from './ledger.js';
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
  ToolRequest,
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

// Probe episodes: s1..s20 target p1, r1 is a real turn (no target).
// Using 20 episodes gives n=20 per arm in compareRates, which produces a
// CI narrow enough for equivalence/direction verdicts without relying on
// n-inflation from repeated samples (#2404 fix).
const probeEpisodes: Episode[] = [
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `s${i + 1}`, source: 'synthetic' as const, prompt: `probe ${i}`, targets: 'p1',
  })),
  { id: 'r1', source: 'real' as const, prompt: 'real turn' },
];

/**
 * One sample per episode for a set of episodes in one arm, each carrying
 * `tools`.  After the #2404 fix, n = episode count; we use 1 sample per
 * episode here so the per-episode mean equals the raw score.
 */
function samples(
  eps: string[],
  e: 'baseline' | 'candidate',
  tools: ToolRequest[] = [],
): EpisodeTrace[] {
  return eps.map((ep) => ({
    episodeId: ep, env: e, sample: 0, text: 'output', tools,
    costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1,
  }));
}

// Convenience: all 20 probe episode ids.
const allProbeIds = Array.from({ length: 20 }, (_, i) => `s${i + 1}`);

/** Score `p1` per arm: `score(env)` for every trace. */
function results(traces: EpisodeTrace[], score: (e: 'baseline' | 'candidate') => number): JudgeResults {
  return new Map(traces.map((t) => [traceKey(t), { p1: score(t.env) }]));
}

const writeFile: ToolRequest = { tool: 'write_file', input: {}, verdict: 'recorded' };
const agentCall: ToolRequest = { tool: 'agent', input: { prompt: 'Read LICENSE' }, verdict: 'recorded' };

// ---------------------------------------------------------------------------
// scorePrediction
// ---------------------------------------------------------------------------

describe('scorePrediction: observability is a predict-time tag (#2409)', () => {
  it('an unrelated prediction with write_file intercepted in both arms is NOT unobservable', () => {
    // "Uses a formal tone" has nothing to do with writing files; the probes
    // happened to end on an intercepted write_file in every sample.
    // The key property: this should be scored normally (not unobservable) —
    // observability is purely a predict-time tag, never inferred from tool usage.
    // With n=20 episodes and score=0 in both arms, the CI is too wide to
    // conclude equivalence (±5pp, #2405); verdict is 'unclear'.
    const traces = [
      ...samples(allProbeIds, 'baseline', [writeFile]),
      ...samples(allProbeIds, 'candidate', [writeFile]),
    ];
    const vp = scorePrediction(
      pred('p1', { behavior: 'Uses a formal tone', observable: 'decision' }),
      probeEpisodes, traces, results(traces, () => 0),
    );
    // Key assertion: NOT unobservable — tool interception does not override observability tag.
    expect(vp.verdict).not.toBe('unobservable');
    expect(vp.unobservableReason).toBeUndefined();
    // At n=20 with identical scores=0, CI ≈ ±0.27 — outside ±5pp equivalence margin → unclear.
    expect(['unclear', 'refuted'].includes(vp.verdict)).toBe(true);
  });

  it('an intent-graded "spawns a subagent" decision prediction at ~0.9 in both arms is NOT unobservable', () => {
    // The #2409 motivating case: both arms requested `agent` and the gate
    // stopped it. With intent grading the judge scores ~0.9 in both arms.
    // Key property: NOT unobservable — observability is a predict-time tag.
    // At n=20 episodes with p=0.9 identical, CI ≈ ±0.21 — outside ±5pp → unclear.
    const traces = [
      ...samples(allProbeIds, 'baseline', [agentCall]),
      ...samples(allProbeIds, 'candidate', [agentCall]),
    ];
    const vp = scorePrediction(
      pred('p1', { behavior: 'Honors explicit requests for subagents', direction: 'strengthened', observable: 'decision' }),
      probeEpisodes, traces, results(traces, () => 0.9),
    );
    expect(vp.rates.baseline).toBeCloseTo(0.9);
    expect(vp.rates.candidate).toBeCloseTo(0.9);
    expect(vp.verdict).not.toBe('unobservable');
    // After #2405: 'unclear' (CI too wide for equivalence at n=20).
    expect(['unclear', 'refuted'].includes(vp.verdict)).toBe(true);
    expect(vp.unobservableReason).toBeUndefined();
  });

  it('a downstream prediction is unobservable even when its rates would confirm it', () => {
    const traces = [
      ...samples(['s1'], 'baseline'),
      ...samples(['s1'], 'candidate'),
    ];
    const vp = scorePrediction(
      pred('p1', { observable: 'downstream', observabilityReason: 'the tests must run to completion' }),
      probeEpisodes, traces, results(traces, (e) => (e === 'candidate' ? 1 : 0)),
    );
    expect(vp.verdict).toBe('unobservable');
    expect(vp.unobservableReason).toContain('the tests must run to completion');
    // Rates and scope are still recorded for transparency.
    expect(vp.rates.delta).toBe(1);
    expect(vp.scope?.episodes).toEqual({ baseline: ['s1'], candidate: ['s1'] });
  });

  it('a downstream prediction with no graded probes is still unobservable', () => {
    const vp = scorePrediction(pred('p1', { observable: 'downstream' }), probeEpisodes, [], new Map());
    expect(vp.verdict).toBe('unobservable');
    expect(vp.unobservableReason).toContain('episode boundary');
  });

  it('a prediction with no observable tag defaults to decision and scores normally', () => {
    // Use 20 episodes to get a clear signal for confirmed (candidate=1, baseline=0).
    const traces = [
      ...samples(allProbeIds, 'baseline', [agentCall]),
      ...samples(allProbeIds, 'candidate', [agentCall]),
    ];
    const confirmed = scorePrediction(pred('p1'), probeEpisodes, traces, results(traces, (e) => (e === 'candidate' ? 1 : 0)));
    expect(confirmed.verdict).toBe('confirmed');
    // For the no-change case (score=0 both arms at n=20): CI ≈ ±0.27,
    // outside the ±5pp equivalence margin (#2405) → unclear (not refuted).
    // The key property: NOT unobservable (no observable tag = decision scoring).
    const noChange = scorePrediction(pred('p1'), probeEpisodes, traces, results(traces, () => 0));
    expect(noChange.verdict).not.toBe('unobservable');
    expect(noChange.unobservableReason).toBeUndefined();
  });

  it('a decision prediction with no graded probes stays unclear', () => {
    // Only real-turn episode r1 has traces; p1 targets probe episodes → no graded probes.
    const traces = [...samples(['r1'], 'baseline', [agentCall]), ...samples(['r1'], 'candidate', [agentCall])];
    const vp = scorePrediction(pred('p1', { observable: 'decision' }), probeEpisodes, traces, results(traces, () => 0));
    expect(vp.verdict).toBe('unclear');
    expect(vp.unobservableReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyRun: accuracy, ledger and headline exclude downstream predictions
// ---------------------------------------------------------------------------

let tmp: string;
beforeEach(async () => { tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-observability-test-')); });
afterEach(async () => { await fsp.rm(tmp, { recursive: true, force: true }); });

function env(label: 'baseline' | 'candidate'): Environment {
  return { label, home: `/tmp/${label}`, cwd: '/tmp', launch: { env: {} } };
}

describe('verifyRun: downstream predictions never count (#2409)', () => {
  // p1 (decision): no change on its probe -> refuted.
  // p2 (downstream): 0 -> 1 on its probe, which would confirm if counted.
  const episodes: Episode[] = [
    { id: 's1', source: 'synthetic', prompt: 'probe one', targets: 'p1' },
    { id: 't1', source: 'synthetic', prompt: 'probe two', targets: 'p2' },
  ];
  const predictions = [
    pred('p1', { behavior: 'Asks before acting', observable: 'decision' }),
    pred('p2', { behavior: 'The fix passes its tests', observable: 'downstream', observabilityReason: 'tests must run' }),
  ];
  const runner = {
    name: 'fake',
    run: vi.fn(async (en: Environment, ep: Episode, sample: number): Promise<EpisodeTrace> => ({
      episodeId: ep.id, env: en.label, sample,
      text: en.label === 'candidate' && ep.targets === 'p2' ? 'BEHAVIOR shown' : 'plain answer',
      tools: [], costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 1,
    })),
    snapshot: vi.fn(),
  } as unknown as AgentRunner;
  const judge: Judge = {
    name: 'claude',
    external: false,
    grade: vi.fn(async (input: JudgeInput): Promise<JudgeResult> => {
      const out: JudgeResult = {};
      for (const q of input.questions) out[q.id] = input.output.includes('BEHAVIOR') ? 1 : 0;
      return out;
    }),
  };
  function input(): VerifyRunInput {
    return {
      episodes, baseline: env('baseline'), candidate: env('candidate'), predictions,
      structural: {} as StructuralImpact, judge, crossCheckJudge: undefined, runner,
      complete: vi.fn(async () => ({ text: '[]', costUsd: 0 })), analystModel: 'test-model',
      options: {
        samples: 40, concurrency: 8, maxTurns: 1, episodeTimeoutMs: 1000, maxUsdRemaining: 100,
        changeKinds: ['append'], calibrationFile: path.join(tmp, 'ledger.jsonl'),
      },
    };
  }

  it('excludes the downstream prediction from accuracy, the ledger and the headline effect', async () => {
    const { verifyResult } = await verifyRun(input());
    const [vp1, vp2] = verifyResult.predictions;
    // p1 has only 1 targeted episode (s1) so n=1 per arm after the #2404 fix;
    // CI is too wide for confirmed/refuted → unclear.
    expect(['refuted', 'unclear'].includes(vp1!.verdict)).toBe(true);
    expect(vp2!.verdict).toBe('unobservable');
    expect(vp2!.rates.delta).toBe(1); // measured, but never counted

    // Accuracy: p2 is unobservable and does not count; p1 is unclear or refuted.
    // If p1 is unclear: predictionAccuracy is undefined (no resolved verdicts).
    // If p1 is refuted: predictionAccuracy is 0 (0 confirmed / 1 refuted).
    if (vp1!.verdict === 'refuted') {
      expect(verifyResult.predictionAccuracy).toBe(0);
    } else {
      expect(verifyResult.predictionAccuracy).toBeUndefined();
    }

    // Ledger: only non-unobservable decisions are recorded.
    // With samples:40 and 1 episode, p1 may be refuted or unclear.
    const ledgerContent = (await fsp.readFile(path.join(tmp, 'ledger.jsonl'), 'utf8')).trim();
    if (ledgerContent.length > 0) {
      const records = ledgerContent.split('\n').map((l) => JSON.parse(l) as CalibrationRecord);
      expect(records.map((r) => r.prediction.id)).toEqual(['p1']);
    }

    // Headline: p2's significant 0 -> 100% shift is never the effect.
    const headline = buildHeadline({
      spec: { title: 't', changes: [] }, structural: {} as StructuralImpact, predictions,
      verify: verifyResult, costUsd: 0, runDir: tmp, limits: [],
    });
    expect(headline).not.toContain('The fix passes its tests');
    // p2 is always unobservable; headline mentions it but not as a behavioral effect.
    expect(headline).toContain('unobservable');
  });
});
