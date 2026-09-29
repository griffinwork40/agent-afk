/**
 * Preflight helpers for the what-if verify phase.
 *
 * Extracted from `run.ts` to keep that file under the 350-code-line ceiling.
 * `run.ts` calls `runPreflightChecks` and `resolveMinProbesPerPrediction`;
 * both are internal to the whatif package and not part of the public API.
 *
 * @module whatif/run.preflight
 */

import { estimateVerifyCost } from './cost.js';
import {
  isUnderpowered,
  mdePreflightLine,
  isHeadroomUnderpowered,
  headroomPreflightLine,
} from './mde.js';
import { runBaselineSample, type BaselineSampleResult } from './baseline-sample.js';
import { WhatifBudgetError, WhatifMdeError } from './run.js';

// ---------------------------------------------------------------------------
// PreflightInput
// ---------------------------------------------------------------------------

export interface PreflightInput {
  /** Total episodes per arm (for budget estimation). */
  episodesPerArm: number;
  /** Minimum probe count per prediction (drives per-prediction MDE gate). */
  minProbesPerPrediction: number;
  /** Number of prediction episodes (synthetic probes) per arm. */
  syntheticPerArm: number;
  /** Number of predictions retained (for breakdown display). */
  predictionCount: number;
  /** Predictions — used for the headroom check (#2504). */
  predictions: import('./types.js').Prediction[];
  force: boolean;
  samples: number;
  agentModel: string;
  analystModel: string;
  systemTokens: { baseline: number; candidate: number };
  judgeExternal: boolean;
  analystCostUsd: number;
  maxUsd: number;
  /** Additional cost from the baseline-sample preflight (#2511). */
  baselineSampleCostUsd: number;
  /**
   * When true, a measured baseline sample runs next and supersedes the
   * analyst's baselineEstimate, so the estimate-based headroom gate is skipped
   * (an unreliable guess must not refuse a run the measurement would allow).
   */
  measuredHeadroomPending?: boolean;
  onProgress: ((p: { stage: 'preflight'; message: string }) => void) | undefined;
}

// ---------------------------------------------------------------------------
// runPreflightChecks
// ---------------------------------------------------------------------------

/**
 * Emit MDE preflight info, check the MDE gate, and check the budget gate.
 * Throws `WhatifMdeError` or `WhatifBudgetError` on gate violations.
 *
 * The MDE gate uses `minProbesPerPrediction` — the minimum number of synthetic
 * probe episodes assigned to any single prediction — because each prediction
 * is scored only on its own probes (issue #2403).  Total episode count is used
 * only for the cost estimate.
 *
 * The headroom check (#2504) fires when a prediction's `baselineEstimate`
 * leaves less room than the achieved MDE.  It uses the same `WhatifMdeError`
 * and is bypassed by `--force`.
 */
export function runPreflightChecks(input: PreflightInput): void {
  const {
    episodesPerArm, minProbesPerPrediction, force, samples, agentModel, analystModel,
    systemTokens, judgeExternal, analystCostUsd, maxUsd, onProgress,
    predictionCount, syntheticPerArm, predictions, baselineSampleCostUsd, measuredHeadroomPending,
  } = input;

  onProgress?.({ stage: 'preflight', message: mdePreflightLine(minProbesPerPrediction) });

  if (isUnderpowered(minProbesPerPrediction) && !force) {
    throw new WhatifMdeError(minProbesPerPrediction, undefined, { kind: 'mde' });
  }

  // Headroom check (#2504): per-prediction baseline headroom vs. achieved MDE.
  // Uses the same gate (WhatifMdeError) so --force bypasses it identically.
  // The warning always prints (pilot runs use --force and must still see it);
  // only the refusal is bypassed by --force.
  for (const pred of measuredHeadroomPending ? [] : predictions) {
    if (!isHeadroomUnderpowered(pred, minProbesPerPrediction)) continue;
    // Contract: isHeadroomUnderpowered returns true only when baselineEstimate
    // is defined, so the narrowed type assertion is safe here.
    const narrowed = pred as typeof pred & { baselineEstimate: number };
    const line = headroomPreflightLine(narrowed, minProbesPerPrediction);
    onProgress?.({ stage: 'preflight', message: line });
    if (!force) {
      throw new WhatifMdeError(
        minProbesPerPrediction,
        `${line} More probes will not fix this; choose probes where the baseline leaves room, or use --force.`,
        { kind: 'headroom', predictionId: pred.id },
      );
    }
  }

  const estimate = estimateVerifyCost({
    episodes: episodesPerArm,
    samples,
    agentModel,
    analystModel,
    systemTokens,
    judgeExternal,
  });

  const totalEstimate = estimate.usd + analystCostUsd + baselineSampleCostUsd;
  // Emit estimated spend + breakdown before the budget gate.
  const sampleNote = baselineSampleCostUsd > 0
    ? ` + baseline sample $${baselineSampleCostUsd.toFixed(4)}`
    : '';
  onProgress?.({
    stage: 'preflight',
    message:
      `estimated spend $${totalEstimate.toFixed(4)} ` +
      `(${syntheticPerArm} probe episodes for ${predictionCount} predictions` +
      ` + ${episodesPerArm - syntheticPerArm} replay/suite episodes, × ${samples} samples × 2 arms;` +
      ` analyst $${analystCostUsd.toFixed(4)}${sampleNote})`,
  });

  if (totalEstimate > maxUsd) {
    throw new WhatifBudgetError(totalEstimate, maxUsd);
  }
}

// ---------------------------------------------------------------------------
// resolveMinProbesPerPrediction
// ---------------------------------------------------------------------------

/**
 * Return the minimum number of synthetic probe episodes targeting any single
 * prediction across all predictions.
 *
 * Each prediction is scored only on its own probes (`episode.targets ===
 * prediction.id`); real-turn replays do not count.  The minimum is used as
 * the per-prediction n for the MDE gate because the least-powered prediction
 * determines the run's worst-case detectability.
 */
export function resolveMinProbesPerPrediction(
  predictions: import('./types.js').Prediction[],
  episodes: import('./types.js').Episode[],
): number {
  if (predictions.length === 0) return 0;
  const counts = predictions.map((p) => episodes.filter((e) => e.targets === p.id).length);
  return Math.min(...counts);
}

// ---------------------------------------------------------------------------
// runBaselineSamplePhase (extracted from runWhatif for the funcsize ceiling)
// ---------------------------------------------------------------------------

/** Parameters for the baseline-sample phase inside runWhatif. */
export interface BaselineSamplePhaseInput {
  noBaselineSample: boolean;
  predictions: import('./types.js').Prediction[];
  episodes: import('./types.js').Episode[];
  baseline: import('./types.js').Environment;
  runner: import('./types.js').AgentRunner;
  judge: import('./types.js').Judge;
  episodeTimeoutMs: number;
  maxTurns: number;
  signal?: AbortSignal;
  onProgress?: (p: import('./types.js').WhatifProgress) => void;
  closeJudges: () => Promise<void>;
  /** Run directory; a refusal writes `refused.json` here so its evidence and spend survive. */
  runDir: string;
}

/**
 * Run the optional baseline-sample preflight phase within runWhatif.
 * Throws on gate violation (re-closes judges first).
 * Returns undefined when noBaselineSample=true or predictions is empty.
 */
export async function runBaselineSamplePhase(
  input: BaselineSamplePhaseInput,
): Promise<BaselineSampleResult | undefined> {
  const {
    noBaselineSample, predictions, episodes, baseline, runner, judge,
    episodeTimeoutMs, maxTurns, signal, onProgress, closeJudges, runDir,
  } = input;
  if (noBaselineSample || predictions.length === 0) return undefined;
  try {
    const result = await runBaselineSample({
      predictions,
      episodes,
      baseline,
      runner,
      judge,
      runnerOpts: { timeoutMs: episodeTimeoutMs, maxTurns, signal },
      // Sample every prediction first (warnOnly), then refuse below, so the
      // refusal record covers all predictions rather than only the first trip.
      warnOnly: true,
      signal,
      onProgress,
    });
    // --force deliberately does not bypass a measured no-headroom refusal
    // (see baseline-sample.ts); --no-baseline-sample is the override.
    if (result.firstTrip) {
      await persistRefusal(runDir, result);
      const { fullRunProbes, message, predictionId } = result.firstTrip;
      throw new WhatifMdeError(fullRunProbes, message, { kind: 'headroom', predictionId });
    }
    return result;
  } catch (sampleErr) {
    await closeJudges();
    throw sampleErr;
  }
}

/**
 * Write `refused.json` so a refused run keeps what the gate measured and what
 * the sample cost (otherwise the run dir is empty and the spend is invisible).
 * Best-effort: a write failure must not mask the refusal itself.
 */
async function persistRefusal(runDir: string, result: BaselineSampleResult): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const record = {
    refusedAt: new Date().toISOString(),
    reason: result.firstTrip?.message,
    predictionId: result.firstTrip?.predictionId,
    sampleAgentCostUsd: result.agentCostUsd,
    sampleCostNote: 'Agent episodes only; judge calls are not included.',
    baselineSample: result.perPrediction,
  };
  try {
    await writeFile(join(runDir, 'refused.json'), JSON.stringify(record, null, 2) + '\n');
  } catch (err) {
    console.warn(`[whatif] could not write refused.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// runVerifyPreflight (convenience wrapper for runWhatif)
// ---------------------------------------------------------------------------

/** Input for the combined preflight step inside runWhatif. */
export interface VerifyPreflightInput {
  episodes: import('./types.js').Episode[];
  predictions: import('./types.js').Prediction[];
  structural: import('./types.js').StructuralImpact;
  force: boolean;
  samples: number;
  agentModel: string;
  analystModel: string;
  judgeExternal: boolean;
  analystCostUsd: number;
  maxUsd: number;
  noBaselineSample: boolean;
  onProgress: ((p: { stage: 'preflight'; message: string }) => void) | undefined;
  closeJudges: () => Promise<void>;
}

/**
 * Runs the combined preflight step: computes sample cost, calls
 * runPreflightChecks (MDE + headroom + budget gates), and returns the
 * noBaselineSample flag and baselineSampleCostUsd for downstream use.
 *
 * Closes judges and rethrows on any gate error.
 */
export async function runVerifyPreflight(input: VerifyPreflightInput): Promise<{
  episodesPerArm: number;
  minProbesPerPrediction: number;
  noBaselineSample: boolean;
  baselineSampleCostUsd: number;
}> {
  const {
    episodes, predictions, structural, force, samples, agentModel, analystModel,
    judgeExternal, analystCostUsd, maxUsd, noBaselineSample, onProgress, closeJudges,
  } = input;
  const episodesPerArm = episodes.length;
  const minProbesPerPrediction = resolveMinProbesPerPrediction(predictions, episodes);
  // Pre-count episodes per prediction in one pass (O(episodes)) to avoid the
  // O(predictions × episodes) reduce+filter pattern flagged in #2487.
  const episodeCountByPrediction = new Map<string, number>();
  for (const ep of episodes) {
    if (ep.targets !== undefined) {
      episodeCountByPrediction.set(ep.targets, (episodeCountByPrediction.get(ep.targets) ?? 0) + 1);
    }
  }
  const syntheticPerArm = predictions.reduce(
    (s, p) => s + (episodeCountByPrediction.get(p.id) ?? 0),
    0,
  );
  const { estimateBaselineSampleCost } = await import('./baseline-sample.js');
  const baselineSampleCostUsd = noBaselineSample ? 0 : estimateBaselineSampleCost({
    predictions,
    agentModel,
    analystModel,
    systemTokensBaseline: structural.tokens.baseline,
    judgeExternal,
  });
  try {
    runPreflightChecks({
      episodesPerArm,
      minProbesPerPrediction,
      syntheticPerArm,
      predictionCount: predictions.length,
      predictions,
      force,
      samples,
      agentModel,
      analystModel,
      systemTokens: { baseline: structural.tokens.baseline, candidate: structural.tokens.candidate },
      judgeExternal,
      analystCostUsd,
      maxUsd,
      baselineSampleCostUsd,
      measuredHeadroomPending: !noBaselineSample && predictions.length > 0,
      onProgress,
    });
  } catch (err) {
    await closeJudges();
    throw err;
  }
  return { episodesPerArm, minProbesPerPrediction, noBaselineSample, baselineSampleCostUsd };
}
