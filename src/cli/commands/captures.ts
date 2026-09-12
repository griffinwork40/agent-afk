/**
 * CLI subcommand for listing and searching bash output captures.
 *
 * When a bash command produces more than 100 KB, the handler writes the full
 * output (up to 8 MB) to a capture file under the session's witness directory:
 *   $AFK_STATE_DIR/witness/<sessionId>/bash-captures/<toolUseId>.txt
 *
 * This command surfaces those captures so operators can discover, review, and
 * open the full output of any truncated bash command.
 *
 * Subcommands:
 *   afk captures list [options]  — list recent captures, newest first
 *
 * Options:
 *   --session <id>    Filter to a specific session id
 *   -n, --limit <n>   Maximum entries to show (default: 20)
 *   --json            Emit raw JSON (for piping to jq)
 *
 * @module cli/commands/captures
 */

import { Command } from 'commander';
import { handleCommandError } from '../errors/index.js';
import { listCaptures } from '../../agent/tools/bash-capture-index.js';
import { getWitnessRoot } from '../../paths.js';
import { palette } from '../palette.js';

// ---------------------------------------------------------------------------
// Formatting helpers (local to this command — not shared)
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerCapturesCommand(program: Command): void {
  const captures = program
    .command('captures')
    .description(
      'List bash output captures — full output files written when a command\n' +
        'produces more than 100 KB. Captures live under the witness directory\n' +
        'and are evicted automatically by the 30-day / 2 GiB retention sweep.',
    );

  // afk captures list
  captures
    .command('list')
    .description('List recent bash output captures, newest first')
    .option('--session <id>', 'Filter to a specific session id')
    .option('-n, --limit <number>', 'Maximum entries to show (default: 20)', '20')
    .option('--json', 'Emit raw JSON (for piping to jq)', false)
    .action(
      async (options: { session?: string; limit: string; json: boolean }) => {
        try {
          const limitN = Math.max(1, parseInt(options.limit, 10) || 20);

          const entries = await listCaptures({
            sessionId: options.session,
            limit: limitN,
          });

          if (options.json) {
            process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
            return;
          }

          if (entries.length === 0) {
            const root = getWitnessRoot();
            const filterNote = options.session
              ? ` for session "${options.session}"`
              : '';
            process.stdout.write(
              palette.meta(
                `No bash captures found${filterNote} under ${root}/*/bash-captures/\n`,
              ),
            );
            return;
          }

          // Header
          process.stdout.write(
            palette.heading(
              `${'Timestamp'.padEnd(20)}  ${'Size'.padStart(8)}  ${'Session'.padEnd(32)}  Preview\n`,
            ),
          );
          process.stdout.write(palette.dim('─'.repeat(100) + '\n'));

          for (const e of entries) {
            const ts = palette.dim(fmtDate(e.mtimeMs));
            const size = palette.info(fmtBytes(e.sizeBytes).padStart(8));
            // Truncate session id to 32 chars for display; full id in --json.
            const sid =
              e.sessionId.length > 32
                ? e.sessionId.slice(0, 31) + '…'
                : e.sessionId.padEnd(32);
            const sessionCol = palette.meta(sid);
            const previewCol = palette.tool(e.preview);
            process.stdout.write(`${ts}  ${size}  ${sessionCol}  ${previewCol}\n`);
          }

          const root = getWitnessRoot();
          process.stdout.write(
            palette.dim(
              `\n${entries.length} capture(s) shown. Full files under ${root}/<session>/bash-captures/\n`,
            ),
          );
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}
