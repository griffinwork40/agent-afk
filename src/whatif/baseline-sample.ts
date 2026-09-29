/**
 * Baseline-sample preflight for the what-if prediction engine (#2511).
 *
 * Before the full episode run, this module runs the BASELINE arm only on up
 * to K=3 probe episodes (1 sample each) per prediction, grades each
 * prediction's testQuestion on those probes, and computes the measured
 * headroom. The measured headroom replaces the analyst-estimate headroom check
 * for each prediction when sampling is enabled.
 *
 * Conservative gate: use the most optimistic sampled probe result.
 *   - added/strengthened: headroom = 1 − min(P(yes))  (most room to increase)
 *   - removed/weakened:   headroom = max(P(yes))       (most room to decrease)
 *
 * The gate trips when that headroom < MDE and uses the same WhatifMdeError /
 * error type as the analyst-estimate check, but a MEASURED no-headroom result
 * is not bypassed by --force: --force is routinely needed to pass the generic
 * MDE gate, so honouring it here would make this check a warning nobody acts
 * on (pilot 2 spent $9.49 under --force). Override with --no-baseline-sample.
 *
 * NOTE: sample episodes are NOT reused in the final statistics (§4 of the
 * design). Keeping the arms paired and balanced requires that the final
 * verifyRun uses the full episode set untouched by the sample run.
 *
 * @module whatif/baseline-sample
 */

import { mdeForN, headroomForPrediction } from './mde.js';
import { renderTrace } from './trace-render.js';
import { estimateVerifyCost } from './cost.js';
import { WhatifMdeError } from './run.js';
import type {
  AgentRunner,
  Episode,
  EpisodeTrace,
  Judge,
  JudgeInput,
  Prediction,
  RunnerOptions,
  Environment,
  WhatifProgress,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of probe episodes to sample per prediction. */
export const BASELINE_SAMPLE_K = 3;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-prediction result from the baseline-sample preflight.
 * Recorded in results.json under verify.baselineSample.
 */
export interface PredictionBaselineSample {
  /** Prediction id. */
  predictionId: string;
  /** P(yes) scores from the sampled baseline probes. */
  probeRates: number[];
  /** Mean P(yes) across sampled probes. */
  mean: number;
  /**
   * Most optimistic headroom:
   *   added/strengthened: 1 − min(probeRates)
   *   removed/weakened:   max(probeRates)
   */
  optimisticHeadroom: number;
  /** Achieved MDE at K probes per prediction per arm. */
  mde: number;
  /** Whether the headroom gate tripped for this prediction. */
  tripped: boolean;
}

/** Aggregate result returned from runBaselineSample. */
export interface BaselineSampleResult {
  perPrediction: PredictionBaselineSample[];
  /** True if any prediction tripped the headroom gate. */
  anyTripped: boolean;
  /**
   * Agent spend of the sample episodes (sum of trace costUsd). Judge calls are
   * not included: the judge interface does not report per-call cost.
   */
  agentCostUsd: number;
  /** The first prediction that tripped, with its refusal message (warnOnly runs). */
  firstTrip?: { predictionId: string; fullRunProbes: number; message: string };
}

// ---------------------------------------------------------------------------
// Cost helper
// ---------------------------------------------------------------------------

/**
 * A cold-cache episode costs about 5x a warm one, so the cold start adds about
 * 4 warm episodes' worth. History: pilots 2 and 3 (runs ac34b6, 80f548) show
 * cold first episodes at $0.55-0.61 against a $0.13-0.14 mean, i.e. 4.2-4.7x.
 * The #2518 live check measured $1.16 of sample agent spend against the old
 * warm-only estimate of $0.52; this model gives ~$1.21. The theoretical
 * cache-write premium on systemTokens alone explains only ~$0.08-0.16, because
 * the cached prefix also carries tool definitions that systemTokens omits.
 */
const COLD_START_EXTRA_EPISODES = 4;

/**
 * Estimate the additional USD cost for one baseline-sample run.
 *
 * K samples × predictions.length probe episodes, baseline arm only, 1 sample
 * each.  Judge calls: K × predictions.length × 1 env × 1 sample.
 * Uses the full estimateVerifyCost function with the baseline system tokens.
 *
 * Formula:
 *   warmUsd = estimateVerifyCost(episodes = K × nPredictions, samples = 1).usd / 2
 *             (÷2 because baseline arm only — half the symmetric estimate)
 *   warmPerEpisode = warmUsd / (K × nPredictions)
 *   result = warmUsd + COLD_START_EXTRA_EPISODES × warmPerEpisode
 *             (adds the one-time cold-start premium for the first episode)
 */
export function estimateBaselineSampleCost(input: {
  predictions: Prediction[];
  agentModel: string;
  analystModel: string;
  systemTokensBaseline: number;
  judgeExternal: boolean;
}): number {
  // We run K probes per prediction baseline-only with 1 sample.
  // Reuse estimateVerifyCost with episodes = K * nPredictions, samples = 1,
  // but half the cost (baseline only, no candidate arm).
  const totalProbes = input.predictions.length * BASELINE_SAMPLE_K;
  const fullCost = estimateVerifyCost({
    episodes: totalProbes,
    samples: 1,
    agentModel: input.agentModel,
    analystModel: input.analystModel,
    systemTokens: {
      baseline: input.systemTokensBaseline,
      candidate: input.systemTokensBaseline, // estimate uses symmetric value
    },
    judgeExternal: input.judgeExternal,
  });
  // Baseline-only: agent cost is ~½ (only baseline arm runs); judge cost is
  // still per output (1 baseline output per probe).
  // Both the agent and judge terms scale with outputs, and a baseline-only
  // run has half the outputs, so half the symmetric estimate is the warm cost.
  const warmUsd = fullCost.usd / 2;
  // Invariant: estimateVerifyCost's per-episode figure is a warm prompt-cache
  // average. That holds over a full run, but the sample runs its episodes one
  // at a time on a cold cache, so its first episode pays the cache write. All
  // predictions share one baseline prompt, so a sample phase pays exactly one
  // cold start (the 5-minute cache TTL outlives the phase).
  const warmPerEpisode = totalProbes > 0 ? warmUsd / totalProbes : 0;
  return warmUsd + COLD_START_EXTRA_EPISODES * warmPerEpisode;
}

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run the baseline-sample preflight for all predictions.
 *
 * For each prediction, runs up to K=3 of its probe episodes against the
 * baseline arm only (1 sample each), grades with the judge, and computes
 * the per-prediction headroom. Prints one info line per prediction, and a
 * warning line when the gate trips.
 *
 * Throws WhatifMdeError when any prediction trips, unless warnOnly (an
 * inspection hook for tests; production passes false).
 */
export async function runBaselineSample(input: {
  predictions: Prediction[];
  episodes: Episode[];
  baseline: Environment;
  runner: AgentRunner;
  judge: Judge;
  runnerOpts: RunnerOptions;
  warnOnly: boolean;
  signal?: AbortSignal;
  onProgress?: (p: WhatifProgress) => void;
}): Promise<BaselineSampleResult> {
  const { predictions, episodes, baseline, runner, judge, runnerOpts, warnOnly, signal, onProgress } = input;

  const perPrediction: PredictionBaselineSample[] = [];
  let anyTripped = false;
  let agentCostUsd = 0;
  let firstTrip: BaselineSampleResult['firstTrip'];

  for (const pred of predictions) {
    if (signal?.aborted) break;

    // Select up to K probe episodes targeting this prediction.
    const targeted = episodes.filter((e) => e.targets === pred.id && e.source === 'synthetic');
    const probeEps = targeted.slice(0, BASELINE_SAMPLE_K);
    // Invariant: the gate compares headroom against the MDE of the FULL run
    // (all of this prediction's probes), not of the K-probe sample. The sample
    // only estimates the baseline rate; the full run is what must detect a shift.
    const fullRunProbes = targeted.length;
    const mde = mdeForN(fullRunProbes);

    if (probeEps.length === 0) {
      // No targeted probes — skip this prediction silently.
      continue;
    }

    // Run baseline arm only, 1 sample, for each probe.
    const probeRates: number[] = [];
    for (const ep of probeEps) {
      if (signal?.aborted) break;
      let trace: EpisodeTrace;
      try {
        trace = await runner.run(baseline, ep, 0 /* sample=0 */, runnerOpts);
      } catch {
        // Non-fatal: skip this probe.
        continue;
      }
      agentCostUsd += trace.costUsd ?? 0;
      if (trace.error) continue;

      // Grade the prediction's testQuestion on this trace.
      const judgeInput: JudgeInput = {
        prompt: ep.prompt,
        output: renderTrace(trace),
        questions: [{ id: pred.id, question: pred.testQuestion }],
      };
      let score: number | undefined;
      try {
        const result = await judge.grade(judgeInput, signal);
        score = result[pred.id];
      } catch {
        // Non-fatal: skip.
      }
      if (score !== undefined) probeRates.push(score);
    }

    if (probeRates.length === 0) continue;

    const mean = probeRates.reduce((a, b) => a + b, 0) / probeRates.length;

    // Conservative gate: most optimistic headroom.
    const optimisticBaselineRate =
      pred.direction === 'added' || pred.direction === 'strengthened'
        ? Math.min(...probeRates)  // lowest baseline → most room to increase
        : Math.max(...probeRates); // highest baseline → most room to decrease

    const optimisticHeadroom = headroomForPrediction(optimisticBaselineRate, pred.direction) ?? 0;
    const tripped = optimisticHeadroom < mde;

    // Print info line: sampled baseline mean over n probes.
    const meanPct = Math.round(mean * 100);
    const n = probeRates.length;
    onProgress?.({
      stage: 'preflight',
      message:
        `Prediction ${pred.id} baseline sample (${n} probe${n === 1 ? '' : 's'}): ` +
        `mean P(yes)=${meanPct}%`,
    });

    if (tripped) {
      anyTripped = true;
      const headroomPp = Math.round(optimisticHeadroom * 100);
      const mdePp = Math.round(mde * 100);
      const line =
        `Prediction ${pred.id} (${pred.direction}): measured baseline mean ${meanPct}%, ` +
        `leaving at most ${headroomPp}pp of room; ${fullRunProbes} probes can only detect shifts ` +
        `≥${mdePp}pp, so this run cannot confirm it.`;
      onProgress?.({ stage: 'preflight', message: line });
      const message =
        `${line} More probes will not fix this; choose probes where the baseline leaves room, ` +
        'or pass --no-baseline-sample to run anyway.';
      firstTrip ??= { predictionId: pred.id, fullRunProbes, message };
      if (!warnOnly) {
        throw new WhatifMdeError(fullRunProbes, message, { kind: 'headroom', predictionId: pred.id });
      }
    }

    perPrediction.push({
      predictionId: pred.id,
      probeRates,
      mean,
      optimisticHeadroom,
      mde,
      tripped,
    });
  }

  return { perPrediction, anyTripped, agentCostUsd, ...(firstTrip ? { firstTrip } : {}) };
}
