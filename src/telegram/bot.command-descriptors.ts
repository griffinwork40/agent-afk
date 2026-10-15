/**
 * The command list shown in the Telegram UI (`setMyCommands`).
 *
 * Extracted from bot.ts (350-code-line ceiling). Order is the display order.
 * Handlers are registered separately in TelegramBot.setupHandlers().
 */

import { FEEDBACK_COMMAND_DESCRIPTORS } from './bot.feedback-commands.js';

export const BOT_COMMAND_DESCRIPTORS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'start', description: 'Show welcome and command list' },
  { command: 'help', description: 'Show this command list' },
  { command: 'clear', description: 'Clear conversation history' },
  { command: 'compact', description: 'Compact conversation history' },
  { command: 'model', description: 'Switch Claude model (opus/sonnet/haiku)' },
  { command: 'cd', description: 'Show or change session working directory' },
  { command: 'name', description: 'Show or set the session name' },
  ...FEEDBACK_COMMAND_DESCRIPTORS,
  { command: 'afk', description: 'Toggle autonomous (AFK) mode for this chat' },
  { command: 'usage', description: 'Show Claude subscription usage' },
  { command: 'watch', description: 'Live-tail a CLI session from this chat' },
  { command: 'unwatch', description: 'Stop watching a session' },
];
