/**
 * CLI subcommand: `afk defects`
 *
 * Reads the pre-existing-defect ledger and surfaces the top recurring
 * defects to the terminal — the read-path companion to the write-only
 * session-end hook.
 *
 * Usage:
 *   afk defects           — show top recurring defects (default: top 10, last 90 days)
 *   afk defects --top 20  — expand the listing
 *   afk defects --days 30 — narrow the time window
 *   afk defects --json    — emit raw JSON (for scripting)
 *
 * @module cli/commands/defects
 */

import { Command } from 'commander';
import { handleCommandError } from '../errors/index.js';
import { palette } from '../palette.js';
import { readLedgerRecords, clusterLedgerRecords } from '../../agent/preexisting-ledger/reader.js';
import { getPreexistingLedgerPath } from '../../agent/preexisting-ledger/paths.js';
import type { DefectCluster } from '../../agent/preexisting-ledger/reader.js';

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** Pad a string to a given width (truncate with … if longer). */
function col(s: string, width: number): string {
  if (s.length > width) return s.slice(0, width - 1) + '…';
  return s.padEnd(width);
}

/** Format an ISO timestamp as YYYY-MM-DD. */
function dateOnly(iso: string): string {
  return iso ? iso.slice(0, 10) : '—';
}

/** Abbreviate a repo path to its last two components for readability. */
function shortRepo(repo: string): string {
  const parts = repo.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || repo;
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

const LOCUS_W = 42;
const REPO_W  = 22;
const CAT_W   = 12;
const CNT_W   =  8; // "Sessions" is 8 chars
const DATE_W  = 10;

function renderTable(clusters: DefectCluster[], days: number): string {
  if (clusters.length === 0) {
    return (
      palette.meta('No pre-existing defect records in the last ') +
      palette.meta(String(days)) +
      palette.meta(' days.') +
      '\n' +
      palette.dim('Run `afk chat` sessions to accumulate data, or check ') +
      palette.dim(getPreexistingLedgerPath()) +
      '\n'
    );
  }

  const header =
    palette.heading(col('Locus', LOCUS_W)) + '  ' +
    palette.heading(col('Repo', REPO_W))   + '  ' +
    palette.heading(col('Category', CAT_W)) + '  ' +
    palette.heading(col('Sessions', CNT_W)) + '  ' +
    palette.heading(col('Last Seen', DATE_W));

  const divider = palette.dim('─'.repeat(LOCUS_W + REPO_W + CAT_W + CNT_W + DATE_W + 8));

  const rows = clusters.map((c) => {
    const count = String(c.recurrenceCount);
    const severityColor = c.recurrenceCount >= 5
      ? palette.error
      : c.recurrenceCount >= 3
        ? palette.warning
        : palette.meta;
    return (
      palette.fileRef(col(c.locus, LOCUS_W))           + '  ' +
      palette.dim(col(shortRepo(c.repo), REPO_W))      + '  ' +
      palette.label(col(c.category, CAT_W))            + '  ' +
      severityColor(count.padStart(CNT_W))             + '  ' +
      palette.dim(dateOnly(c.lastSeen).padEnd(DATE_W))
    );
  });

  const caption =
    palette.dim(`Showing top ${clusters.length} cluster(s) by recurrence count (lookback: ${days} days).`);

  return [header, divider, ...rows, '', caption].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDefectsCommand(program: Command): void {
  program
    .command('defects')
    .description('Show top recurring pre-existing defects from the session ledger')
    .option('--days <n>',  'Lookback window in days',    '90')
    .option('--top <n>',   'Maximum clusters to show',  '10')
    .option('--json',      'Emit raw JSON (for scripting)')
    .action(async (opts: { days: string; top: string; json?: boolean }) => {
      try {
        const days = Math.max(1, parseInt(opts.days, 10) || 90);
        const topN = Math.max(1, parseInt(opts.top, 10) || 10);

        const ledgerPath = getPreexistingLedgerPath();
        const { records: allRecords } = readLedgerRecords(ledgerPath);

        // Apply time window filter
        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const inWindow = allRecords.filter((r) => {
          const t = Date.parse(r.ts);
          return !isNaN(t) && t >= cutoffMs;
        });

        const clusters = clusterLedgerRecords(inWindow).slice(0, topN);

        if (opts.json) {
          process.stdout.write(JSON.stringify(clusters, null, 2) + '\n');
          return;
        }

        process.stdout.write(renderTable(clusters, days));
      } catch (err) {
        handleCommandError(err);
      }
    });
}
