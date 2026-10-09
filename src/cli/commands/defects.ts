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
import { sanitizeForDisplay } from '../../utils/terminal-sanitize.js';
import { readLedgerRecords, clusterLedgerRecords } from '../../agent/preexisting-ledger/reader.js';
import { getPreexistingLedgerPath } from '../../agent/preexisting-ledger/paths.js';
import type { DefectCluster } from '../../agent/preexisting-ledger/reader.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 90;
const DEFAULT_TOP  = 10;
const RECURRENCE_ERROR_THRESHOLD   = 5;
const RECURRENCE_WARNING_THRESHOLD = 3;

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
// Argument parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse an integer CLI option, returning `defaultVal` for non-numeric input
 * and clamping to a minimum of 1 for numeric input.
 * This intentionally lets `--days 0` pass as 1 (floor) rather than silently
 * falling back to the default as the old `|| defaultVal` pattern did.
 */
function parseIntOption(raw: string, defaultVal: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return defaultVal;
  return Math.max(1, n);
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

const LOCUS_W = 42;
const REPO_W  = 22;
const CAT_W   = 12;
const CNT_W   =  8; // "Sessions" is 8 chars
const DATE_W  = 10;

function renderTable(
  clusters: DefectCluster[],
  days: number,
  totalClusters: number,
  ledgerTruncated: boolean,
  ledgerPath: string,
): string {
  const lines: string[] = [];

  if (ledgerTruncated) {
    lines.push(
      palette.warning('⚠ Ledger exceeded 1 MB — only the most recent records were read. Older entries may be missing.') + '\n',
    );
  }

  if (clusters.length === 0) {
    lines.push(
      palette.meta('No pre-existing defect records in the last ') +
      palette.meta(String(days)) +
      palette.meta(' days.') +
      '\n' +
      palette.dim('Run `afk chat` sessions to accumulate data, or check ') +
      palette.dim(sanitizeForDisplay(ledgerPath)) +
      '\n',
    );
    return lines.join('');
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
    const severityColor = c.recurrenceCount >= RECURRENCE_ERROR_THRESHOLD
      ? palette.error
      : c.recurrenceCount >= RECURRENCE_WARNING_THRESHOLD
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

  const hidden = totalClusters - clusters.length;
  const hiddenSuffix = hidden > 0
    ? palette.dim(` (${hidden} more cluster${hidden === 1 ? '' : 's'} not shown — use --top to expand)`)
    : '';

  const caption =
    palette.dim(`Showing top ${clusters.length} cluster(s) by recurrence count (lookback: ${days} days).`) +
    hiddenSuffix;

  lines.push([header, divider, ...rows, '', caption].join('\n') + '\n');
  return lines.join('');
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDefectsCommand(program: Command): void {
  program
    .command('defects')
    .description('Show top recurring pre-existing defects from the session ledger')
    .option('--days <n>',  'Lookback window in days',    String(DEFAULT_DAYS))
    .option('--top <n>',   'Maximum clusters to show',  String(DEFAULT_TOP))
    .option('--json',      'Emit raw JSON (for scripting)')
    .action(async (opts: { days: string; top: string; json?: boolean }) => {
      try {
        const days = parseIntOption(opts.days, DEFAULT_DAYS);
        const topN = parseIntOption(opts.top, DEFAULT_TOP);

        const ledgerPath = getPreexistingLedgerPath();
        const { records: allRecords, ledgerTruncated } = readLedgerRecords(ledgerPath);

        // Apply time window filter
        const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const inWindow = allRecords.filter((r) => {
          const t = Date.parse(r.ts);
          return !isNaN(t) && t >= cutoffMs;
        });

        const allClusters = clusterLedgerRecords(inWindow);
        const clusters    = allClusters.slice(0, topN);

        if (opts.json) {
          process.stdout.write(JSON.stringify(clusters, null, 2) + '\n');
          return;
        }

        process.stdout.write(
          renderTable(clusters, days, allClusters.length, ledgerTruncated, ledgerPath),
        );
      } catch (err) {
        handleCommandError(err);
      }
    });
}
