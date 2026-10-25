/**
 * The command list shown in the Telegram UI (`setMyCommands`).
 *
 * Telegram-only commands come first (handlers registered in
 * TelegramBot.setupHandlers()); every shared command runnable under Telegram's
 * declared capabilities is derived from the slash registry, so the menu cannot
 * drift from what generic dispatch actually executes.
 */
import { FEEDBACK_COMMAND_DESCRIPTORS } from './bot.feedback-commands.js';
import { registryMenuDescriptors } from './slash-dispatch.telegram.js';

type Descriptor = { command: string; description: string };

export const TELEGRAM_ONLY_COMMAND_DESCRIPTORS: ReadonlyArray<Descriptor> = [
  { command: 'start', description: 'Show welcome and command list' },
  { command: 'cd', description: 'Show or change session working directory' },
  { command: 'sessions', description: 'List and switch between sessions' },
  { command: 'new', description: 'Start a new session (keeps the current one)' },
  ...FEEDBACK_COMMAND_DESCRIPTORS,
  { command: 'afk', description: 'Toggle autonomous (AFK) mode for this chat' },
  { command: 'watch', description: 'Live-tail a CLI session from this chat' },
  { command: 'unwatch', description: 'Stop watching a session' },
  { command: 'abort', description: 'Send a signed abort to the watched session' },
  { command: 'inbox', description: 'List, release, or drop held peer messages (AFK_PEER_INBOUND=hold)' },
  { command: 'insights', description: 'Show usage analytics and recommendations (optional: /insights <days>)' },
];

/** Telegram allows at most 100 menu commands per scope. */
export const TELEGRAM_MENU_LIMIT = 100;

/** Telegram-only + registry-derived descriptors, de-duplicated (Telegram-only wins). */
export async function botCommandDescriptors(): Promise<Descriptor[]> {
  const seen = new Set<string>();
  const out: Descriptor[] = [];
  for (const d of [...TELEGRAM_ONLY_COMMAND_DESCRIPTORS, ...(await registryMenuDescriptors())]) {
    if (seen.has(d.command)) continue;
    seen.add(d.command);
    out.push({ ...d });
  }
  return out.slice(0, TELEGRAM_MENU_LIMIT);
}
