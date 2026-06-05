/**
 * CLI subcommands for inspecting persisted background subagent job logs.
 *
 * Subcommands: list | tail | replay
 *
 * These commands read from `~/.afk/state/bg/<jobId>/` — the durable log
 * written while the job runs. They work even after the parent REPL has exited
 * (or after the in-memory registry has evicted the job entry).
 *
 * Note: bg jobs are tied to the parent REPL process — if the REPL exits, the
 * job dies. This command reads the persisted log.
 *
 * Usage:
 *   afk bg list              — list known jobs from disk
 *   afk bg tail <jobId>      — stream live events (--from-start to replay first)
 *   afk bg replay <jobId>    — alias for tail --from-start --no-follow
 *
 * @module cli/commands/bg
 */

import { Command } from 'commander';
import { handleCommandError } from '../errors/index.js';
import { BgJobLogReader } from '../../agent/bg-job-log.js';
import type { BgJobMeta } from '../../agent/bg-job-log.js';
import type { OutputEvent } from '../../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

const STATUS_WIDTH = 9;
const LABEL_WIDTH = 50;
const ID_WIDTH = 22;

function formatJobRow(meta: BgJobMeta): string {
  const id = padRight(meta.jobId, ID_WIDTH);
  const status = padRight(meta.status, STATUS_WIDTH);
  const label = meta.label.length > LABEL_WIDTH
    ? `${meta.label.slice(0, LABEL_WIDTH - 1)}…`
    : padRight(meta.label, LABEL_WIDTH);
  const started = formatDate(meta.startedAt);
  const ended = meta.endedAt !== undefined ? formatDate(meta.endedAt) : '—';
  return `${id}  ${status}  ${label}  ${started}  ${ended}`;
}

function isTerminalEvent(event: OutputEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerBgCommand(program: Command): void {
  const bg = program
    .command('bg')
    .description(
      'Inspect persisted background subagent job logs.\n' +
      'Note: bg jobs are tied to the parent REPL process — if the REPL exits,\n' +
      'the job dies. This command reads the persisted log.',
    );

  // afk bg list
  bg
    .command('list')
    .description('List background jobs from disk (most recent first)')
    .option('-n, --max <number>', 'Maximum jobs to show', '20')
    .action(async (options: { max: string }) => {
      try {
        const maxJobs = Math.min(100, Math.max(1, parseInt(options.max, 10) || 20));
        const jobs = await BgJobLogReader.listJobs();
        const slice = jobs.slice(0, maxJobs);

        if (slice.length === 0) {
          process.stdout.write('No background job logs found in ~/.afk/state/bg/\n');
          return;
        }

        // Header
        const header =
          padRight('JOB ID', ID_WIDTH) + '  ' +
          padRight('STATUS', STATUS_WIDTH) + '  ' +
          padRight('LABEL', LABEL_WIDTH) + '  ' +
          'STARTED AT           ' + '  ' +
          'ENDED AT';
        process.stdout.write(header + '\n');
        process.stdout.write('-'.repeat(header.length) + '\n');

        for (const meta of slice) {
          process.stdout.write(formatJobRow(meta) + '\n');
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  // afk bg tail <jobId>
  bg
    .command('tail <jobId>')
    .description(
      'Stream events from a background job log.\n' +
      'Note: bg jobs are tied to the parent REPL process — if the REPL exits,\n' +
      'the job dies. This command reads the persisted log.',
    )
    .option('--from-start', 'Replay all history before following new events', false)
    .option('--no-follow', 'Exit after replaying existing events; do not wait for new ones', false)
    .action(async (jobId: string, options: { fromStart: boolean; follow: boolean }) => {
      try {
        // Commander turns --no-follow into follow: false
        const noFollow = !options.follow;

        if (noFollow) {
          // --no-follow: use readEvents to just dump what's there
          for await (const event of BgJobLogReader.readEvents(jobId)) {
            process.stdout.write(JSON.stringify(event) + '\n');
          }
          return;
        }

        // Live tail with optional history replay
        for await (const event of BgJobLogReader.tailEvents(jobId, { fromStart: options.fromStart })) {
          process.stdout.write(JSON.stringify(event) + '\n');
          if (isTerminalEvent(event)) break;
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  // afk bg replay <jobId> — alias for tail --from-start --no-follow
  bg
    .command('replay <jobId>')
    .description(
      'Replay all persisted events for a background job (alias for tail --from-start --no-follow).\n' +
      'Note: bg jobs are tied to the parent REPL process — if the REPL exits,\n' +
      'the job dies. This command reads the persisted log.',
    )
    .action(async (jobId: string) => {
      try {
        for await (const event of BgJobLogReader.readEvents(jobId)) {
          process.stdout.write(JSON.stringify(event) + '\n');
        }
      } catch (err) {
        handleCommandError(err);
      }
    });
}
