/**
 * `afk events` command — GitHub event ingress into the pull queue (issue #3896).
 *
 * Usage:
 *   afk events github --repo <owner/repo> --on <event[,event]> [--command <template>]
 *                     [--interval <ms>] [--once]
 *   afk events serve  --secret <hmac-secret> [--command <template>]
 *                     [--port <port>] [--allow-external]
 *
 * `afk events github` is a `gh api`-based polling producer.
 * `afk events serve` is the HMAC-verified local HTTP webhook receiver slice of
 * #3896. It binds on loopback by default; use a tunnel (ngrok, cloudflared)
 * to expose it to GitHub's webhook delivery addresses.
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
import {
  WebhookReceiver,
  DEFAULT_WEBHOOK_PORT,
  DEFAULT_WEBHOOK_HOST,
} from '../../agent/daemon/github-webhook-receiver.js';

const DEFAULT_COMMAND_TEMPLATE =
  'A GitHub event occurred in {{repo}}. Event type: {{event_type}}. Event id: {{event_id}}. Review the untrusted payload below and take appropriate action if warranted.';

const DEFAULT_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// afk events github — action handler
// ---------------------------------------------------------------------------

interface GithubOpts {
  repo: string;
  on: string;
  command: string;
  interval: string;
  once?: boolean;
}

async function runGithubAction(opts: GithubOpts): Promise<void> {
  const requestedTypes = opts.on.split(',').map((s) => s.trim());
  const invalidTypes = requestedTypes.filter(
    (t) => !SUPPORTED_EVENT_TYPES.includes(t as GithubEventType),
  );
  if (invalidTypes.length > 0) {
    console.error(
      palette.error(
        `Unknown event type(s): ${invalidTypes.join(', ')}. Supported: ${SUPPORTED_EVENT_TYPES.join(', ')}`,
      ),
    );
    process.exit(1);
  }
  const events = requestedTypes as GithubEventType[];

  if (!/^[^/]+\/[^/]+$/.test(opts.repo)) {
    console.error(palette.error(`Invalid --repo format. Expected owner/repo, got: ${opts.repo}`));
    process.exit(1);
  }

  const intervalMs = parseInt(opts.interval, 10);
  if (!Number.isFinite(intervalMs) || intervalMs < 5_000) {
    console.error(palette.error(`--interval must be a number >= 5000 ms, got: ${opts.interval}`));
    process.exit(1);
  }

  const resolvedInterval = resolveGithubInterval(intervalMs);
  const poller = new GithubEventPoller({
    repo: opts.repo,
    events,
    commandTemplate: opts.command,
    pollIntervalMs: resolvedInterval,
  });

  console.log(palette.success(`✔ Starting GitHub event poller for ${opts.repo}`));
  console.log(palette.dim(`  events   : ${events.join(', ')}`));
  console.log(palette.dim(`  interval : ${opts.once ? 'once' : `${resolvedInterval}ms`}`));
  console.log(palette.dim('  queue    : tasks will be written to the pull queue (run `afk daemon --trigger pull` to execute them)'));

  if (opts.once) {
    await poller.tick();
    console.log(palette.dim('  done (--once mode)'));
    return;
  }

  poller.start();
  await untilSignal(() => poller.stop());
  console.log(palette.dim('\nStopped.'));
}

function resolveGithubInterval(flagMs: number): number {
  const envInterval = env.AFK_EVENTS_GITHUB_POLL_MS;
  if (envInterval === undefined) return flagMs;
  const parsed = parseInt(envInterval, 10);
  if (!Number.isFinite(parsed) || parsed < 5_000) {
    console.error(palette.error(`AFK_EVENTS_GITHUB_POLL_MS must be >= 5000 ms, got: ${envInterval}`));
    process.exit(1);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// afk events serve — action handler
// ---------------------------------------------------------------------------

interface ServeOpts {
  secret?: string;
  command: string;
  port: string;
  host: string;
  allowExternal?: boolean;
}

async function runServeAction(opts: ServeOpts): Promise<void> {
  const secret = opts.secret ?? env.AFK_EVENTS_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      palette.error('Missing webhook secret. Supply --secret <secret> or set AFK_EVENTS_WEBHOOK_SECRET.'),
    );
    process.exit(1);
  }

  const resolvedPort = resolveWebhookPort(opts.port);
  const allowExternal =
    opts.allowExternal === true ||
    env.AFK_EVENTS_WEBHOOK_ALLOW_EXTERNAL === '1' ||
    env.AFK_EVENTS_WEBHOOK_ALLOW_EXTERNAL === 'true';

  const receiver = new WebhookReceiver({
    secret,
    commandTemplate: opts.command,
    port: resolvedPort,
    host: opts.host,
    allowExternal,
  });

  await receiver.listen();
  const addr = receiver.address();
  const boundAddr = addr ? `http://${addr.host}:${addr.port}` : `port ${resolvedPort}`;

  console.log(palette.success(`✔ GitHub webhook receiver listening on ${boundAddr}/webhook`));
  console.log(palette.dim('  POST /webhook — GitHub delivers events here'));
  console.log(palette.dim('  tasks will be written to the pull queue (run `afk daemon --trigger pull` to execute them)'));
  if (!allowExternal) {
    console.log(palette.dim(`  tip: use a tunnel (e.g. ngrok http ${resolvedPort}) to expose this to GitHub`));
  }

  await untilSignal(() => void receiver.close());
  console.log(palette.dim('\nStopped.'));
}

function resolveWebhookPort(flagPort: string): number {
  const envPort = env.AFK_EVENTS_WEBHOOK_PORT;
  let resolved = parseInt(flagPort, 10);
  if (envPort !== undefined) {
    const parsed = parseInt(envPort, 10);
    if (Number.isFinite(parsed)) resolved = parsed;
  }
  if (!Number.isFinite(resolved) || resolved < 1 || resolved > 65535) {
    console.error(palette.error(`--port must be 1–65535, got: ${flagPort}`));
    process.exit(1);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Shared utility
// ---------------------------------------------------------------------------

function untilSignal(cleanup: () => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => { cleanup(); resolve(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerEventsCommand(program: Command): void {
  const eventsCmd = program
    .command('events')
    .description('Event ingress producers that write into the pull queue (Part of #3896)');

  // afk events github
  eventsCmd.command('github')
    .description(
      'Poll GitHub for events and enqueue tasks into the pull queue.\n' +
      'Requires `gh` CLI authenticated (`gh auth status`).\n' +
      'Supported event types: ' + SUPPORTED_EVENT_TYPES.join(', '),
    )
    .requiredOption('--repo <owner/repo>', 'GitHub repository to watch (e.g. owner/repo)')
    .requiredOption('--on <events>', `Comma-separated event types to watch: ${SUPPORTED_EVENT_TYPES.join(', ')}`)
    .option('--command <template>', 'Command template. Placeholders: {{event_type}}, {{repo}}, {{event_id}}.', DEFAULT_COMMAND_TEMPLATE)
    .option('--interval <ms>', 'Poll interval in milliseconds', String(DEFAULT_INTERVAL_MS))
    .option('--once', 'Poll once and exit (useful for cron or testing)')
    .action(async (opts: GithubOpts) => {
      try { await runGithubAction(opts); } catch (err) { handleCommandError(err); }
    });

  // afk events serve
  eventsCmd.command('serve')
    .description(
      'Start an HMAC-verified local HTTP webhook receiver for GitHub events.\n' +
      'Listens on 127.0.0.1 by default. Use a tunnel (ngrok, cloudflared) to\n' +
      'expose it to GitHub\'s webhook delivery addresses.',
    )
    .option('--secret <secret>', 'HMAC-SHA256 secret (falls back to AFK_EVENTS_WEBHOOK_SECRET)')
    .option('--command <template>', 'Command template. Placeholders: {{event_type}}, {{repo}}, {{event_id}}.', DEFAULT_COMMAND_TEMPLATE)
    .option('--port <port>', 'TCP port to bind on', String(DEFAULT_WEBHOOK_PORT))
    .option('--host <host>', 'Bind address (default: 127.0.0.1). Non-loopback requires --allow-external.', DEFAULT_WEBHOOK_HOST)
    .option('--allow-external', 'Allow binding on a non-loopback address. Also enabled by AFK_EVENTS_WEBHOOK_ALLOW_EXTERNAL=1.')
    .action(async (opts: ServeOpts) => {
      try { await runServeAction(opts); } catch (err) { handleCommandError(err); }
    });
}
