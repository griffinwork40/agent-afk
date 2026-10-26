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
import { htmlEscape, safeNum } from './html.helpers.js';

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

  // Invariant: absence of pd means no ledger data at all — render nothing.
  // A truncated ledger with no surviving clusters still warrants a warning so
  // the operator knows the report is incomplete; handle that path separately
  // before the cluster-table guard.
  if (!pd) return '';

  const truncationNotice = pd.ledgerTruncated
    ? `<p class="caption" style="color:#e3b341">⚠️ Ledger was truncated — only the most-recent entries were read. Displayed clusters may not reflect the full history.</p>`
    : '';

  // When the ledger was truncated but no clusters survived (e.g. all records
  // were outside the time window), render just the truncation warning so the
  // operator knows the report is incomplete, rather than silently returning ''.
  if (pd.topClusters.length === 0) {
    if (!truncationNotice) return '';
    return `
  <section id="preexisting-defects">
    <h2>Most-Acknowledged Pre-existing Defects</h2>
    ${truncationNotice}
  </section>`;
  }

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

  const totalNote =
    pd.totalRecords > 0
      ? `<p class="caption">${htmlEscape(safeNum(pd.totalRecords))} total ledger records` +
        `${pd.ledgerTruncated ? ' (tail only — ledger truncated)' : ''}; ` +
        `${htmlEscape(safeNum(pd.skippedOutOfWindow))} outside the ${htmlEscape(safeNum(agg.windowDays))}-day window; ` +
        `showing top ${htmlEscape(safeNum(pd.topClusters.length))} clusters by recurrence count.</p>`
      : '';

  // Invariant: truncationNotice (built above) appears BEFORE the table so it
  // is visible without scrolling past the data; PR body described it as "above
  // the table" and the DOM order must match that description.
  return `
  <section id="preexisting-defects">
    <h2>Most-Acknowledged Pre-existing Defects</h2>
    <p style="color:#8b949e;margin-bottom:12px">Defects the agent acknowledged as pre-existing across sessions, ranked by recurrence count.</p>
    ${truncationNotice}
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
    ${totalNote}
  </section>`;
}
