/**
 * Outcomes section renderer for the AFK insights HTML report.
 *
 * Extracted from html.ts to keep that file under the 350-code-line ceiling.
 * Renders per-ISO-week outcome KPI counts (good-proven, good-presumed, bad,
 * blocked, unknown) from the OutcomeAggregates slice of InsightAggregates.
 *
 * @module insights/html.outcomes
 */

import type { InsightAggregates } from './types.js';
import { htmlEscape } from './html.js';

// ---------------------------------------------------------------------------
// Private helpers (duplicated from html.ts to avoid circular import)
// ---------------------------------------------------------------------------

function safeNum(n: number | undefined | null, decimals = 0): string {
  if (n === undefined || n === null || isNaN(n) || !isFinite(n)) return '0';
  return n.toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the outcomes section of the insights HTML report.
 * Returns an HTML <section> string. All dynamic values are HTML-escaped.
 */
export function renderOutcomes(agg: InsightAggregates): string {
  const o = agg.outcomes;
  if (o.totalRecords === 0) {
    return `
  <section id="outcomes">
    <h2>Outcomes</h2>
    <p class="no-data">No settled outcome records in window.</p>
  </section>`;
  }

  const weeks = Object.keys(o.byWeek).sort();
  const rows = weeks.map((wk) => {
    const b = o.byWeek[wk];
    if (!b) return '';
    const goodTotal = b.goodProven + b.goodPressumed;
    return `<tr>
      <td>${htmlEscape(wk)}</td>
      <td>${safeNum(b.goodProven)}</td>
      <td>${safeNum(b.goodPressumed)}</td>
      <td>${safeNum(goodTotal)}</td>
      <td>${safeNum(b.bad)}</td>
      <td>${safeNum(b.blocked)}</td>
      <td>${safeNum(b.unknown)}</td>
    </tr>`;
  }).join('\n');

  return `
  <section id="outcomes">
    <h2>Outcomes</h2>
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-val">${safeNum(o.totalRecords)}</div><div class="metric-label">settled records</div></div>
    </div>
    <table class="data-table">
      <thead><tr>
        <th>Week</th><th>Good (proven)</th><th>Good (presumed)</th>
        <th>Good (total)</th><th>Bad</th><th>Blocked</th><th>Unknown</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="caption">Good proven = strong evidence (verified, PR merged). Good presumed = no bad signals past settle window. Bad = failed + interrupted.</p>
  </section>`;
}
