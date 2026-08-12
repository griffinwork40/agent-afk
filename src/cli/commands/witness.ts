/**
 * CLI subcommands for searching the witness-layer trace history.
 *
 * Thin wrappers over the built-in `read_witness` and `search_witness` tool
 * handlers. The same query logic powers both the CLI and the agent tools.
 *
 *   afk witness read [session]    — read/filter events from one session
 *   afk witness search <query>    — text-search across recent sessions
 *
 * @module cli/commands/witness
 */

import { Command } from 'commander';
import { handleCommandError } from '../errors/index.js';
import { readSessionTrace, searchAcrossSessions } from '../../agent/tools/handlers/witness.query.js';

export function registerWitnessCommand(program: Command): void {
  const witness = program
    .command('witness')
    .description(
      'Search and filter the witness-layer trace history — the durable record\n' +
        'of everything agents did across sessions.',
    );

  // afk witness read [session]
  witness
    .command('read [session]')
    .description('Read and filter events from a session trace (default: latest)')
    .option('-k, --kinds <kinds>', 'Comma-separated event kinds to filter by')
    .option('-t, --tool <name>', 'Filter tool_call events to this tool name')
    .option('-e, --errors', 'Show only error events', false)
    .option('-n, --limit <number>', 'Max events to return (default: 50, max: 200)')
    .option('--json', 'Emit raw JSON (for piping to jq)', false)
    .action(async (session: string | undefined, options: Record<string, unknown>) => {
      try {
        const kinds = typeof options['kinds'] === 'string'
          ? (options['kinds'] as string).split(',').map((k) => k.trim())
          : undefined;
        const limit = typeof options['limit'] === 'string'
          ? parseInt(options['limit'] as string, 10)
          : undefined;

        const result = await readSessionTrace({
          session: session ?? 'latest',
          kinds,
          toolName: typeof options['tool'] === 'string' ? options['tool'] as string : undefined,
          errorsOnly: options['errors'] === true,
          limit,
        });

        if (options['json']) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(
          `Session: ${result.sessionId}  (${result.totalInTrace} events, ` +
            `${result.filtered} matched)\n`,
        );
        for (const ev of result.events) {
          const payload = ev.payload as unknown as Record<string, unknown>;
          const name = payload['name'] ?? payload['transition'] ?? payload['phase'] ?? '';
          const err = payload['isError'] ? ' ✗' : '';
          const dur = typeof payload['durationMs'] === 'number'
            ? ` (${payload['durationMs']}ms)`
            : '';
          console.log(`  ${ev.ts}  [${ev.kind}] ${name}${err}${dur}`);
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  // afk witness search <query>
  witness
    .command('search <query>')
    .description('Text-search across recent sessions\' traces')
    .option('-n, --sessions <number>', 'Number of recent sessions to scan (default: 20)')
    .option('-k, --kinds <kinds>', 'Comma-separated event kinds to filter by')
    .option('--since <date>', 'Only search sessions modified after this ISO date')
    .option('--json', 'Emit raw JSON (for piping to jq)', false)
    .action(async (query: string, options: Record<string, unknown>) => {
      try {
        const kinds = typeof options['kinds'] === 'string'
          ? (options['kinds'] as string).split(',').map((k) => k.trim())
          : undefined;
        const sessions = typeof options['sessions'] === 'string'
          ? parseInt(options['sessions'] as string, 10)
          : undefined;

        const result = await searchAcrossSessions({
          query,
          sessions,
          kinds,
          since: typeof options['since'] === 'string' ? options['since'] as string : undefined,
        });

        if (options['json']) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const sessionsSummary = result.sessionsSearched === result.sessionsAvailable
          ? `${result.sessionsSearched} sessions searched`
          : `${result.sessionsSearched}/${result.sessionsAvailable} sessions searched`;
        console.log(
          `Search: "${result.query}"  (${sessionsSummary}, ` +
            `${result.matches.length} matches)\n`,
        );

        let currentSession = '';
        for (const match of result.matches) {
          if (match.sessionId !== currentSession) {
            currentSession = match.sessionId;
            console.log(`\n  ── ${currentSession} ──`);
          }
          const payload = match.event.payload as unknown as Record<string, unknown>;
          const name = payload['name'] ?? payload['transition'] ?? payload['phase'] ?? '';
          console.log(`    ${match.event.ts}  [${match.event.kind}] ${name}`);
        }
      } catch (err) {
        handleCommandError(err);
      }
    });
}
