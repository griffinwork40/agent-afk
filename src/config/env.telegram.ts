/**
 * Telegram bot env vars: a contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.telegram
 */

import type { EnvVarMeta } from './env.js';

export const TELEGRAM_ENV_REGISTRY = [
  {
    name: 'TELEGRAM_BOT_TOKEN',
    description: 'Telegram bot token from @BotFather. Required to run the Telegram bot surface.',
    type: 'string',
    required: false, // Required only when running the bot; not for `afk chat`.
    category: 'telegram',
    secret: true,
  },
  {
    name: 'AFK_TELEGRAM_BOT_TOKEN',
    description: 'Alternative env var name for the Telegram bot token, accepted by the setup wizard.',
    type: 'string',
    required: false,
    category: 'telegram',
    secret: true,
  },
  {
    name: 'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
    description: 'Comma-separated list of Telegram chat IDs allowed to interact with the bot. Required when the bot is running.',
    type: 'string',
    required: false,
    example: '123456789,987654321',
    category: 'telegram',
  },
  {
    name: 'AFK_TELEGRAM_TAG_ONLY_CHAT_IDS',
    description: 'Comma-separated list of Telegram chat IDs where the bot answers only when addressed (a reply to the bot, an @mention of the bot, or a text_mention resolving to the bot). Slash-commands are unaffected; chats not listed behave as usual. The afk.config.json telegram.tagOnlyChats block takes precedence. Requires Telegram privacy mode OFF (BotFather /setprivacy Disable) for non-addressed group messages to reach the bot.',
    type: 'string',
    required: false,
    example: '-100987654321,123456789',
    category: 'telegram',
  },
  {
    name: 'AFK_TELEGRAM_PRIMARY_CHAT_ID',
    description: 'Default chat ID for outbound notifications (primary-mode routing). When unset, notifications go to the first private/DM chat in AFK_TELEGRAM_ALLOWED_CHAT_IDS. The afk.config.json telegram.notify block takes precedence.',
    type: 'string',
    required: false,
    example: '123456789',
    category: 'telegram',
  },
  {
    name: 'AFK_TELEGRAM_NOTIFY_MODE',
    description: 'Outbound notification fan-out: primary (default — one chat), broadcast (every allowed chat), or custom (afk.config.json telegram.notify.targets). The afk.config.json telegram.notify.mode takes precedence.',
    type: 'string',
    required: false,
    example: 'broadcast',
    category: 'telegram',
  },
  {
    name: 'TELEGRAM_DATA_DIR',
    description: 'Override the directory where Telegram bot state is stored. Defaults to ~/.afk/state/telegram/.',
    type: 'string',
    required: false,
    category: 'telegram',
  },
  {
    name: 'TELEGRAM_VERBOSE',
    description: "Set to a truthy value ('1'/'true'/'yes'/'on', case-insensitive) to log per-message details from the Telegram bot — chat IDs, message text, latency.",
    type: 'boolean',
    required: false,
    example: 'true',
    category: 'telegram',
  },
  {
    name: 'AFK_TELEGRAM_TRACE',
    description: 'Set to 1 to dump raw bridge traffic between the agent and the Telegram bot — debugging only.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_TELEGRAM_CWD',
    description: 'Override the working directory used by the Telegram bot when spawning agent sessions.',
    type: 'string',
    required: false,
    category: 'telegram',
  },
  {
    name: 'AFK_TELEGRAM_SESSION_IDLE_MS',
    description: 'Milliseconds of inactivity after which an idle AgentSession is closed and its memory freed. sessionData (model/cwd preferences) is kept in-memory and reloaded on demand from disk. Default: 14400000 (4 hours).',
    type: 'number',
    required: false,
    default: '14400000',
    example: '3600000',
    category: 'telegram',
  },
] as const satisfies readonly EnvVarMeta[];
