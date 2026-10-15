/**
 * Telegram commands that delegate straight to a handler with no routing or
 * queueing logic of their own (/model, /cd, /name, /good, /bad, /afk, /usage).
 *
 * Extracted from TelegramBot.setupHandlers() (200-line function ceiling).
 * Registration order is preserved exactly from the original inline block.
 */

import type { Telegraf } from 'telegraf';
import { handleCwd, handleModelSwitch, handleName } from './handlers/commands.js';
import { handleAfk } from './handlers/afk.js';
import { handleUsage } from './handlers/usage.js';
import { registerFeedbackCommands } from './bot.feedback-commands.js';
import type { SessionManager } from './session-manager.js';

type LogFn = (...args: unknown[]) => void;

export function registerDelegatingCommands(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot: Telegraf<any>,
  sessionManager: SessionManager,
  log: LogFn,
): void {
  bot.command('model', (ctx) =>
    handleModelSwitch(ctx, sessionManager, log)
  );
  // `/cd` is the primary; `/cwd` is an alias matching the gather-investigation
  // user-facing label. Both route to the same handler.
  bot.command(['cd', 'cwd'], (ctx) =>
    handleCwd(ctx, sessionManager, log)
  );
  bot.command('name', (ctx) =>
    handleName(ctx, sessionManager, log)
  );
  registerFeedbackCommands(bot, sessionManager, log);
  // /afk [on|off] — toggle autonomous mode for this chat's session. On the
  // always-on host, high-risk ops hard-refuse (not phone-approvable); see
  // handlers/afk.ts + docs/afk-telegram-native-host.md.
  bot.command('afk', (ctx) =>
    handleAfk(ctx, sessionManager, log)
  );
  // /usage — report the operator's Claude subscription usage (5-hour rolling
  // + 7-day windows) for this chat. See handlers/usage.ts.
  bot.command('usage', (ctx) =>
    handleUsage(ctx, log)
  );
}
