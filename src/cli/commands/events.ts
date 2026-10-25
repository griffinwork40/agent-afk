/**
 * `afk events` command — GitHub event ingress into the pull queue (issue #3896).
 *
 * Usage:
 *   afk events github --repo <owner/repo> --on <event[,event]> [--command <template>]
 *                     [--interval <ms>] [--once]
 *
 * Starts an opt-in polling producer that watches a GitHub repository for the
 * specified event types and writes new events into the existing pull queue.
 * A running daemon with `--trigger pull` will dequeue and execute them.
 *
 * This is the first slice of #3896: a `gh api`-based polling producer.
 * Webhook ingress (`afk events serve`) is a follow-up.
 *
 * @module cli/commands/events
 */

import { Command } from 'commander';
import { env } from '../../config/env.js';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import {
  GithubEventPoller,
  SUPPORTED_EVENT_TYPES,
  type GithubEventType,
} from '../../agent/daemon/github-event-poller.js';

const DEFAULT_COMMAND_TEMPLATE =
  'A GitHub event occurred in {{repo}}. Event type: {{event_type}}. Event id: {{event_id}}. Review the untrusted payload below and take appropriate action if warranted.';

const DEFAULT_INTERVAL_MS = 60_000;

export function registerEventsCommand(program: Command): void {
  const eventsCmd = program
    .command('events')
    .description(
      'Event ingress producers that write into the pull queue (Part of #3896)',
    );

  // --------------------------------------------------------------------------
  // afk events github
  // --------------------------------------------------------------------------

  const githubCmd = eventsCmd.command('github');
  githubCmd
    .description(
      'Poll GitHub for events and enqueue tasks into the pull queue.\n' +
      'Requires `gh` CLI authenticated (`gh auth status`).\n' +
      'Supported event types: ' + SUPPORTED_EVENT_TYPES.join(', '),
    )
    .requiredOption('--repo <owner/repo>', 'GitHub repository to watch (e.g. owner/repo)')
    .requiredOption(
      '--on <events>',
      `Comma-separated event types to watch: ${SUPPORTED_EVENT_TYPES.join(', ')}`,
    )
    .option(
      '--command <template>',
      'Command template for enqueued tasks. ' +
      'Placeholders: {{event_type}}, {{repo}}, {{event_id}}. ' +
      'Event payload is appended as untrusted data.',
      DEFAULT_COMMAND_TEMPLATE,
    )
    .option(
      '--interval <ms>',
      'Poll interval in milliseconds',
      String(DEFAULT_INTERVAL_MS),
    )
    .option(
      '--once',
      'Poll once and exit (useful for cron or testing)',
    )
    .action(
      async (opts: {
        repo: string;
        on: string;
        command: string;
        interval: string;
        once?: boolean;
      }) => {
        try {
          // Parse and validate event types
          const requestedTypes = opts.on.split(',').map((s) => s.trim());
          const invalidTypes = requestedTypes.filter(
            (t) => !SUPPORTED_EVENT_TYPES.includes(t as GithubEventType),
          );
          if (invalidTypes.length > 0) {
            console.error(
              palette.error(
                `Unknown event type(s): ${invalidTypes.join(', ')}. ` +
                `Supported: ${SUPPORTED_EVENT_TYPES.join(', ')}`,
              ),
            );
            process.exit(1);
          }
          const events = requestedTypes as GithubEventType[];

          // Validate repo format
          if (!/^[^/]+\/[^/]+$/.test(opts.repo)) {
            console.error(
              palette.error(
                `Invalid --repo format. Expected owner/repo, got: ${opts.repo}`,
              ),
            );
            process.exit(1);
          }

          const intervalMs = parseInt(opts.interval, 10);
          if (!Number.isFinite(intervalMs) || intervalMs < 5_000) {
            console.error(
              palette.error(
                `--interval must be a number >= 5000 ms, got: ${opts.interval}`,
              ),
            );
            process.exit(1);
          }

          // Read poll interval from env as an override (AFK_EVENTS_GITHUB_POLL_MS)
          const envInterval = env.AFK_EVENTS_GITHUB_POLL_MS;
          let resolvedInterval = intervalMs;
          if (envInterval !== undefined) {
            const parsed = parseInt(envInterval, 10);
            if (!Number.isFinite(parsed) || parsed < 5_000) {
              console.error(
                palette.error(
                  `AFK_EVENTS_GITHUB_POLL_MS must be >= 5000 ms, got: ${envInterval}`,
                ),
              );
              process.exit(1);
            }
            resolvedInterval = parsed;
          }

          const poller = new GithubEventPoller({
            repo: opts.repo,
            events,
            commandTemplate: opts.command,
            pollIntervalMs: resolvedInterval,
          });

          console.log(
            palette.success(
              `✔ Starting GitHub event poller for ${opts.repo}`,
            ),
          );
          console.log(palette.dim(`  events   : ${events.join(', ')}`));
          console.log(
            palette.dim(
              `  interval : ${opts.once ? 'once' : `${resolvedInterval}ms`}`,
            ),
          );
          console.log(
            palette.dim(
              '  queue    : tasks will be written to the pull queue ' +
              '(run `afk daemon --trigger pull` to execute them)',
            ),
          );

          if (opts.once) {
            await poller.tick();
            console.log(palette.dim('  done (--once mode)'));
            return;
          }

          // Continuous mode: keep running until SIGINT/SIGTERM
          poller.start();

          await new Promise<void>((resolve) => {
            const stop = () => {
              poller.stop();
              resolve();
            };
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
          });

          console.log(palette.dim('\nStopped.'));
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}
