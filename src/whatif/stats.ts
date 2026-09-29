/**
 * Statistical helpers for the what-if prediction engine.
 *
 * All functions are pure and deterministic — no I/O, no model calls.
 *
 * ## Statistical approach
 *
 * Inputs to {@link compareRates} are per-episode mean scores in [0,1].  With
 * the #2404 fix, each value represents the average of the samples taken for
 * that episode, so n = number of episodes (not episodes × samples).  A value
 * `p` at position i represents the average judge score for episode i in that
 * arm.
 *
 * The 95% confidence interval on the delta uses the **Newcombe hybrid score**
 * (Newcombe 1998, Method 10): Wilson score intervals on each proportion
 * independently, then combined as:
 *
 *   CI_lo = δ - sqrt((p̂_b - lo_b)² + (hi_c - p̂_c)²)
 *   CI_hi = δ + sqrt((hi_b - p̂_b)² + (p̂_c - lo_c)²)
 *
 * This is conservative relative to the normal approximation, handles p ≈ 0
 * and p ≈ 1 correctly, and is well-defined for fractional per-episode means.
 * See {@link compareRates} for notes on when this remains appropriate.
 *
 * @module whatif/stats
 */

import type { Prediction, RateComparison, VerifiedPrediction, Verdict } from './types.js';

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
 * Compare per-episode mean score arrays (values in [0,1]) between baseline
 * and candidate.  See module-level doc for statistical details.
 *
 * Contract (#2404): each element in `baseline` / `candidate` is the
 * average score for one episode (averaged across samples before this call).
 * n is the episode count, not episodes × samples.  Passing flat per-sample
 * arrays here violates the i.i.d. assumption when ICC > 0 and inflates n.
 *
 * The Newcombe CI is valid for fractional per-episode means (values between
 * 0 and 1) as long as n is interpreted as the number of unit-weight
 * observations (episodes), not as a raw Bernoulli n.  This is consistent
 * with the "fractional successes" convention in the original module doc.
 *
 * @param baseline   Array of per-episode mean scores for the baseline arm.
 * @param candidate  Array of per-episode mean scores for the candidate arm.
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
// Equivalence margin (#2405)
// ---------------------------------------------------------------------------

/**
 * Named equivalence margin for the `verdictFor` equivalence test (#2405).
 *
 * A prediction is `refuted` on the equivalence branch only when the **entire**
 * 95% CI lies inside [-EQUIVALENCE_MARGIN, +EQUIVALENCE_MARGIN], meaning the
 * data are inconsistent with any effect at least this large in magnitude.
 * This is a standard equivalence test (TOST-adjacent), not a "small delta AND
 * narrow CI" heuristic.
 */
export const EQUIVALENCE_MARGIN = 0.05;

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
 * 2. **refuted**   — CI excludes 0 in the OPPOSITE direction (wrong sign), OR
 *                    the entire CI lies within [-EQUIVALENCE_MARGIN, +EQUIVALENCE_MARGIN]
 *                    (equivalence test: data are inconsistent with any effect ≥5pp).
 * 3. **unclear**   — otherwise.
 *
 * Change from pre-#2405: the previous "refuted" branch required only
 * |delta| < 0.05 AND CI half-width < 0.15, which fires on any underpowered
 * run with n ≥ 22, without requiring the CI to actually exclude the
 * equivalence margin. The new rule requires the CI to lie entirely inside
 * [-0.05, +0.05] — a proper equivalence test.
 */
export function verdictFor(pred: Prediction, rates: RateComparison): Verdict {
  const { direction } = pred;
  const expectedPositive = direction === 'added' || direction === 'strengthened';
  const [ciLo, ciHi] = rates.ci;

  // CI excludes zero → the difference is statistically significant.
  const ciExcludesZeroPositive = ciLo > 0;
  const ciExcludesZeroNegative = ciHi < 0;

  // Equivalence test (#2405): entire CI inside [-margin, +margin].
  const ciInsideEquivalenceMargin =
    ciLo >= -EQUIVALENCE_MARGIN && ciHi <= EQUIVALENCE_MARGIN;

  if (expectedPositive) {
    if (ciExcludesZeroPositive) return 'confirmed';
    if (ciExcludesZeroNegative || ciInsideEquivalenceMargin) return 'refuted';
  } else {
    if (ciExcludesZeroNegative) return 'confirmed';
    if (ciExcludesZeroPositive || ciInsideEquivalenceMargin) return 'refuted';
  }

  return 'unclear';
}

// ---------------------------------------------------------------------------
// predictionAccuracy
// ---------------------------------------------------------------------------

/**
 * Fraction of non-unclear verdicts that are confirmed.
 *
 * `unobservable` verdicts are excluded from both the numerator and denominator
 * (they are neither confirmed nor refuted — behavior was past the episode
 * boundary and cannot be scored).
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
// Cross-check agreement thresholds (#2413)
// ---------------------------------------------------------------------------

/**
 * Minimum per-prediction cross-check agreement to consider a decisive verdict
 * trustworthy (#2413). When a prediction's agreement is below this threshold
 * AND at least {@link CROSS_CHECK_MIN_ITEMS} items were cross-checked, the
 * verdict is downgraded from confirmed/refuted to unclear with reason
 * 'judges disagree'. Does not affect `unobservable`.
 */
export const CROSS_CHECK_MIN_AGREEMENT = 0.75;

/**
 * Minimum number of cross-checked items required for the agreement rate to
 * influence a prediction's verdict (#2413). Below this count the agreement
 * rate is treated as unknown: the verdict is unchanged, but
 * `VerifiedPrediction.crossCheckTooFew` is set to `true`.
 */
export const CROSS_CHECK_MIN_ITEMS = 5;

// ---------------------------------------------------------------------------
// applyAgreementDowngrade (#2413)
// ---------------------------------------------------------------------------

/**
 * Apply the per-prediction cross-check agreement downgrade rule (#2413).
 *
 * Given a `VerifiedPrediction` and the paired primary/cross-check scores for
 * that prediction's question, returns a new `VerifiedPrediction` with:
 *
 * - `crossCheckAgreement` set when `crossPairs.length >= CROSS_CHECK_MIN_ITEMS`.
 * - `crossCheckTooFew` set when pairs exist but below the minimum count.
 * - `verdict` downgraded to `'unclear'` and `verdictReason` set to
 *   `'judges disagree'` when agreement < CROSS_CHECK_MIN_AGREEMENT and pairs
 *   >= CROSS_CHECK_MIN_ITEMS and the original verdict is confirmed or refuted.
 * - `unobservable` verdicts are never touched.
 *
 * When `mainScores` and `crossScores` are both empty (no cross-check judge),
 * the prediction is returned unchanged.
 */
export function applyAgreementDowngrade(
  vp: VerifiedPrediction,
  mainScores: number[],
  crossScores: number[],
): VerifiedPrediction {
  const len = Math.min(mainScores.length, crossScores.length);
  if (len === 0) return vp;

  const agreement = agreementRate(mainScores, crossScores);
  const tooFew = len < CROSS_CHECK_MIN_ITEMS;

  if (tooFew) {
    return { ...vp, crossCheckTooFew: true };
  }

  const base: VerifiedPrediction = { ...vp, crossCheckAgreement: agreement };
  if (
    vp.verdict !== 'unobservable' &&
    (vp.verdict === 'confirmed' || vp.verdict === 'refuted') &&
    agreement < CROSS_CHECK_MIN_AGREEMENT
  ) {
    return { ...base, verdict: 'unclear', verdictReason: 'judges disagree' };
  }
  return base;
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
