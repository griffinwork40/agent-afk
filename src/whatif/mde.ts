/**
 * Minimum Detectable Effect (MDE) helpers for the what-if verify pipeline.
 *
 * ## Convention
 *
 * We report the **resolution threshold**: the smallest absolute rate difference
 * that a two-proportion 95% CI can distinguish from zero, given n observations
 * per arm at the worst-case proportion (p = 0.5, which maximises variance).
 *
 * Formula (two-sided, z = 1.96):
 *
 *   mde(n) = 1.96 × sqrt(2 × 0.25 / n) = 1.96 × sqrt(0.5 / n)
 *
 * A shift smaller than the CI half-width cannot be distinguished from noise.
 * Equivalently: to detect a target shift `d`, you need at least
 *
 *   n = ceil(0.5 × (1.96 / d)²)
 *
 * episodes per arm.
 *
 * @module whatif/mde
 */

/** z-score for 95% two-sided CI. */
const Z95 = 1.96;

/**
 * Approximate minimum detectable effect (as a proportion, 0–1) for a
 * two-proportion 95% CI given `n` episodes per arm.
 *
 * Uses worst-case p = 0.5 (maximum variance).
 *
 * @param n  Episodes per arm (must be > 0; returns 1 for n ≤ 0).
 * @returns  MDE as a proportion in (0, 1].
 */
export function mde(n: number): number {
  if (n <= 0) return 1;
  return Z95 * Math.sqrt(0.5 / n);
}

/**
 * Minimum episodes per arm needed to detect a rate shift of `target`
 * (expressed as a proportion, e.g. 0.10 for 10 pp).
 *
 * @param target  Target MDE as a proportion (must be > 0; returns Infinity for target ≤ 0).
 * @returns       Minimum episode count (always a positive integer).
 */
export function nForMde(target: number): number {
  if (target <= 0) return Infinity;
  return Math.ceil(0.5 * (Z95 / target) ** 2);
}

/**
 * Format an MDE value as a percentage string, e.g. `"25pp"`.
 *
 * @param proportion  MDE as a proportion (0–1).
 */
export function formatMde(proportion: number): string {
  return `${Math.round(proportion * 100)}pp`;
}
