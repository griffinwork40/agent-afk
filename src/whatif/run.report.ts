/**
 * Helper for building and persisting the verified WhatifReport.
 *
 * Extracted from run.ts to keep that file within the 350-code-line ceiling.
 *
 * @module whatif/run.report
 */

import type { ChangeSpec, EpisodeTrace, Judge, Prediction, VerifyResult, WhatifReport } from './types.js';
import type { DroppedProbe } from './probe-grounding.js';
import type { CorpusExclusions } from './episodes.js';
import type { StructuralImpact } from './types.js';
import type { JudgeResults } from './run.verify.scoring.js';
import type { QuestionFitLevel } from './question-fit.js';
import { standardLimits, buildHeadline } from './report.js';
import { verifyShortfallLimits, hookIsolationLimits } from './run.limits.js';
import { persistRun } from './run.persist.js';

export interface VerifiedReportArgs {
  spec: ChangeSpec;
  structural: StructuralImpact;
  predictions: Prediction[];
  questionFit: QuestionFitLevel;
  verifyResult: VerifyResult;
  droppedProbes: DroppedProbe[];
  corpusExclusions: CorpusExclusions;
  verifyTraces: EpisodeTrace[];
  analystCostUsd: number;
  runDir: string;
  resolvedJudge: Judge;
  autoKeepContextHooks: boolean;
  /** Per-output judge grades from the verify phase; written to grades.jsonl (#2477). */
  judgeResults: JudgeResults;
  /** Per-prediction baseline-sample results (#2511); absent when sampling was skipped. */
  baselineSamplePerPrediction?: import('./baseline-sample.js').PredictionBaselineSample[];
}

/** Build the verified WhatifReport, persist it, and return it. */
export async function buildAndPersistVerifiedReport(args: VerifiedReportArgs): Promise<WhatifReport> {
  const { spec, structural, predictions, questionFit, verifyResult, droppedProbes, corpusExclusions,
    verifyTraces, analystCostUsd, runDir, resolvedJudge, autoKeepContextHooks,
    judgeResults, baselineSamplePerPrediction } = args;
  const episodesCostUsd = verifyTraces.reduce((s, t) => s + t.costUsd, 0);
  const totalCostUsd = analystCostUsd + episodesCostUsd;
  const limits = [
    ...standardLimits({ verified: true, judgeExternal: resolvedJudge.external, verifiedPredictions: verifyResult.predictions }),
    ...verifyShortfallLimits(verifyResult),
    ...hookIsolationLimits({ keepContextHooks: autoKeepContextHooks, structural }),
  ];
  // Attach baseline-sample results to the verify block if present (#2511).
  const verifyWithSample: typeof verifyResult = baselineSamplePerPrediction
    ? { ...verifyResult, baselineSample: baselineSamplePerPrediction }
    : verifyResult;
  const partialReport: Omit<WhatifReport, 'headline'> = {
    spec, structural, predictions, questionFit, verify: verifyWithSample, costUsd: totalCostUsd, runDir, limits,
    ...(droppedProbes.length > 0 ? { droppedProbes } : {}),
    corpusExclusions,
  };
  const report: WhatifReport = { ...partialReport, headline: buildHeadline(partialReport) };
  await persistRun(runDir, report, verifyTraces, judgeResults);
  return report;
}
