/**
 * Minimum detectable effect (MDE) for a what-if verify run (issue #2410).
 *
 * Tells the operator, before paying and again in the report, how large a
 * rate shift the run can reliably detect. Without it, a run sized too small
 * comes back "unclear" on everything, even though that was the likely
 * outcome from the start.
 *
 * Definition: the smallest true difference between two proportions that a
 * two-sided test at alpha = 0.05 detects with 80% power, using equal arms of
 * `n` independent units and the worst-case variance (p = 0.5):
 *
 *   MDE = (z_{0.975} + z_{0.80}) * sqrt(2 * 0.25 / n)
 *
 * `n` is the number of EPISODES per arm, never episodes x samples: repeated
 * samples of one episode are correlated, so they do not add independent
 * evidence (see #2404). The figure is an approximation, not an exact power
 * analysis. It is meant to show the order of magnitude.
 *
 * @module whatif/mde
 */

import type { Prediction, VerifiedPrediction } from './types.js';

const Z_ALPHA = 1.959964; // two-sided alpha = 0.05
const Z_POWER = 0.841621; // power = 0.80
const WORST_CASE_VARIANCE = 0.25; // p(1 - p) at p = 0.5

/** MDEs above this are reported as a limit (issue #2410 acceptance). */
export const MDE_LIMIT_THRESHOLD = 0.1;

/**
 * Minimum detectable rate difference (0..1) for `nPerArm` episodes in each
 * arm. Returns 1 when there are no episodes, and never more than 1.
 */
export function minDetectableEffect(nPerArm: number): number {
  if (!Number.isFinite(nPerArm) || nPerArm <= 0) return 1;
  const mde = (Z_ALPHA + Z_POWER) * Math.sqrt((2 * WORST_CASE_VARIANCE) / nPerArm);
  return Math.min(1, mde);
}

/** Episodes per arm needed to detect a `target` rate difference (0..1). */
export function episodesForMde(target: number): number {
  if (!Number.isFinite(target) || target <= 0) return Infinity;
  return Math.ceil(2 * WORST_CASE_VARIANCE * ((Z_ALPHA + Z_POWER) / target) ** 2);
}

/** Percentage points, rounded, e.g. 0.443 -> 44. */
export function toPp(rate: number): number {
  return Math.round(rate * 100);
}

/**
 * The preflight line shown before any episode runs: the estimated cost, the
 * MDE for the planned episode count, and the MDE for the smallest set of
 * probes a single prediction is scored on.
 */
export function preflightMdeLine(input: {
  episodes: number;
  estimateUsd: number;
  predictions: Pick<Prediction, 'id' | 'probes'>[];
}): string {
  const { episodes, estimateUsd, predictions } = input;
  const parts = [
    `Estimated cost about $${estimateUsd.toFixed(2)}.`,
    `With ${episodes} episode(s) per arm, only shifts of about ${toPp(minDetectableEffect(episodes))}pp ` +
      `or more are reliably detectable; detecting a 10pp shift needs about ` +
      `${episodesForMde(MDE_LIMIT_THRESHOLD)} episodes per arm.`,
  ];
  const probeCounts = predictions.map((p) => p.probes.length).filter((n) => n > 0);
  if (probeCounts.length > 0) {
    const fewest = Math.min(...probeCounts);
    parts.push(
      `Each prediction is scored on its own probes only (as few as ${fewest}), ` +
        `so its detectable shift is about ${toPp(minDetectableEffect(fewest))}pp.`,
    );
  }
  return parts.join(' ');
}

/**
 * One Limits bullet per prediction whose achieved MDE is above 10pp, using
 * the episodes that actually got graded in both arms. Predictions without a
 * scope (results written before #2403), unobservable predictions, and
 * predictions with no graded episode in an arm are skipped: they already
 * carry their own explanation.
 */
export function mdeLimits(predictions: VerifiedPrediction[]): string[] {
  const out: string[] = [];
  for (const vp of predictions) {
    if (vp.verdict === 'unobservable' || !vp.scope) continue;
    const n = Math.min(vp.scope.episodes.baseline.length, vp.scope.episodes.candidate.length);
    if (n === 0) continue;
    const mde = minDetectableEffect(n);
    if (mde <= MDE_LIMIT_THRESHOLD) continue;
    out.push(
      `Prediction ${vp.prediction.id} was measured on ${n} episode(s) per arm, so only shifts of ` +
        `about ${toPp(mde)}pp or more were reliably detectable. Smaller real effects read as unclear.`,
    );
  }
  return out;
}
