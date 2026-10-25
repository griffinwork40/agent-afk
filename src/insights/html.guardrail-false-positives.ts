/**
 * HTML section renderers for guardrail false-positive metrics (#3849).
 *
 * Extracted as a sibling of `html.ts` to respect the 350-code-line ceiling.
 * Renders metrics sections for:
 *   - hook-block-repeat trip counts and FP rate
 *   - shadow-git-detect observe-window firing counts
 *
 * Each renderer returns an empty string when there is no data (avoids empty
 * headings cluttering reports before any guard fires).
 *
 * @module insights/html.guardrail-false-positives
 */

import type { InsightAggregates } from './types.js';
import { htmlEscape, safeNum, formatPct } from './html.helpers.js';

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render the guardrail false-positive metrics section.
 * Returns empty string when there are no trips (nothing to show).
 */
export function renderGuardrailFalsePositives(agg: InsightAggregates): string {
  const gfp = agg.guardrailFalsePositives;
  if (!gfp || gfp.totalTrips === 0) return '';

  return `
  <section id="guardrail-false-positives">
    <h2>Guardrail False Positives</h2>
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(gfp.totalTrips))}</div><div class="metric-label">Total Trips</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(gfp.falsePositiveTrips))}</div><div class="metric-label">False Positive Trips</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(formatPct(gfp.falsePositiveRate))}</div><div class="metric-label">FP Rate</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(gfp.totalPreToolUseBlocks))}</div><div class="metric-label">Total PreToolUse Blocks</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(gfp.sessionsWithTrips))}</div><div class="metric-label">Sessions with Trips</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(gfp.sessionsScanned))}</div><div class="metric-label">Sessions Scanned</div></div>
    </div>
    <p class="caption">Hook-block-repeat meta-guard — a high FP rate suggests the threshold may be too aggressive.</p>
  </section>`;
}

/**
 * Render the shadow-git-detect observe-window metrics section.
 * Returns empty string when there are no firings (nothing to show).
 */
export function renderShadowGitObserve(agg: InsightAggregates): string {
  const sgo = agg.shadowGitObserve;
  if (!sgo || sgo.totalFirings === 0) return '';

  const labelRows = Object.entries(sgo.byLabel)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) =>
      `<tr><td>${htmlEscape(label)}</td><td>${htmlEscape(safeNum(count))}</td></tr>`,
    )
    .join('');

  const labelTable = labelRows
    ? `<table class="data-table"><thead><tr><th>Pattern</th><th>Count</th></tr></thead><tbody>${labelRows}</tbody></table>`
    : '';

  return `
  <section id="shadow-git-observe">
    <h2>Shadow-Git Detect (Observe Window)</h2>
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(sgo.totalFirings))}</div><div class="metric-label">Total Firings</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(sgo.forkFirings))}</div><div class="metric-label">Fork Firings</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(sgo.sessionsWithFirings))}</div><div class="metric-label">Sessions with Firings</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(sgo.sessionsScanned))}</div><div class="metric-label">Sessions Scanned</div></div>
    </div>
    ${labelTable}
    <p class="caption">Shadow-git-detect fires in observe-only mode — counts here inform the NEEDS-DECISION on promotion to block (#3849).</p>
  </section>`;
}
