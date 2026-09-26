/**
 * Aggregate paired A/B trial results and produce comparison metrics.
 *
 * For each trial pair, this module:
 *   1. Verifies that both arms produced trace identity (sessionId/tracePath).
 *   2. Reads and parses both witness traces via `parseTrace`.
 *   3. Calls `analyze()` on each trace.
 *   4. Calls `validate()` on each report and fails the trial if either is invalid.
 *   5. Aggregates metrics across all valid trials.
 *
 * All I/O (trace parsing) is injectable for unit testing.
 *
 * @module scripts/workspace-ab/compare
 */

import type { DedupReport, ValidationResult } from './types.js';
import type { ArmResult } from './run-arm.js';
import { analyze, validate } from './analyze-read-dedup.js';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Outcome of a single paired trial (control + treatment). */
export interface TrialResult {
  trialIndex: number;
  control: ArmResult;
  treatment: ArmResult;
  /** validate() results for each arm. */
  validation: { control: ValidationResult; treatment: ValidationResult };
  /** analyze() reports for each arm — absent when the arm failed, trace is missing, or validation failed. */
  metrics: { control?: DedupReport; treatment?: DedupReport };
  /** True when both arms passed validation and can contribute to aggregate stats. */
  usable: boolean;
}

/** Injectable trace-parsing function. */
export type ParseTraceFn = (
  tracePath: string,
  allTools: boolean,
) => Promise<{
  calls: import('./types.js').ToolCallStarted[];
  skippedNoFingerprint: number;
  totalToolCallStarted: number;
  hasValidClosure: boolean;
  childFailureRate: number;
}>;

// ─── Comparison ─────────────────────────────────────────────────────────────

/**
 * Run comparison analysis on a set of paired trial results.
 *
 * Resolves a `TrialResult[]` — each entry marks whether the trial is `usable`
 * (both arms valid) and carries the raw metrics for the manifest.
 *
 * Throws if:
 *   - Either arm exited nonzero (already recorded in `ArmResult.success`).
 *   - A trace identity field (tracePath) is missing after a successful run.
 *   - The trace cannot be parsed (I/O error from `parseTraceFn`).
 *   - `validate()` rejects either report.
 *
 * Callers that want to continue past per-trial failures should wrap each
 * `compareTrialPair` call in a try/catch and decide whether to abort or skip.
 */
export async function compareTrialPair(
  control: ArmResult,
  treatment: ArmResult,
  parseTraceFn: ParseTraceFn,
): Promise<TrialResult> {
  const trialIndex = control.trialIndex;

  // ── Arm exit check ─────────────────────────────────────────────────────────
  if (!control.success) {
    throw new Error(
      `Trial ${trialIndex} control arm failed (exit ${control.exitCode}): ${control.errorMessage ?? ''}`,
    );
  }
  if (!treatment.success) {
    throw new Error(
      `Trial ${trialIndex} treatment arm failed (exit ${treatment.exitCode}): ${treatment.errorMessage ?? ''}`,
    );
  }

  // ── Trace identity check ───────────────────────────────────────────────────
  if (!control.tracePath) {
    throw new Error(
      `Trial ${trialIndex} control arm missing tracePath — ensure AFK_TRACE_DISABLED is not set and afk outputs -f json with sessionId/tracePath fields.`,
    );
  }
  if (!treatment.tracePath) {
    throw new Error(
      `Trial ${trialIndex} treatment arm missing tracePath — ensure AFK_TRACE_DISABLED is not set and afk outputs -f json with sessionId/tracePath fields.`,
    );
  }

  // ── Parse both traces ──────────────────────────────────────────────────────
  const [controlTrace, treatmentTrace] = await Promise.all([
    parseTraceFn(control.tracePath, false),
    parseTraceFn(treatment.tracePath, false),
  ]);

  // ── Analyze ────────────────────────────────────────────────────────────────
  const controlReport = analyze({
    calls: controlTrace.calls,
    tracePath: control.tracePath,
    allTools: false,
    skippedNoFingerprint: controlTrace.skippedNoFingerprint,
    totalToolCallStarted: controlTrace.totalToolCallStarted,
  });
  const treatmentReport = analyze({
    calls: treatmentTrace.calls,
    tracePath: treatment.tracePath,
    allTools: false,
    skippedNoFingerprint: treatmentTrace.skippedNoFingerprint,
    totalToolCallStarted: treatmentTrace.totalToolCallStarted,
  });

  // ── Validate ───────────────────────────────────────────────────────────────
  const controlValidation = validate(controlReport, {
    hasValidClosure: controlTrace.hasValidClosure,
    childFailureRate: controlTrace.childFailureRate,
  });
  const treatmentValidation = validate(treatmentReport, {
    hasValidClosure: treatmentTrace.hasValidClosure,
    childFailureRate: treatmentTrace.childFailureRate,
  });

  const usable = controlValidation.valid && treatmentValidation.valid;

  return {
    trialIndex,
    control,
    treatment,
    validation: { control: controlValidation, treatment: treatmentValidation },
    metrics: { control: controlReport, treatment: treatmentReport },
    usable,
  };
}

/**
 * Aggregate summary across all usable trial pairs.
 * Returns null fields when no valid trials exist.
 */
export function aggregateTrials(trials: TrialResult[]): {
  usableTrials: number;
  controlAvgDedupRatio: number | null;
  treatmentAvgDedupRatio: number | null;
  dedupRatioDelta: number | null;
} {
  const usable = trials.filter((t) => t.usable);
  if (usable.length === 0) {
    return { usableTrials: 0, controlAvgDedupRatio: null, treatmentAvgDedupRatio: null, dedupRatioDelta: null };
  }

  const controlRatios = usable
    .map((t) => t.metrics.control?.crossAgentDedupRatio)
    .filter((v): v is number => v !== undefined);
  const treatmentRatios = usable
    .map((t) => t.metrics.treatment?.crossAgentDedupRatio)
    .filter((v): v is number => v !== undefined);

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const controlAvg = controlRatios.length > 0 ? avg(controlRatios) : null;
  const treatmentAvg = treatmentRatios.length > 0 ? avg(treatmentRatios) : null;

  return {
    usableTrials: usable.length,
    controlAvgDedupRatio: controlAvg,
    treatmentAvgDedupRatio: treatmentAvg,
    dedupRatioDelta:
      controlAvg !== null && treatmentAvg !== null ? treatmentAvg - controlAvg : null,
  };
}
