/**
 * Markdown rendering for the paired per-probe sign-flip section (#2477 step 3).
 *
 * Extracted from report.ts to stay within the 350-code-line ceiling.
 *
 * @module whatif/report.signflip
 */

import { ZERO_TOLERANCE } from './probe-signflip.js';
import type { VerifiedPrediction } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a p-value for display. Two decimal places for p ≥ 0.01; three for
 * smaller values. Always shown as a decimal (not scientific notation).
 */
export function fmtP(p: number): string {
  if (p >= 0.01) return p.toFixed(2);
  return p.toFixed(3);
}

// ---------------------------------------------------------------------------
// renderProbeSignFlipSection
// ---------------------------------------------------------------------------

/**
 * Render the per-prediction paired sign-flip analysis as a secondary Markdown
 * section.
 *
 * This section is clearly labelled "secondary" to distinguish it from the
 * headline Newcombe-interval verdict. Non-technical readers see it too, so
 * plain language is used throughout.
 *
 * Returns an empty array when no prediction has a probeSignFlip result.
 */
export function renderProbeSignFlipSection(verified: VerifiedPrediction[]): string[] {
  const withSignFlip = verified.filter((vp) => vp.probeSignFlip !== undefined);
  if (withSignFlip.length === 0) return [];

  const lines: string[] = [];
  lines.push('## Per-Probe Paired Analysis (Secondary)\n');
  lines.push(
    '> **Secondary analysis — does not change the verdict above.** For each prediction, ' +
    'this pairs the same probe in both environments and tests whether the per-probe differences ' +
    'are consistently positive or negative. It is less sensitive than the Newcombe interval at ' +
    'small probe counts but uses pairing to reduce noise when probes vary. ' +
    `Zero tolerance: differences with |d| ≤ ${ZERO_TOLERANCE.toExponential()} are treated as ties and excluded from the sign-flip test. ` +
    'Unpaired probes (all runs failed in one arm) are listed but excluded — dropping them biases toward no change.\n',
  );

  for (const vp of withSignFlip) {
    const sf = vp.probeSignFlip!;
    const predId = vp.prediction.id;
    lines.push(`### ${predId}: ${vp.prediction.behavior}\n`);

    if (sf.nPaired === 0) {
      lines.push(`No paired probes (${sf.nUnpaired} unpaired). Sign-flip test not run.\n`);
      continue;
    }

    lines.push(
      `**Paired probes:** ${sf.nPaired}  ·  ` +
      `**Unpaired (one arm only):** ${sf.nUnpaired}  ·  ` +
      `**Nonzero differences (enter test):** ${sf.nNonzero}  ·  ` +
      `**Mean paired delta:** ${sf.meanDelta >= 0 ? '+' : ''}${(sf.meanDelta * 100).toFixed(1)}pp\n`,
    );

    const diffStr = sf.probeDiffs.map((d) => `${d >= 0 ? '+' : ''}${d.toFixed(2)}`).join(', ');
    lines.push(`**Per-probe differences** (candidate − baseline): [${diffStr}]\n`);

    if (sf.nNonzero === 0) {
      lines.push(
        '**Sign-flip test:** All paired differences are zero — no directional evidence. ' +
        'The test returns p = 1.0 by convention (every sign assignment is equally extreme).\n',
      );
    } else {
      const methodNote =
        sf.method === 'exact'
          ? `exact enumeration of all 2^${sf.nNonzero} = ${Math.pow(2, sf.nNonzero)} sign assignments`
          : `Monte Carlo with 100,000 draws (k=${sf.nNonzero} > 16; seed derived from sorted |d_i|)`;

      lines.push(`**Sign-flip p-value:** ${fmtP(sf.p!)}  (${methodNote}, two-sided)\n`);

      if (sf.minAchievableP !== null) {
        lines.push(
          `**Minimum achievable p** with ${sf.nNonzero} nonzero probes: ` +
          `${fmtP(sf.minAchievableP)} (= 2 / 2^${sf.nNonzero} = 2/${Math.pow(2, sf.nNonzero)})`,
        );
        if (sf.underpoweredForSig) {
          lines.push(
            `  → **Cannot reach p < 0.05 at this probe count** (${sf.nNonzero} nonzero probes). ` +
            'More probes with nonzero differences are needed for significance.',
          );
        }
        lines.push('');
      }

      if (sf.nUnpaired > 0) {
        lines.push(
          `> ⚠ ${sf.nUnpaired} probe${sf.nUnpaired === 1 ? '' : 's'} were present in only one arm ` +
          '(all runs in the other arm failed or were not run). Excluding them biases toward no change. ' +
          'See the arm-imbalance flag in the run report.\n',
        );
      }
    }
  }

  return lines;
}
