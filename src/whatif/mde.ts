/**
 * Minimum-detectable-effect (MDE) helper for the what-if prediction engine.
 *
 * ## Statistical basis
 *
 * The upstream PR (#2473) uses the Newcombe hybrid-score CI over per-episode
 * mean scores.  For the MDE approximation we adopt the standard power formula
 * at alpha = 0.05 (two-sided) and 80% power, with worst-case variance (p = 0.5)
 * and a balanced design.
 *
 *   se(p̂) ≈ sqrt(p(1-p)/n)  → worst case at p = 0.5: sqrt(0.25/n)
 *
 * The MDE for the difference of two proportions is:
 *
 *   MDE = (Z_ALPHA + Z_POWER) × sqrt(se_baseline² + se_candidate²)
 *       = (1.96 + 0.8416) × sqrt(0.25/n + 0.25/n)
 *       = 2.8016 × sqrt(0.5/n)
 *
 * This is the smallest shift detectable with 80% power at alpha = 0.05
 * (two-sided).  At n = 20 that is about 44 pp; at n = 200 about 14 pp.
 *
 * Inverting: n ≥ ceil((Z_ALPHA + Z_POWER)² × 0.5 / MDE²)
 *
 * The gate and preflight both operate on the **per-prediction probe count**
 * (not total episodes): each prediction is scored only on its own synthetic
 * probes (`episode.targets === prediction.id`), so n is the number of such
 * probes per arm.  With the current cap of 2 probes per prediction the gate
 * will fire for nearly every run without --force; that is intentional and
 * honest.  See issue #2477 for configurable probe counts.
 *
 * All rates are in [0,1]; pp values use 0.10 = 10 percentage points.
 *
 * @module whatif/mde
 */

import type { Prediction, PredictionDirection } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * MDE threshold above which the preflight hard gate fires (default 20 pp).
 * Expressed as a proportion in [0,1].
 */
export const MDE_GATE_THRESHOLD = 0.20;

/** Minimum episode count below which a gate warning is printed regardless. */
const MIN_DISPLAY_N = 1;

/** z-score for alpha = 0.05, two-sided (97.5th percentile). */
export const Z_ALPHA = 1.96;

/** z-score for 80% power (84.16th percentile). */
export const Z_POWER = 0.8416;

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Compute the approximate MDE (proportion, not pp) for a given episode count
 * per arm, assuming worst-case variance (p = 0.5), a balanced design,
 * alpha = 0.05 (two-sided) and 80% power.
 *
 * Returns a value in [0, 1].  For n = 0 returns 1 (no information).
 * Clamped to 1 for very small n (where the formula would exceed 100%).
 *
 * Formula: MDE = (Z_ALPHA + Z_POWER) × sqrt(0.5 / n)
 *               ≈ 2.8016 × sqrt(0.5 / n)
 */
export function mdeForN(n: number): number {
  if (n <= 0) return 1;
  return Math.min(1, (Z_ALPHA + Z_POWER) * Math.sqrt(0.5 / n));
}

/**
 * Compute the minimum episode count per arm needed to detect `mde` (a
 * proportion in [0, 1]) with 80% power at alpha = 0.05 (two-sided).
 *
 * Formula: n ≥ ceil((Z_ALPHA + Z_POWER)² × 0.5 / mde²)
 */
export function nForMde(mde: number): number {
  if (mde <= 0) return Infinity;
  if (mde >= 1) return 1;
  return Math.ceil(((Z_ALPHA + Z_POWER) * (Z_ALPHA + Z_POWER) * 0.5) / (mde * mde));
}

// ---------------------------------------------------------------------------
// Human-readable helpers
// ---------------------------------------------------------------------------

function pp(proportion: number): string {
  return `${Math.round(proportion * 100)}pp`;
}

/** A rate (not a difference), e.g. a baseline P(yes): rendered as a percent. */
function pct(proportion: number): string {
  return `${Math.round(proportion * 100)}%`;
}

/**
 * One-line preflight summary: what the per-prediction probe count can detect
 * and how many probes per prediction would be needed to detect a given target.
 *
 * @param probesPerPrediction  Number of synthetic probe episodes per prediction
 *                             per arm.  This is the unit that actually drives
 *                             per-prediction power (each prediction is scored
 *                             only on its own probes).
 * @param targetMde            Target MDE for the "you need N probes" clause
 *                             (default 0.10 = 10 pp).
 */
export function mdePreflightLine(probesPerPrediction: number, targetMde = 0.10): string {
  const achieved = mdeForN(probesPerPrediction);
  const achievedPp = pp(achieved);
  const needed10 = nForMde(0.10);
  const needed20 = nForMde(0.20);
  const targetPp = pp(targetMde);
  const neededForTarget = nForMde(targetMde);
  if (probesPerPrediction < MIN_DISPLAY_N) {
    return `No episodes planned; cannot estimate MDE.`;
  }
  return (
    `${probesPerPrediction} probe${probesPerPrediction === 1 ? '' : 's'}/prediction can detect ` +
    `about ${achievedPp} shifts (80% power); ` +
    `to detect ${targetPp} you need about ${neededForTarget} probes/prediction ` +
    `(${needed10} for 10pp, ${needed20} for 20pp).`
  );
}

/**
 * One-line report limit: the achieved MDE for a prediction that actually ran.
 * Returns undefined when the MDE is ≤ 10 pp (no warning needed).
 *
 * @param n      Episode count for one arm (min of baseline/candidate is used
 *               by convention since both arms must have data).
 * @param label  Short label for the prediction, e.g. "p1".
 */
export function mdeLimitLine(n: number, label: string): string | undefined {
  const achieved = mdeForN(n);
  if (achieved <= 0.10) return undefined;
  return (
    `Prediction ${label}: with n=${n} probes/arm the run can detect shifts ` +
    `≥${pp(achieved)} (80% power, alpha=0.05); smaller effects are undetectable at this size.`
  );
}

/**
 * True when the planned run's MDE exceeds the named gate threshold.
 * This is the condition that triggers the hard gate in the verify flow.
 *
 * @param minProbesPerPrediction  The minimum probe count per prediction across
 *                                all predictions in the run.
 */
export function isUnderpowered(minProbesPerPrediction: number): boolean {
  return mdeForN(minProbesPerPrediction) > MDE_GATE_THRESHOLD;
}

/**
 * Message to show when a `--verify` run is blocked by the MDE gate.
 *
 * @param minProbesPerPrediction  The minimum probe count per prediction.
 */
export function mdeGateRefusedMessage(minProbesPerPrediction: number): string {
  const achieved = pp(mdeForN(minProbesPerPrediction));
  const needed = nForMde(MDE_GATE_THRESHOLD);
  return (
    `whatif: run is underpowered — ` +
    `${minProbesPerPrediction} probe${minProbesPerPrediction === 1 ? '' : 's'}/prediction can only detect ` +
    `≥${achieved} shifts (threshold: ${pp(MDE_GATE_THRESHOLD)}, 80% power). ` +
    `The limiting factor is probe count per prediction (currently capped; see issue #2477). ` +
    `To proceed, use --force or collect at least ${needed} probes/prediction.`
  );
}

// ---------------------------------------------------------------------------
// Headroom helpers (#2504)
// ---------------------------------------------------------------------------


/**
 * Compute the headroom in the predicted direction for a prediction.
 *
 * - For `added`/`strengthened`: headroom = 1 - baselineEstimate
 *   (room to increase from the baseline).
 * - For `removed`/`weakened`: headroom = baselineEstimate
 *   (room to decrease from the baseline).
 *
 * Returns `undefined` when `baselineEstimate` is not set (no check applied).
 */
export function headroomForPrediction(
  baselineEstimate: number | undefined,
  direction: PredictionDirection,
): number | undefined {
  if (baselineEstimate === undefined) return undefined;
  if (direction === 'added' || direction === 'strengthened') {
    return 1 - baselineEstimate;
  }
  return baselineEstimate;
}

/**
 * True when the prediction's baseline headroom is below the run's achieved
 * MDE, making it undetectable at the current probe count.
 *
 * @param prediction           The prediction to check.
 * @param probesPerPrediction  Number of synthetic probe episodes per prediction
 *                             per arm.
 */
export function isHeadroomUnderpowered(
  prediction: Prediction,
  probesPerPrediction: number,
): boolean {
  const headroom = headroomForPrediction(prediction.baselineEstimate, prediction.direction);
  if (headroom === undefined) return false;
  return headroom < mdeForN(probesPerPrediction);
}

/**
 * Preflight line describing a headroom violation for a single prediction.
 *
 * The parameter type is narrowed to require `baselineEstimate` because this
 * function is only meaningful when the estimate is present.  Callers must
 * check `isHeadroomUnderpowered` (which returns false when the estimate is
 * absent) before calling this function.
 *
 * @param prediction           The prediction whose headroom is insufficient;
 *                             must have a numeric `baselineEstimate`.
 * @param probesPerPrediction  Number of probes per prediction per arm.
 */
export function headroomPreflightLine(
  prediction: Prediction & { baselineEstimate: number },
  probesPerPrediction: number,
): string {
  const estimate = prediction.baselineEstimate;
  // Contract: headroomForPrediction returns undefined only when estimate is
  // undefined, which cannot happen given the narrowed parameter type.
  const headroom = headroomForPrediction(estimate, prediction.direction) ?? 0;
  const mde = mdeForN(probesPerPrediction);
  const dirLabel = prediction.direction === 'added' || prediction.direction === 'strengthened'
    ? 'increase'
    : 'decrease';
  return (
    `Prediction ${prediction.id} (${prediction.direction}): ` +
    `baseline estimate ${pct(estimate)}, leaving ${pp(headroom)} of headroom for an ${dirLabel}; ` +
    `this run can only detect shifts ≥${pp(mde)} — prediction is underpowered before the first episode runs.`
  );
}

/**
 * Post-hoc limit line for a prediction where the OBSERVED baseline rate left
 * less headroom in the predicted direction than the run's achieved MDE.
 *
 * Returns `undefined` when there is sufficient headroom or the MDE is small.
 *
 * @param observedBaseline     The measured baseline P(yes) for this prediction.
 * @param direction            The prediction's direction.
 * @param n                    Episodes per arm (min of baseline/candidate).
 * @param label                Short label, e.g. "p1".
 */
export function headroomLimitLine(
  observedBaseline: number,
  direction: PredictionDirection,
  n: number,
  label: string,
): string | undefined {
  // Contract: observedBaseline is typed number so headroomForPrediction always
  // returns a number here (it only returns undefined when the first arg is
  // undefined).  The nullish fallback is a defensive no-op.
  const headroom = headroomForPrediction(observedBaseline, direction) ?? 0;
  const mde = mdeForN(n);
  if (headroom >= mde) return undefined;
  const dirLabel = direction === 'added' || direction === 'strengthened' ? 'increase' : 'decrease';
  const baselinePct = pct(observedBaseline);
  return (
    `Prediction ${label}: baseline was ${baselinePct}, leaving ${pp(headroom)} of room for an ${dirLabel}; ` +
    `this run can only detect shifts ≥${pp(mde)}, so it could not confirm this prediction.`
  );
}
