/**
 * CLI subcommands for searching and indexing session transcripts.
 *
 * Transcripts are autosaved Markdown files under `~/.afk/state/transcripts/`.
 * This command exposes an SQLite FTS5 full-text index over their content as a
 * high-recall complement to the curated fact archive (`memory_search`).
 *
 * Subcommands:
 *   afk transcript search <query>   — search indexed transcripts via FTS5
 *   afk transcript reindex          — build/rebuild the FTS5 index from disk
 *
 * Design notes (v1):
 * - The index is reindex-on-demand only. Incremental indexing at session close
 *   is deferred for a follow-up (it would require session lifecycle coupling
 *   and the mtime-gate logic, which adds risk for minimal v1 gain).
 * - The in-session `transcript_search` tool is also deferred for v1 — it would
 *   require wiring into the tool registry, which is heavier and riskier than
 *   the CLI surface. The CLI commands are the v1 required deliverable.
 * - Query strings are passed verbatim to FTS5 MATCH. Callers may use FTS5
 *   syntax: "exact phrase", term*, AND, OR.
 *
 * @module cli/commands/transcript
 */

import { Command } from 'commander';
import { handleCommandError } from '../errors/index.js';
import { withTranscriptIndex } from '../../agent/transcript-search/transcript-index.js';

// ── Limit normalization ─────────────────────────────────────────────────────

/** Largest result count `afk transcript search --limit` will honor. */
export const MAX_SEARCH_LIMIT = 1000;

/**
 * Normalize the raw `--limit` CLI string to a sane, bounded integer.
 *
 * Invalid or non-positive input (NaN, 0, negatives, empty) falls back to
 * `fallback` (default 10); values above {@link MAX_SEARCH_LIMIT} are capped so a
 * pathological `--limit` cannot push an unbounded value into the SQL `LIMIT`.
 */
export function normalizeLimit(raw: string, fallback = 10): number {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_SEARCH_LIMIT);
}

// ── Command registration ────────────────────────────────────────────────────

export function registerTranscriptCommand(program: Command): void {
  const transcript = program
    .command('transcript')
    .description(
      'Search and index session transcripts.\n' +
        'Transcripts are autosaved at ~/.afk/state/transcripts/.\n' +
        'Run `afk transcript reindex` once before searching.',
    );

  // ── afk transcript reindex ────────────────────────────────────────────────

  transcript
    .command('reindex')
    .description(
      'Build (or rebuild) the FTS5 full-text index from all transcript files on disk.\n' +
        'Safe to run repeatedly — replaces the index atomically.',
    )
    .action(async () => {
      try {
        const { indexed, skipped } = withTranscriptIndex((idx) => idx.reindex());
        const skippedNote =
          skipped > 0 ? ` (${skipped} skipped — run with DEBUG=1 for details)` : '';
        process.stdout.write(
          `Indexed ${indexed} transcript${indexed === 1 ? '' : 's'}${skippedNote}.\n`,
        );
      } catch (err) {
        handleCommandError(err);
      }
    });

  // ── afk transcript search <query> ─────────────────────────────────────────

  transcript
    .command('search <query>')
    .description(
      'Search indexed transcripts via FTS5 full-text search.\n' +
        'Supports FTS5 syntax: "exact phrase", term*, AND, OR.\n' +
        'Run `afk transcript reindex` first to build the index.',
    )
    .option('-n, --limit <number>', `Maximum results to return (1-${MAX_SEARCH_LIMIT})`, '10')
    .action(async (query: string, options: { limit: string }) => {
      try {
        const limit = normalizeLimit(options.limit);

        const results = withTranscriptIndex((idx) => {
          const count = idx.count();
          if (count === 0) {
            return { empty: true as const, results: [] };
          }
          return { empty: false as const, results: idx.search(query, limit) };
        });

        if (results.empty) {
          process.stdout.write(
            'No transcripts indexed yet. Run `afk transcript reindex` first.\n',
          );
          return;
        }

        if (results.results.length === 0) {
          process.stdout.write(`No results for "${query}".\n`);
          return;
        }

        for (const hit of results.results) {
          // Format: timestamp + filename, then the matching excerpt (FTS5 snippet).
          const date = hit.session_at.replace('T', ' ').slice(0, 19);
          process.stdout.write(`${date}  ${hit.filename}\n  ${hit.snippet}\n\n`);
        }
        process.stdout.write(
          `${results.results.length} result${results.results.length === 1 ? '' : 's'} ` +
            `(use FTS5 syntax for advanced queries: "exact phrase", term*, AND, OR)\n`,
        );
      } catch (err) {
        handleCommandError(err);
      }
    });
}
