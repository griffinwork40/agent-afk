/**
 * Verify phase for the what-if run pipeline.
 *
 * Runs episodes through the agent in both environments, judges outputs,
 * discovers unexpected differences, and computes statistics.
 *
 * Concurrency: episodes are interleaved (baseline/candidate pairs scheduled
 * together) so budget stops keep the two environments balanced.
 *
 * @module whatif/run.verify
 */

import { extractFeatures, featureIndicators, FEATURE_LABELS } from './observe.js';
import { compareRates, predictionAccuracy, agreementRate, applyAgreementDowngrade } from './stats.js';
import { scorePrediction, scoresForQuestion, traceKey, type JudgeResults } from './run.verify.scoring.js';
import { discoverDifferences, type OutputPair } from './discover.js';
import { appendCalibration, type CalibrationRecord } from './ledger.js';
import { BudgetTracker } from './cost.js';
import { renderTrace } from './trace-render.js';
import { buildFailedEpisodeRecords, detectArmImbalance } from './run.failures.js';
import type {
  AgentRunner,
  CompleteFn,
  Episode,
  EpisodeTrace,
  Environment,
  Judge,
  JudgeInput,
  JudgeQuestion,
  Prediction,
  RunnerOptions,
  StructuralImpact,
  VerifyResult,
  WhatifProgress,
} from './types.js';

// ---------------------------------------------------------------------------
// Cross-check sample indices
// ---------------------------------------------------------------------------

/**
 * Select a deterministic ~10% sample of indices for cross-checking,
 * at least `minSample` when available.
 */
function crossCheckIndices(total: number, minSample: number): number[] {
  if (total === 0) return [];
  const target = Math.max(minSample, Math.round(total * 0.1));
  const step = Math.max(1, Math.floor(total / target));
  const indices: number[] = [];
  for (let i = 0; i < total && indices.length < target; i += step) {
    indices.push(i);
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Episode run phase
// ---------------------------------------------------------------------------

interface RunEpisodesResult {
  allTraces: EpisodeTrace[];
  truncatedByBudget: boolean;
  failedEpisodes: number;
  /** Total traces attempted per arm (including failures), for imbalance rates. */
  armTotals: { baseline: number; candidate: number };
}

interface EpTask {
  env: Environment;
  ep: Episode;
  s: number;
}

/**
 * Run all episode tasks with bounded concurrency and budget enforcement.
 * Tasks are interleaved (baseline+candidate together) so budget stops stay
 * balanced between the two environments.
 */
async function runEpisodes(
  episodes: Episode[],
  baseline: Environment,
  candidate: Environment,
  samples: number,
  concurrency: number,
  maxUsdRemaining: number,
  runner: AgentRunner,
  runnerOpts: RunnerOptions,
  signal: AbortSignal | undefined,
  onProgress: ((p: WhatifProgress) => void) | undefined,
): Promise<RunEpisodesResult> {
  const budget = new BudgetTracker(maxUsdRemaining);
  const allTraces: EpisodeTrace[] = [];
  let truncatedByBudget = false;
  let failedEpisodes = 0;
  const armTotals = { baseline: 0, candidate: 0 };

  const taskList: EpTask[] = [];
  for (const ep of episodes) {
    for (let s = 0; s < samples; s++) {
      taskList.push({ env: baseline, ep, s });
      taskList.push({ env: candidate, ep, s });
    }
  }
  const total = taskList.length;

  async function runTask(task: EpTask, release: () => void): Promise<void> {
    try {
      if (signal?.aborted || budget.exceeded) return;
      const trace = await runner.run(task.env, task.ep, task.s, runnerOpts);
      allTraces.push(trace);
      budget.add(trace.costUsd);
      armTotals[trace.env]++;
      if (trace.error) failedEpisodes++;
      if (budget.exceeded) truncatedByBudget = true;
      onProgress?.({ stage: 'run', message: `Episode ${task.ep.id}/${task.env.label} done`, done: allTraces.length, total });
    } finally {
      release();
    }
  }

  // Semaphore for bounded concurrency
  let semCount = 0;
  const semQueue: Array<() => void> = [];
  function acquire(): Promise<void> {
    if (semCount < concurrency) { semCount++; return Promise.resolve(); }
    return new Promise<void>((r) => { semQueue.push(r); });
  }
  function release(): void {
    const next = semQueue.shift();
    if (next) { next(); } else { semCount--; }
  }

  const inflight: Array<Promise<void>> = [];
  for (const task of taskList) {
    if (signal?.aborted || budget.exceeded) { truncatedByBudget = budget.exceeded; break; }
    await acquire();
    if (signal?.aborted || budget.exceeded) { truncatedByBudget = budget.exceeded; release(); break; }
    inflight.push(runTask(task, release));
  }
  await Promise.allSettled(inflight);

  return { allTraces, truncatedByBudget, failedEpisodes, armTotals };
}

// ---------------------------------------------------------------------------
// Judge phase
// ---------------------------------------------------------------------------

interface GradeResult {
  judgeResults: Map<string, Record<string, number>>;
  crossCheckMainScores: number[];
  crossCheckCrossScores: number[];
  /** Per-question cross-check score pairs, keyed by question id. */
  crossCheckPerQuestion: Map<string, { main: number[]; cross: number[] }>;
  judgeFailures: number;
}

/**
 * Grade all successful traces with the primary judge.
 * Runs cross-check grading on a deterministic ~10% sample when a cross-check
 * judge is provided.
 */
async function gradeOutputs(
  goodTraces: EpisodeTrace[],
  episodes: Episode[],
  questions: JudgeQuestion[],
  judge: Judge,
  crossCheckJudge: Judge | undefined,
  concurrency: number,
  signal: AbortSignal | undefined,
  onProgress: ((p: WhatifProgress) => void) | undefined,
): Promise<GradeResult> {
  const judgeResults = new Map<string, Record<string, number>>();
  const crossCheckMainScores: number[] = [];
  const crossCheckCrossScores: number[] = [];
  const crossCheckPerQuestion = new Map<string, { main: number[]; cross: number[] }>();
  let judgeFailures = 0;

  // Hoist cross-check set out of the per-trace closure; crossCheckIndices is
  // a pure function of goodTraces.length so it is constant for this grading run.
  const crossCheckSet = crossCheckJudge
    ? new Set(crossCheckIndices(goodTraces.length, 3))
    : null;

  async function judgeOne(trace: EpisodeTrace, idx: number): Promise<void> {
    if (signal?.aborted) return;
    const key = traceKey(trace);
    const input: JudgeInput = {
      prompt: episodes.find((e) => e.id === trace.episodeId)?.prompt ?? '',
      output: renderTrace(trace),
      questions,
    };
    try {
      const result = await judge.grade(input, signal);
      judgeResults.set(key, result);
      if (crossCheckJudge && crossCheckSet?.has(idx)) {
        try {
          const ccResult = await crossCheckJudge.grade(input, signal);
          for (const q of questions) {
            const main = result[q.id];
            const cross = ccResult[q.id];
            if (main === undefined || cross === undefined) continue;
            crossCheckMainScores.push(main);
            crossCheckCrossScores.push(cross);
            // Track per-question pairs for per-prediction agreement (#2413).
            let entry = crossCheckPerQuestion.get(q.id);
            if (!entry) { entry = { main: [], cross: [] }; crossCheckPerQuestion.set(q.id, entry); }
            entry.main.push(main);
            entry.cross.push(cross);
          }
        } catch { /* non-fatal */ }
      }
    } catch { judgeFailures++; /* excluded from rates, surfaced in the report */ }
    onProgress?.({ stage: 'judge', message: 'Grading outputs', done: judgeResults.size, total: goodTraces.length });
  }

  // Bounded concurrency queue for judging
  const queue = goodTraces.map((trace, idx) => () => judgeOne(trace, idx));
  let active = 0;
  const running: Array<Promise<void>> = [];
  while (queue.length > 0) {
    if (signal?.aborted) break;
    if (active >= concurrency) { await Promise.race(running); continue; }
    const task = queue.shift();
    if (!task) break;
    active++;
    const p = task().finally(() => {
      active--;
      const i = running.indexOf(p as Promise<void>);
      if (i !== -1) running.splice(i, 1);
    });
    running.push(p as Promise<void>);
  }
  await Promise.allSettled(running);

  return { judgeResults, crossCheckMainScores, crossCheckCrossScores, crossCheckPerQuestion, judgeFailures };
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

// Per-prediction episode scoping lives in ./run.verify.scoring.ts (#2403).

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface VerifyRunInput {
  episodes: Episode[];
  baseline: Environment;
  candidate: Environment;
  predictions: Prediction[];
  structural: StructuralImpact;
  judge: Judge;
  crossCheckJudge: Judge | undefined;
  runner: AgentRunner;
  complete: CompleteFn;
  analystModel: string;
  options: {
    samples: number;
    concurrency: number;
    maxTurns: number;
    episodeTimeoutMs: number;
    maxUsdRemaining: number;
    changeKinds: string[];
    calibrationFile?: string;
  };
  onProgress?: (p: WhatifProgress) => void;
  signal?: AbortSignal;
}

export interface VerifyRunOutput {
  verifyResult: VerifyResult;
  allTraces: EpisodeTrace[];
  analystCostUsd: number;
  /** Per-output judge grades keyed by {@link traceKey}. Used by persistGrades (#2477). */
  judgeResults: JudgeResults;
}

/**
 * Run the full verify phase: episodes, judge, discover, stats, calibration.
 */
export async function verifyRun(input: VerifyRunInput): Promise<VerifyRunOutput> {
  const { episodes, baseline, candidate, predictions, judge, crossCheckJudge,
    runner, complete, analystModel, options, onProgress, signal } = input;
  const { samples, concurrency, maxTurns, episodeTimeoutMs, maxUsdRemaining,
    changeKinds, calibrationFile } = options;

  const runnerOpts: RunnerOptions = { timeoutMs: episodeTimeoutMs, maxTurns, signal };

  // ── 1. Run episodes ───────────────────────────────────────────────────────

  onProgress?.({ stage: 'run', message: `Running ${episodes.length} episodes × 2 envs × ${samples} samples` });

  const { allTraces, truncatedByBudget, failedEpisodes, armTotals } = await runEpisodes(
    episodes, baseline, candidate, samples, concurrency, maxUsdRemaining,
    runner, runnerOpts, signal, onProgress,
  );

  // Build per-failure records and detect arm imbalance (#2411).
  const episodeTargets = new Map(
    episodes.filter((e) => e.targets !== undefined).map((e) => [e.id, e.targets!]),
  );
  const failedEpisodeRecords = buildFailedEpisodeRecords(allTraces, episodeTargets);
  const armImbalance = detectArmImbalance(failedEpisodeRecords, armTotals.baseline, armTotals.candidate);

  if (signal?.aborted) {
    const err = new Error('whatif aborted');
    (err as Error & { isAbortError: boolean }).isAbortError = true;
    throw err;
  }

  const goodTraces = allTraces.filter((t) => !t.error);

  // ── 2. Judge ──────────────────────────────────────────────────────────────

  onProgress?.({ stage: 'judge', message: 'Grading outputs', done: 0, total: goodTraces.length });

  const predQuestions = predictions.map((p) => ({ id: p.id, question: p.testQuestion }));

  const { judgeResults, crossCheckMainScores, crossCheckCrossScores, crossCheckPerQuestion, judgeFailures } = await gradeOutputs(
    goodTraces, episodes, predQuestions, judge, crossCheckJudge, concurrency, signal, onProgress,
  );

  // ── 3. Discover ───────────────────────────────────────────────────────────

  onProgress?.({ stage: 'discover', message: 'Discovering unexpected differences' });

  const outputPairs: OutputPair[] = [];
  for (const ep of episodes) {
    const bTrace = goodTraces.find((t) => t.episodeId === ep.id && t.env === 'baseline' && t.sample === 0);
    const cTrace = goodTraces.find((t) => t.episodeId === ep.id && t.env === 'candidate' && t.sample === 0);
    if (bTrace && cTrace) {
      outputPairs.push({ prompt: ep.prompt, baseline: renderTrace(bTrace), candidate: renderTrace(cTrace) });
      if (outputPairs.length >= 12) break;
    }
  }

  let analystCostUsd = 0;
  const discovered = await discoverDifferences(outputPairs, predictions, complete, analystModel).catch(() => []);

  // Grade discovered questions on all successful traces
  const discoveredQuestions = discovered.map((d) => ({ id: d.id, question: d.question }));
  if (discoveredQuestions.length > 0) {
    for (const trace of goodTraces) {
      if (signal?.aborted) break;
      const key = traceKey(trace);
      const existing = judgeResults.get(key) ?? {};
      const input: JudgeInput = {
        prompt: episodes.find((e) => e.id === trace.episodeId)?.prompt ?? '',
        output: renderTrace(trace),
        questions: discoveredQuestions,
      };
      try {
        const result = await judge.grade(input, signal);
        judgeResults.set(key, { ...existing, ...result });
      } catch { /* non-fatal */ }
    }
  }

  // ── 4. Stats ──────────────────────────────────────────────────────────────

  onProgress?.({ stage: 'report', message: 'Computing statistics' });

  // Each prediction is scored on its own probes; other episodes are reported
  // as a background rate, never pooled (#2403).
  // After scoring, apply the per-prediction cross-check agreement downgrade
  // (#2413): a decisive verdict (confirmed/refuted) is downgraded to unclear
  // when the primary and cross-check judge disagree heavily on this question.
  const verifiedPredictions = predictions.map((p) => {
    const vp = scorePrediction(p, episodes, goodTraces, judgeResults);
    const ccEntry = crossCheckPerQuestion.get(p.id);
    if (!ccEntry) return vp;
    return applyAgreementDowngrade(vp, ccEntry.main, ccEntry.cross);
  });

  const verifiedDiscovered = discovered
    .map((d) => {
      const bScores = scoresForQuestion(d.id, 'baseline', goodTraces, judgeResults);
      const cScores = scoresForQuestion(d.id, 'candidate', goodTraces, judgeResults);
      return { ...d, rates: compareRates(bScores, cScores) };
    })
    .filter((d) => d.rates.ci[0] > 0 || d.rates.ci[1] < 0);

  const featureDeltas = FEATURE_LABELS.map((label) => {
    const bVals = goodTraces.filter((t) => t.env === 'baseline').map((t) => (featureIndicators(extractFeatures(t))[label] ? 1 : 0));
    const cVals = goodTraces.filter((t) => t.env === 'candidate').map((t) => (featureIndicators(extractFeatures(t))[label] ? 1 : 0));
    return { label, rates: compareRates(bVals, cVals) };
  });

  const accuracy = predictionAccuracy(verifiedPredictions);
  const crossCheckAgreement = crossCheckMainScores.length >= 3
    ? agreementRate(crossCheckMainScores, crossCheckCrossScores)
    : undefined;

  // ── 5. Calibration ────────────────────────────────────────────────────────

  // Unobservable (downstream) predictions carry no evidence either way, so
  // they never enter the track record (#2409).
  const calibrationRecords: CalibrationRecord[] = verifiedPredictions
    .filter((vp) => vp.verdict !== 'unobservable')
    .map(({ prediction, rates, verdict }) => ({
      ts: new Date().toISOString(),
      changeKinds,
      prediction,
      verdict,
      delta: rates.delta,
    }));

  await appendCalibration(calibrationRecords, calibrationFile).catch(() => { /* non-fatal */ });

  return {
    verifyResult: {
      predictions: verifiedPredictions,
      discovered: verifiedDiscovered,
      features: featureDeltas,
      episodes: episodes.length,
      samples,
      judge: { name: judge.name, external: judge.external, crossCheckAgreement },
      predictionAccuracy: accuracy,
      truncatedByBudget,
      failedEpisodes,
      judgeFailures,
      failedEpisodeRecords,
      ...(armImbalance !== undefined ? { armImbalance } : {}),
    },
    allTraces,
    analystCostUsd,
    judgeResults,
  };
}
