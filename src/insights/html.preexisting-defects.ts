/**
 * HTML section renderer for the "Most-acknowledged pre-existing defects"
 * section of the `afk insights` report.
 *
 * Extracted into its own file to keep html.ts under the 350-code-line ceiling.
 * Renders nothing (empty string) when the ledger is empty or absent.
 *
 * @module insights/html.preexisting-defects
 */

import type { InsightAggregates } from './types.js';
import { htmlEscape } from './html.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function safeNum(n: number | undefined | null, decimals = 0): string {
  if (n === undefined || n === null || isNaN(n) || !isFinite(n)) return '0';
  return n.toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the pre-existing-defect section of the insights HTML report.
 *
 * Returns an HTML `<section>` string, or an empty string when there is no
 * data (to avoid an empty heading with a "no data" placeholder cluttering
 * reports generated before the ledger accumulates entries).
 */
export function renderPreexistingDefects(agg: InsightAggregates): string {
  const pd = agg.preexistingDefects;
  if (!pd || pd.topClusters.length === 0) return '';

  const rows = pd.topClusters
    .map((c) => {
      const locus = htmlEscape(c.locus.length > 60 ? c.locus.slice(0, 57) + '...' : c.locus);
      const repo = htmlEscape(c.repo.length > 40 ? '...' + c.repo.slice(-37) : c.repo);
      const category = htmlEscape(c.category);
      const signal = htmlEscape(c.signal);
      const count = htmlEscape(safeNum(c.recurrenceCount));
      const last = htmlEscape(c.lastSeen ? c.lastSeen.slice(0, 10) : '—');
      const first = htmlEscape(c.firstSeen ? c.firstSeen.slice(0, 10) : '—');
      return `<tr>
        <td><code>${locus}</code></td>
        <td><code>${repo}</code></td>
        <td>${category}</td>
        <td>${signal}</td>
        <td style="text-align:right">${count}</td>
        <td>${first}</td>
        <td>${last}</td>
      </tr>`;
    })
    .join('\n');

  const truncationNotice = pd.ledgerTruncated
    ? `<p class="caption" style="color:#d29922">⚠ Ledger exceeded the 1 MB read cap — oldest records were discarded. ` +
      `Counts and rankings reflect only the most recent portion of the ledger.</p>`
    : '';

  const totalNote =
    pd.totalRecords > 0
      ? `<p class="caption">${htmlEscape(safeNum(pd.totalRecords))} total ledger records` +
        `${pd.ledgerTruncated ? ' (tail only — ledger truncated)' : ''}; ` +
        `${htmlEscape(safeNum(pd.skippedOutOfWindow))} outside the ${htmlEscape(safeNum(agg.windowDays))}-day window; ` +
        `showing top ${htmlEscape(safeNum(pd.topClusters.length))} clusters by recurrence count.</p>`
      : '';

  return `
  <section id="preexisting-defects">
    <h2>Most-Acknowledged Pre-existing Defects</h2>
    <p style="color:#8b949e;margin-bottom:12px">Defects the agent acknowledged as pre-existing across sessions, ranked by recurrence count.</p>
    <table class="data-table">
      <thead>
        <tr>
          <th>Locus</th>
          <th>Repo</th>
          <th>Category</th>
          <th>Signal</th>
          <th style="text-align:right">Sessions</th>
          <th>First Seen</th>
          <th>Last Seen</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    ${truncationNotice}
    ${totalNote}
  </section>`;
}
