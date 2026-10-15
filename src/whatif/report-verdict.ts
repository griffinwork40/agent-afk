/**
 * Verdict rendering helpers for the what-if report.
 *
 * Extracted from `report.ts` to keep that file within the 350-line limit and
 * to allow reuse across Markdown and terminal renderers.
 *
 * @module whatif/report-verdict
 */

import { EQUIVALENCE_MARGIN } from './stats.js';
import type { Verdict, VerifiedPrediction } from './types.js';

/**
 * Emoji for a verdict.
 *
 * - ✅ confirmed
 * - ❌ refuted
 * - 🔭 unobservable
 * - ⚪ unclear
 */
export function verdictEmoji(v: Verdict): string {
  if (v === 'confirmed') return '✅';
  if (v === 'refuted') return '❌';
  if (v === 'unobservable') return '🔭';
  return '⚪';
}

/**
 * Verdict text for a row.
 *
 * - `unobservable`: appends the one-line reason.
 * - `refuted` via equivalence (CI inside ±EQUIVALENCE_MARGIN): shows
 *   "no effect detected (within ±Xpp)" so readers can distinguish "wrong
 *   direction" from "too small to matter" (#2405).
 * - All other verdicts: the bare verdict string.
 */
export function verdictLabel(
  vp: Pick<VerifiedPrediction, 'verdict' | 'unobservableReason' | 'rates'>,
): string {
  if (vp.verdict === 'unobservable' && vp.unobservableReason) {
    return `unobservable — ${vp.unobservableReason}`;
  }
  if (vp.verdict === 'refuted') {
    const [ciLo, ciHi] = vp.rates.ci;
    const isEquivalence = ciLo >= -EQUIVALENCE_MARGIN && ciHi <= EQUIVALENCE_MARGIN;
    if (isEquivalence) {
      const marginPp = Math.round(EQUIVALENCE_MARGIN * 100);
      return `no effect detected (within ±${marginPp}pp)`;
    }
  }
  return vp.verdict;
}
