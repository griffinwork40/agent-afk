/**
 * Headline builder for the what-if report.
 *
 * Extracted from `report.ts` to keep that module under the 350-line ceiling.
 * Re-exported from `report.ts` so callers' imports remain unchanged.
 *
 * @module whatif/report.headline
 */

import type { Prediction, VerifiedPrediction, WhatifReport } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a rate as a rounded percentage string. */
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * Choose an adverb based on |delta|.
 *   < 0.10  → "slightly "
 *   0.10–0.25 → "" (no adverb)
 *   > 0.25  → "much "
 */
function adverb(absDelta: number): string {
  if (absDelta < 0.10) return 'slightly ';
  if (absDelta > 0.25) return 'much ';
  return '';
}

/** Returns true when the confidence interval excludes zero (significant result). */
function ciSignificant(ci: [number, number]): boolean {
  return ci[0] > 0 || ci[1] < 0;
}

// ---------------------------------------------------------------------------
// buildHeadline
// ---------------------------------------------------------------------------

/**
 * Build a single plain-English sentence summarising the report.
 *
 * For predict-only runs it describes the top prediction (if any).
 * For verified runs it picks the largest significant shift (CI excludes zero).
 * If no shift is significant, emits a "no clear difference" message.
 * Prediction accuracy uses the full `total` count, naming each verdict bucket.
 * Unobservable predictions are counted but never picked as the headline shift.
 */
export function buildHeadline(report: Omit<WhatifReport, 'headline'>): string {
  const { predictions, verify } = report;

  if (!verify) {
    // Predict-only branch — unchanged.
    const first = predictions[0];
    if (!first) return 'No behavioral changes predicted.';
    return `Predicted (not yet measured): ${first.behavior} is expected to be ${first.direction} (${first.confidence} confidence).`;
  }

  // Verified run.
  const { predictions: verified, features } = verify;

  // Find the largest *significant* |delta| across verified predictions and features.
  let bestLabel = '';
  let bestDelta = 0;
  let bestBefore = 0;
  let bestAfter = 0;

  // Also track the largest *non-significant* delta for the fallback note.
  let fallbackLabel = '';
  let fallbackDelta = 0;
  let fallbackBefore = 0;
  let fallbackAfter = 0;

  for (const vp of verified) {
    // An unobservable prediction's rates measure a behavior the episode gate
    // stopped in both arms (#2409); never headline them as an effect.
    if (vp.verdict === 'unobservable') continue;
    const d = Math.abs(vp.rates.delta);
    if (ciSignificant(vp.rates.ci)) {
      if (d > bestDelta) {
        bestDelta = d;
        bestLabel = (vp.prediction as Prediction).behavior;
        bestBefore = vp.rates.baseline;
        bestAfter = vp.rates.candidate;
      }
    } else {
      if (d > fallbackDelta) {
        fallbackDelta = d;
        fallbackLabel = (vp.prediction as Prediction).behavior;
        fallbackBefore = vp.rates.baseline;
        fallbackAfter = vp.rates.candidate;
      }
    }
  }

  for (const feat of features) {
    const d = Math.abs(feat.rates.delta);
    if (ciSignificant(feat.rates.ci)) {
      if (d > bestDelta) {
        bestDelta = d;
        bestLabel = feat.label.toLowerCase();
        bestBefore = feat.rates.baseline;
        bestAfter = feat.rates.candidate;
      }
    } else {
      if (d > fallbackDelta) {
        fallbackDelta = d;
        fallbackLabel = feat.label.toLowerCase();
        fallbackBefore = feat.rates.baseline;
        fallbackAfter = feat.rates.candidate;
      }
    }
  }

  // Build accuracy string using full verdicts breakdown.
  const accStr = buildAccuracyStr(verified);

  if (!bestLabel) {
    // No significant shift found — emit "no clear difference" with optional note.
    const fallbackNote =
      fallbackLabel
        ? `; largest observed shift: ${fallbackLabel} (${pct(fallbackBefore)} → ${pct(fallbackAfter)}), not significant`
        : '';
    return `No clear behavioral difference detected${fallbackNote}${accStr}.`;
  }

  const direction = bestAfter > bestBefore ? 'more' : 'less';
  const adv = adverb(bestDelta);
  return `Likely effect: ${bestLabel} ${adv}${direction} often (${pct(bestBefore)} → ${pct(bestAfter)})${accStr}.`;
}

// ---------------------------------------------------------------------------
// Accuracy summary helper
// ---------------------------------------------------------------------------

/**
 * Build the accuracy substring: "; N confirmed, M refuted, K unclear (of T predictions)".
 * Emitted whenever the verify run has any predictions, including when every
 * verdict is `unclear` (where `predictionAccuracy` is undefined), so unclear
 * predictions are never hidden from the headline (#2406). Unobservable
 * predictions (#2409) get their own bucket, named only when present:
 * "…, 1 unobservable (of 5 predictions)", so the buckets always sum to T.
 */
function buildAccuracyStr(verified: ReadonlyArray<VerifiedPrediction>): string {
  if (verified.length === 0) return '';

  const confirmed = verified.filter((vp) => vp.verdict === 'confirmed').length;
  const refuted = verified.filter((vp) => vp.verdict === 'refuted').length;
  const unclear = verified.filter((vp) => vp.verdict === 'unclear').length;
  const unobservable = verified.filter((vp) => vp.verdict === 'unobservable').length;
  const total = verified.length;
  const unobsStr = unobservable > 0 ? `, ${unobservable} unobservable` : '';

  return `; ${confirmed} confirmed, ${refuted} refuted, ${unclear} unclear${unobsStr} (of ${total} predictions)`;
}
