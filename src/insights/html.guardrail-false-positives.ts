/**
 * HTML section renderer for guardrail false-positive metrics (#3849).
 *
 * Extracted as a sibling of `html.ts` to respect the 350-code-line ceiling.
 * Renders a small metrics section showing hook-block-repeat trip counts and
 * the false-positive rate. Returns an empty string when no trips are recorded
 * (avoids an empty heading cluttering reports before any guard fires).
 *
 * @module insights/html.guardrail-false-positives
 */

import type { InsightAggregates } from './types.js';

// ---------------------------------------------------------------------------
// Helpers (intentionally inlined — importing from html.ts would create a
// circular dep risk and these are trivial)
// ---------------------------------------------------------------------------

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeNum(n: number | undefined | null, decimals = 0): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0';
  return n.toFixed(decimals);
}

function formatPct(fraction: number | null | undefined): string {
  if (fraction === undefined || fraction === null || !Number.isFinite(fraction)) return 'N/A';
  return `${safeNum(fraction * 100, 1)}%`;
}

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
