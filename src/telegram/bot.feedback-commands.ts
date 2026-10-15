/**
 * Wire /good and /bad Telegram commands onto a Telegraf instance.
 *
 * Extracted from bot.ts to keep TelegramBot.setupHandlers() under the
 * 200-line function ceiling. Registers handlers and adds the commands to
 * the setMyCommands array fragment so the Telegram UI shows them.
 */

import type { Telegraf } from 'telegraf';
import { handleGood, handleBad } from './handlers/feedback.js';
import type { SessionManager } from './session-manager.js';

type LogFn = (...args: unknown[]) => void;

/** Command descriptors to add to the setMyCommands list. */
export const FEEDBACK_COMMAND_DESCRIPTORS = [
  { command: 'good', description: 'Rate this session as succeeded' },
  { command: 'bad', description: 'Rate this session as failed' },
] as const;

/**
 * Register /good and /bad handlers on the given bot instance. Call once
 * during TelegramBot.setupHandlers() alongside the other command wirings.
 */
export function registerFeedbackCommands(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot: Telegraf<any>,
  sessionManager: SessionManager,
  log: LogFn,
): void {
  // /good [note] and /bad [note] — record explicit operator feedback on the
  // current session's VerifiedOutcome. Mirrors REPL /good and /bad.
  bot.command('good', (ctx) => handleGood(ctx, sessionManager, log));
  bot.command('bad', (ctx) => handleBad(ctx, sessionManager, log));
}
