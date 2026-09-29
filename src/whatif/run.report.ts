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
import { standardLimits, buildHeadline } from './report.js';
import { verifyShortfallLimits, hookIsolationLimits } from './run.limits.js';
import { persistRun } from './run.persist.js';

export interface VerifiedReportArgs {
  spec: ChangeSpec;
  structural: StructuralImpact;
  predictions: Prediction[];
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
  /** Present when --keep-sandboxes was set; arm-to-root mapping. */
  keptSandboxes?: { baseline: string; candidate: string };
}

/** Build the verified WhatifReport, persist it, and return it. */
export async function buildAndPersistVerifiedReport(args: VerifiedReportArgs): Promise<WhatifReport> {
  const { spec, structural, predictions, verifyResult, droppedProbes, corpusExclusions,
    verifyTraces, analystCostUsd, runDir, resolvedJudge, autoKeepContextHooks,
    judgeResults, keptSandboxes } = args;
  const episodesCostUsd = verifyTraces.reduce((s, t) => s + t.costUsd, 0);
  const totalCostUsd = analystCostUsd + episodesCostUsd;
  const limits = [
    ...standardLimits({ verified: true, judgeExternal: resolvedJudge.external, verifiedPredictions: verifyResult.predictions }),
    ...verifyShortfallLimits(verifyResult),
    ...hookIsolationLimits({ keepContextHooks: autoKeepContextHooks, structural }),
  ];
  const partialReport: Omit<WhatifReport, 'headline'> = {
    spec, structural, predictions, verify: verifyResult, costUsd: totalCostUsd, runDir, limits,
    ...(droppedProbes.length > 0 ? { droppedProbes } : {}),
    corpusExclusions,
    ...(keptSandboxes !== undefined ? { keptSandboxes } : {}),
  };
  const report: WhatifReport = { ...partialReport, headline: buildHeadline(partialReport) };
  await persistRun(runDir, report, verifyTraces, judgeResults);
  return report;
}
