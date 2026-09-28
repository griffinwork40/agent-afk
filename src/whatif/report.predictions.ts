/**
 * Verified prediction table rendering for the what-if report.
 *
 * Extracted from report.ts to stay within the 350-code-line ceiling.
 *
 * @module whatif/report.predictions
 */

import type { Prediction, VerifiedPrediction } from './types.js';
import { verdictEmoji, verdictLabel } from './report-verdict.js';

// ---------------------------------------------------------------------------
// Helpers (pct is re-declared here to avoid a circular import with report.ts)
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function ciStr(ci: [number, number]): string {
  return `[${pct(ci[0])}, ${pct(ci[1])}]`;
}

/**
 * "2 probes (n=6 eps, 18 samples)" — episodes are the unit of analysis
 * (#2404); sample count shown separately for transparency.
 */
export function scoredOn(vp: VerifiedPrediction): string {
  const nEps = `n=${vp.rates.n.baseline}/${vp.rates.n.candidate} eps`;
  if (!vp.scope) return nEps; // pre-#2403 result: pooled over every episode
  const eps = new Set([...vp.scope.episodes.baseline, ...vp.scope.episodes.candidate]).size;
  if (eps === 0) return `no graded probes (${vp.scope.targetedEpisodes} planned)`;
  const samplesNote = vp.scope.totalSamples !== undefined
    ? `, ${vp.scope.totalSamples} samples`
    : '';
  return `${eps} probe${eps === 1 ? '' : 's'}, ${nEps}${samplesNote}`;
}

function backgroundStr(vp: VerifiedPrediction): string {
  const bg = vp.scope?.background;
  if (!bg) return '—';
  return `${pct(bg.baseline)} → ${pct(bg.candidate)} (n=${bg.n.baseline}/${bg.n.candidate})`;
}

function episodeList(vp: VerifiedPrediction): string {
  const { baseline, candidate } = vp.scope!.episodes;
  if (baseline.length === 0 && candidate.length === 0) return 'none graded';
  if (baseline.join(',') === candidate.join(',')) return baseline.join(', ');
  return `baseline ${baseline.join(', ') || 'none'}; candidate ${candidate.join(', ') || 'none'}`;
}

/** Render per-prediction cross-check agreement cell (#2413). */
function crossCheckCell(vp: VerifiedPrediction): string {
  if (vp.crossCheckTooFew) return '⚠ too few cross-checks';
  if (vp.crossCheckAgreement !== undefined) {
    const flag = vp.crossCheckAgreement < 0.75 ? ' ⚠ low' : '';
    return `${pct(vp.crossCheckAgreement)}${flag}`;
  }
  return '—';
}

/**
 * Verified predictions table plus the per-prediction evidence list.
 *
 * Contract (#2403): Before / After / CI / Result come from the prediction's
 * own probes only. "Other episodes" is the same question on every other
 * episode, shown for context and never part of the verdict. `n` is graded
 * outputs per arm (episodes × samples that survived running and judging).
 */
export function renderVerifiedPredictionTable(
  predictions: Prediction[],
  verified: VerifiedPrediction[],
): string[] {
  const lines: string[] = [];
  const vpMap = new Map(verified.map((vp) => [vp.prediction.id, vp]));
  const hasCrossCheck = verified.some(
    (vp) => vp.crossCheckAgreement !== undefined || vp.crossCheckTooFew,
  );
  lines.push('> Before / After / CI / Result use only the probes written for each prediction. "Other episodes" is the same question on every other episode, for context; it does not affect the result.\n');
  if (hasCrossCheck) {
    lines.push('| # | Behavior | Direction | Before | After | CI | Scored on | Other episodes | Judge agree | Result |');
    lines.push('|---|----------|-----------|--------|-------|----|-----------|----------------|-------------|--------|');
  } else {
    lines.push('| # | Behavior | Direction | Before | After | CI | Scored on | Other episodes | Result |');
    lines.push('|---|----------|-----------|--------|-------|----|-----------|----------------|--------|');
  }
  for (const pred of predictions) {
    const vp = vpMap.get(pred.id);
    if (!vp) {
      if (hasCrossCheck) {
        lines.push(`| ${pred.id} | ${pred.behavior} | ${pred.direction} | — | — | — | — | — | — | ⚪ unclear |`);
      } else {
        lines.push(`| ${pred.id} | ${pred.behavior} | ${pred.direction} | — | — | — | — | — | ⚪ unclear |`);
      }
      continue;
    }
    const resultCell = `${verdictEmoji(vp.verdict)} ${verdictLabel(vp)}${vp.verdictReason ? ` (${vp.verdictReason})` : ''}`;
    if (hasCrossCheck) {
      lines.push(
        `| ${pred.id} | ${pred.behavior} | ${pred.direction} | ${pct(vp.rates.baseline)} | ${pct(vp.rates.candidate)} | ${ciStr(vp.rates.ci)} | ${scoredOn(vp)} | ${backgroundStr(vp)} | ${crossCheckCell(vp)} | ${resultCell} |`,
      );
    } else {
      lines.push(
        `| ${pred.id} | ${pred.behavior} | ${pred.direction} | ${pct(vp.rates.baseline)} | ${pct(vp.rates.candidate)} | ${ciStr(vp.rates.ci)} | ${scoredOn(vp)} | ${backgroundStr(vp)} | ${resultCell} |`,
      );
    }
  }
  const scoped = predictions.map((p) => vpMap.get(p.id)).filter((vp) => vp?.scope !== undefined);
  if (scoped.length > 0) {
    lines.push('', '**Episodes behind each result:**', '');
    for (const vp of scoped) lines.push(`- ${vp!.prediction.id}: ${episodeList(vp!)}`);
  }
  return lines;
}
