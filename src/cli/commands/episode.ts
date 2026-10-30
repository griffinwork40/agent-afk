/**
 * CLI subcommands for agent episode synthesis.
 *
 * afk episode synthesize <session-id>   — synthesize one session on demand
 * afk episode synthesize --latest       — synthesize the most recent session
 *
 * Episode synthesis extracts structural signals from a sealed session journal
 * and stores a compressed narrative in the cross-session memory archive.
 * This command is opt-in and independent of AFK_EPISODE_SYNTHESIS — it runs
 * synthesis unconditionally for the named session.
 *
 * @module cli/commands/episode
 */

import { Command } from 'commander';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import { synthesizeAndWriteEpisode } from '../../agent/episodes/index.js';
import { resolveLatestSession } from '../../agent/trace/listing.js';

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
}
