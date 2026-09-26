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
import { compareRates, verdictFor, predictionAccuracy, agreementRate } from './stats.js';
import { discoverDifferences, type OutputPair } from './discover.js';
import { appendCalibration, type CalibrationRecord } from './ledger.js';
import { BudgetTracker } from './cost.js';
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
// Output rendering (for judge input)
// ---------------------------------------------------------------------------

/** Truncate long input JSON to prevent judge overload. */
function truncInput(v: unknown, maxChars: number): string {
  const s = JSON.stringify(v) ?? '';
  return s.length <= maxChars ? s : s.slice(0, maxChars) + '…[truncated]';
}

/**
 * Render an episode trace into a compact text for the judge.
 * Shows assistant text then a compact tool-request list.
 */
function renderTrace(trace: EpisodeTrace): string {
  const parts: string[] = [trace.text];
  for (const t of trace.tools) {
    if (t.verdict === 'recorded') {
      parts.push(`[tool requested: ${t.tool} (not executed)] ${truncInput(t.input, 200)}`);
    } else {
      parts.push(`[tool used: ${t.tool}]`);
    }
  }
  return parts.join('\n');
}

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

  return { allTraces, truncatedByBudget, failedEpisodes };
}

// ---------------------------------------------------------------------------
// Judge phase
// ---------------------------------------------------------------------------

interface GradeResult {
  judgeResults: Map<string, Record<string, number>>;
  crossCheckMainScores: number[];
  crossCheckCrossScores: number[];
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
  let judgeFailures = 0;

  async function judgeOne(trace: EpisodeTrace, idx: number): Promise<void> {
    if (signal?.aborted) return;
    const key = `${trace.episodeId}:${trace.env}:${trace.sample}`;
    const input: JudgeInput = {
      prompt: episodes.find((e) => e.id === trace.episodeId)?.prompt ?? '',
      output: renderTrace(trace),
      questions,
    };
    try {
      const result = await judge.grade(input, signal);
      judgeResults.set(key, result);
      if (crossCheckJudge && crossCheckIndices(goodTraces.length, 3).includes(idx)) {
        try {
          const ccResult = await crossCheckJudge.grade(input, signal);
          for (const q of questions) {
            const main = result[q.id];
            const cross = ccResult[q.id];
            if (main === undefined || cross === undefined) continue;
            crossCheckMainScores.push(main);
            crossCheckCrossScores.push(cross);
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

  return { judgeResults, crossCheckMainScores, crossCheckCrossScores, judgeFailures };
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

function scoresForQuestion(
  qid: string,
  env: 'baseline' | 'candidate',
  goodTraces: EpisodeTrace[],
  judgeResults: Map<string, Record<string, number>>,
): number[] {
  const scores: number[] = [];
  for (const trace of goodTraces) {
    if (trace.env !== env) continue;
    const key = `${trace.episodeId}:${trace.env}:${trace.sample}`;
    const res = judgeResults.get(key);
    if (res !== undefined && res[qid] !== undefined) scores.push(res[qid]!);
  }
  return scores;
}

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

  const { allTraces, truncatedByBudget, failedEpisodes } = await runEpisodes(
    episodes, baseline, candidate, samples, concurrency, maxUsdRemaining,
    runner, runnerOpts, signal, onProgress,
  );

  if (signal?.aborted) {
    const err = new Error('whatif aborted');
    (err as Error & { isAbortError: boolean }).isAbortError = true;
    throw err;
  }

  const goodTraces = allTraces.filter((t) => !t.error);

  // ── 2. Judge ──────────────────────────────────────────────────────────────

  onProgress?.({ stage: 'judge', message: 'Grading outputs', done: 0, total: goodTraces.length });

  const predQuestions = predictions.map((p) => ({ id: p.id, question: p.testQuestion }));

  const { judgeResults, crossCheckMainScores, crossCheckCrossScores, judgeFailures } = await gradeOutputs(
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
      const key = `${trace.episodeId}:${trace.env}:${trace.sample}`;
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

  const verifiedPredictions = predictions.map((p) => {
    const bScores = scoresForQuestion(p.id, 'baseline', goodTraces, judgeResults);
    const cScores = scoresForQuestion(p.id, 'candidate', goodTraces, judgeResults);
    const rates = compareRates(bScores, cScores);
    return { prediction: p, rates, verdict: verdictFor(p, rates) };
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

  const calibrationRecords: CalibrationRecord[] = verifiedPredictions.map(({ prediction, rates, verdict }) => ({
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
    },
    allTraces,
    analystCostUsd,
  };
}
