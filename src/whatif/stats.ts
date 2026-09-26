/**
 * Statistical helpers for the what-if prediction engine.
 *
 * All functions are pure and deterministic — no I/O, no model calls.
 *
 * ## Statistical approach
 *
 * Inputs to {@link compareRates} are per-output values in [0,1].  They are
 * treated as fractional successes: a value `p` at position i represents
 * `p * 1` successes out of `1` trial at that position, so mean(values) is
 * the overall rate and n = values.length is the effective trial count.  This
 * lets calibrated judge probabilities (e.g. 0.73) participate in the same
 * interval arithmetic as hard 0/1 indicators.
 *
 * The 95% confidence interval on the delta uses the **Newcombe hybrid score**
 * (Newcombe 1998, Method 10): Wilson score intervals on each proportion
 * independently, then combined as:
 *
 *   CI_lo = δ - sqrt((p̂_b - lo_b)² + (hi_c - p̂_c)²)
 *   CI_hi = δ + sqrt((hi_b - p̂_b)² + (p̂_c - lo_c)²)
 *
 * This is conservative relative to the normal approximation, handles p ≈ 0
 * and p ≈ 1 correctly, and requires no distributional assumptions beyond i.i.d
 * Bernoulli observations.
 *
 * @module whatif/stats
 */

import type { Prediction, RateComparison, Verdict } from './types.js';

// ---------------------------------------------------------------------------
// Wilson score interval
// ---------------------------------------------------------------------------

/**
 * Wilson score confidence interval for a proportion.
 *
 * @param successes  Number of successes (may be fractional for P(yes) inputs).
 * @param n          Total trials.
 * @param z          z-score for desired coverage (default 1.96 → 95%).
 * @returns          [lo, hi] clamped to [0, 1].
 */
function wilsonInterval(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const halfWidth = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lo = Math.max(0, centre - halfWidth);
  const hi = Math.min(1, centre + halfWidth);
  return [lo, hi];
}

// ---------------------------------------------------------------------------
// compareRates
// ---------------------------------------------------------------------------

/**
 * Compare per-output rate arrays (values in [0,1]) between baseline and
 * candidate.  See module-level doc for statistical details.
 *
 * @param baseline   Array of per-output values for the baseline condition.
 * @param candidate  Array of per-output values for the candidate condition.
 */
export function compareRates(
  baseline: number[],
  candidate: number[],
): RateComparison {
  const nb = baseline.length;
  const nc = candidate.length;

  const sumB = baseline.reduce((s, v) => s + v, 0);
  const sumC = candidate.reduce((s, v) => s + v, 0);

  const rateB = nb === 0 ? 0 : sumB / nb;
  const rateC = nc === 0 ? 0 : sumC / nc;
  const delta = rateC - rateB;

  // Newcombe hybrid score CI on the delta.
  const [loB, hiB] = wilsonInterval(sumB, nb);
  const [loC, hiC] = wilsonInterval(sumC, nc);

  const ciLo = delta - Math.sqrt((rateB - loB) ** 2 + (hiC - rateC) ** 2);
  const ciHi = delta + Math.sqrt((hiB - rateB) ** 2 + (rateC - loC) ** 2);

  return {
    baseline: rateB,
    candidate: rateC,
    delta,
    ci: [Math.max(-1, ciLo), Math.min(1, ciHi)],
    n: { baseline: nb, candidate: nc },
  };
}

// ---------------------------------------------------------------------------
// verdictFor
// ---------------------------------------------------------------------------

/**
 * Determine whether a prediction is confirmed, refuted, or unclear.
 *
 * Expected-sign convention:
 *   - `added` | `strengthened`  → expected delta > 0 (candidate rate higher).
 *   - `removed` | `weakened`    → expected delta < 0 (candidate rate lower).
 *
 * Rules (in order):
 * 1. **confirmed** — CI excludes 0 in the expected direction.
 * 2. **refuted**   — CI excludes 0 in the OPPOSITE direction, OR
 *                    (|delta| < 0.05 AND CI half-width < 0.15).
 * 3. **unclear**   — otherwise.
 */
export function verdictFor(pred: Prediction, rates: RateComparison): Verdict {
  const { direction } = pred;
  const expectedPositive = direction === 'added' || direction === 'strengthened';
  const [ciLo, ciHi] = rates.ci;
  const delta = rates.delta;

  const halfWidth = (ciHi - ciLo) / 2;

  // CI excludes zero → the difference is statistically significant.
  const ciExcludesZeroPositive = ciLo > 0;
  const ciExcludesZeroNegative = ciHi < 0;

  if (expectedPositive) {
    if (ciExcludesZeroPositive) return 'confirmed';
    if (ciExcludesZeroNegative || (Math.abs(delta) < 0.05 && halfWidth < 0.15)) {
      return 'refuted';
    }
  } else {
    if (ciExcludesZeroNegative) return 'confirmed';
    if (ciExcludesZeroPositive || (Math.abs(delta) < 0.05 && halfWidth < 0.15)) {
      return 'refuted';
    }
  }

  return 'unclear';
}

// ---------------------------------------------------------------------------
// predictionAccuracy
// ---------------------------------------------------------------------------

/**
 * Fraction of non-unclear verdicts that are confirmed.
 *
 * @returns `undefined` when there are no resolved (confirmed + refuted) verdicts.
 */
export function predictionAccuracy(
  verified: ReadonlyArray<{ verdict: Verdict }>,
): number | undefined {
  const confirmed = verified.filter((v) => v.verdict === 'confirmed').length;
  const refuted = verified.filter((v) => v.verdict === 'refuted').length;
  const total = confirmed + refuted;
  if (total === 0) return undefined;
  return confirmed / total;
}

// ---------------------------------------------------------------------------
// agreementRate
// ---------------------------------------------------------------------------

/**
 * Fraction of paired values that fall on the same side of 0.5.
 *
 * Treats values === 0.5 as the boundary — both values at exactly 0.5 agree
 * (both "uncertain"), one above and one below disagree.
 *
 * @param a  First array of values in [0, 1].
 * @param b  Second array of values in [0, 1] (same length as a; extra entries ignored).
 * @returns  Agreement rate in [0, 1]; 1.0 for an empty pair list.
 */
export function agreementRate(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 1;
  let agree = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    const aHigh = ai >= 0.5;
    const bHigh = bi >= 0.5;
    if (aHigh === bHigh) agree++;
  }
  return agree / len;
}
