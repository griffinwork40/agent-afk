/**
 * CLI subcommands for agent episode synthesis.
 *
 * afk episode synthesize <session-id>   — synthesize one session on demand
 * afk episode synthesize --latest       — synthesize the most recent session
 * afk episode backfill [--since <date>] [--limit N] [--dry-run]
 *                                       — retroactively synthesize episodes for
 *                                         all existing session journals on disk
 *
 * Episode synthesis extracts structural signals from a sealed session journal
 * and stores a compressed narrative in the cross-session memory archive.
 * This command is opt-in and independent of AFK_EPISODE_SYNTHESIS — it runs
 * synthesis unconditionally for the named session.
 *
 * @module cli/commands/episode
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import { synthesizeAndWriteEpisode } from '../../agent/episodes/index.js';
import { resolveLatestSession } from '../../agent/trace/listing.js';
import { MemoryStore } from '../../agent/memory/memory-store.js';
import { getSessionsDir } from '../../paths.js';
import { isErrnoCode } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Backfill helpers
// ---------------------------------------------------------------------------

/** Delay between LLM calls to avoid rate limits (~$0.002/session on haiku). */
const BACKFILL_DELAY_MS = 500;

/**
 * Discover session IDs that have a journal.jsonl on disk.
 * Returns entries sorted oldest-first (by journal mtime).
 */
async function discoverJournaledSessions(sessionsDir: string): Promise<
  Array<{ sessionId: string; journalPath: string; mtimeMs: number }>
> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) return [];
    throw err;
  }

  const entries: Array<{ sessionId: string; journalPath: string; mtimeMs: number }> = [];
  for (const sessionId of names) {
    const journalPath = join(sessionsDir, sessionId, 'journal.jsonl');
    try {
      const st = await stat(journalPath);
      if (st.isFile()) {
        entries.push({ sessionId, journalPath, mtimeMs: st.mtimeMs });
      }
    } catch {
      // No journal.jsonl in this directory — skip silently.
    }
  }

  // Sort oldest-first so progress is predictable.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return entries;
}

/**
 * Check whether an episode has already been synthesized for a session.
 * Looks for a fact whose content begins with `[episode:<sessionId>]`.
 */
function episodeAlreadyExists(store: MemoryStore, sessionId: string): boolean {
  try {
    // Escape brackets so they are treated as literals in the FTS query.
    const sanitized = sessionId.replace(/[":*()\^]/g, ' ');
    const results = store.searchFacts(`episode ${sanitized}`, { limit: 1 });
    return results.some((f) => f.content.startsWith(`[episode:${sessionId}]`));
  } catch {
    // If the memory store is unavailable, treat as not-yet-synthesized.
    return false;
  }
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerEpisodeCommand(program: Command): void {
  const episode = program
    .command('episode')
    .description('Synthesize and store compressed episodic narratives from session journals.');

  episode
    .command('synthesize [session-id]')
    .description(
      'Synthesize a compressed episode narrative from a sealed session journal\n' +
        'and store it in the cross-session memory archive (facts, category: learning).\n' +
        'Defaults to the most recent session when no session-id is given.',
    )
    .option('--latest', 'Synthesize the most recent session (same as omitting session-id)')
    .action(async (sessionId: string | undefined, options: { latest?: boolean }) => {
      try {
        let resolvedId = sessionId;

        if (!resolvedId || options.latest) {
          const latest = await resolveLatestSession();
          if (!latest) {
            process.stderr.write('No sessions found.\n');
            process.exit(1);
          }
          resolvedId = latest;
          process.stdout.write(
            palette.dim(`Resolved latest session: ${resolvedId}\n`),
          );
        }

        process.stdout.write(palette.dim(`Synthesizing episode for ${resolvedId}…\n`));

        const episode = await synthesizeAndWriteEpisode(resolvedId as string);

        if (!episode) {
          process.stdout.write(
            palette.dim(`Skipped: session ${resolvedId} has no user content or tool usage.\n`),
          );
          return;
        }

        // Item 3 guard: warn when the episode input was empty. resolveLatestSession()
        // returns witness directory labels which may differ from runtime session IDs
        // for `afk chat` sessions — those produce empty episodes.
        if (episode.goal === 'Unknown goal') {
          process.stderr.write(
            `Warning: episode for ${resolvedId} has no goal or narrative.\n` +
            `The session ID may be a witness label that differs from the runtime ID.\n` +
            `Try passing the runtime session ID directly.\n`,
          );
        }

        process.stdout.write([
          '',
          `${palette.bold('Episode stored')} ${palette.dim(`[${episode.sessionId}]`)}`,
          `${palette.dim('goal:')}      ${episode.goal}`,
          `${palette.dim('approach:')} ${episode.approach}`,
          `${palette.dim('outcome:')}  ${episode.outcome}`,
          ...(episode.tags.length > 0
            ? [`${palette.dim('tags:')}     ${episode.tags.join(', ')}`]
            : []),
          ...(episode.narrative
            ? [`\n${palette.dim('narrative:')} ${episode.narrative}`]
            : []),
          '',
        ].join('\n'));

        process.exit(0);
      } catch (err) {
        handleCommandError(err);
        process.exit(1);
      }
    });

  episode
    .command('backfill')
    .description(
      'Retroactively synthesize episodes for existing sessions that have journals on disk.\n' +
        'Idempotent: sessions that already have an episode in memory are skipped.\n' +
        'Use --dry-run to preview which sessions would be processed.',
    )
    .option(
      '--since <date>',
      'Only process sessions whose journal was last modified on or after this date (ISO 8601 or YYYY-MM-DD).',
    )
    .option(
      '--limit <n>',
      'Maximum number of sessions to synthesize in this run.',
      (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1) throw new Error('--limit must be a positive integer');
        return n;
      },
    )
    .option('--dry-run', 'Preview which sessions would be processed without synthesizing.')
    .action(async (options: { since?: string; limit?: number; dryRun?: boolean }) => {
      try {
        const sessionsDir = getSessionsDir();
        const store = new MemoryStore();

        // 1. Discover all journaled sessions.
        const allEntries = await discoverJournaledSessions(sessionsDir);

        if (allEntries.length === 0) {
          process.stdout.write('No session journals found.\n');
          process.exit(0);
        }

        // 2. Filter by --since.
        let sinceMs = 0;
        if (options.since) {
          const d = new Date(options.since);
          if (isNaN(d.getTime())) {
            process.stderr.write(`Invalid --since date: ${options.since}\n`);
            process.exit(1);
          }
          sinceMs = d.getTime();
        }

        const filtered = sinceMs > 0
          ? allEntries.filter((e) => e.mtimeMs >= sinceMs)
          : allEntries;

        // 3. Skip sessions that already have an episode.
        const pending = filtered.filter((e) => !episodeAlreadyExists(store, e.sessionId));

        // 4. Apply --limit.
        const toProcess = options.limit !== undefined
          ? pending.slice(0, options.limit)
          : pending;

        const skipped = filtered.length - pending.length;
        process.stdout.write(
          `Found ${allEntries.length} journaled session(s). ` +
          `${filtered.length} match filter. ` +
          `${skipped} already have episodes (skipped). ` +
          `${toProcess.length} to synthesize.\n`,
        );

        if (toProcess.length === 0) {
          process.stdout.write('Nothing to do.\n');
          process.exit(0);
        }

        if (options.dryRun) {
          process.stdout.write('\n--dry-run: would synthesize:\n');
          for (const entry of toProcess) {
            const date = new Date(entry.mtimeMs).toISOString().slice(0, 10);
            process.stdout.write(`  ${entry.sessionId}  (journal: ${date})\n`);
          }
          process.exit(0);
        }

        // 5. Synthesize with progress reporting and rate limiting.
        let synthesized = 0;
        let failed = 0;
        const total = toProcess.length;

        for (const entry of toProcess) {
          const pct = Math.round(((synthesized + failed) / total) * 100);
          process.stdout.write(
            `[${synthesized + failed + 1}/${total} ${pct}%] ${entry.sessionId}… `,
          );

          try {
            await synthesizeAndWriteEpisode(entry.sessionId);
            synthesized++;
            process.stdout.write(palette.dim('done\n'));
          } catch (err) {
            failed++;
            const msg = err instanceof Error ? err.message : String(err);
            process.stdout.write(`${palette.dim('failed:')} ${msg}\n`);
          }

          // Rate-limit: small delay between LLM calls.
          if (synthesized + failed < total) {
            await sleep(BACKFILL_DELAY_MS);
          }
        }

        process.stdout.write(
          `\nBackfill complete: synthesized ${synthesized}/${total}` +
          (failed > 0 ? `, ${failed} failed` : '') +
          '.\n',
        );

        process.exit(failed > 0 ? 1 : 0);
      } catch (err) {
        handleCommandError(err);
        process.exit(1);
      }
    });
}
