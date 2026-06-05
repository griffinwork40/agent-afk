/**
 * Handler for the `send_telegram` tool.
 *
 * Sends a Telegram message to the operator from inside an agent loop.
 * Delegates to the `push()` primitive from `src/telegram/push.ts` — same
 * raw-fetch path used by daemon crash-push and task-completion notifications.
 *
 * @module agent/tools/handlers/send-telegram
 */

import { env } from '../../../config/env.js';
import { push, type PushOptions, type PushResult } from '../../../telegram/push.js';
import type { ToolHandler } from '../types.js';
import { parseAllowedChatIds } from '../../../telegram/allowlist.js';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

type PushFn = (options: PushOptions) => Promise<PushResult>;

export function createSendTelegramHandler(
  pushFn: PushFn = push,
): ToolHandler {
  return async (input, _signal) => {
    if (!input || typeof input !== 'object') {
      return { content: 'Invalid input: expected an object', isError: true };
    }

    const obj = input as Record<string, unknown>;
    const message = obj['message'];

    if (typeof message !== 'string') {
      return { content: 'Invalid input: message must be a string', isError: true };
    }

    if (message.length === 0) {
      return { content: 'Invalid input: message must be non-empty', isError: true };
    }

    if (message.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      return {
        content:
          `Invalid input: message exceeds Telegram's ${TELEGRAM_MAX_MESSAGE_LENGTH}-character limit ` +
          `(got ${message.length}). Split into multiple sends or trim before calling.`,
        isError: true,
      };
    }

    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return {
        content:
          'Telegram is not configured: TELEGRAM_BOT_TOKEN is not set. ' +
          'Run the bot setup wizard or export the env var before using send_telegram.',
        isError: true,
      };
    }

    const allowedIds = parseAllowedChatIds(env.AFK_TELEGRAM_ALLOWED_CHAT_IDS);
    if (allowedIds.size === 0) {
      return {
        content:
          'Telegram is not configured: AFK_TELEGRAM_ALLOWED_CHAT_IDS is empty or unset. ' +
          'Add the operator chat ID(s) before using send_telegram.',
        isError: true,
      };
    }

    const targets = [...allowedIds];
    const failures: string[] = [];

    for (const chatId of targets) {
      const result = await pushFn({ token: botToken, chatId, text: message });
      if (!result.ok) {
        failures.push(`chat ${chatId}: ${result.errorMessage ?? `HTTP ${result.status}`}`);
      }
    }

    if (failures.length === targets.length) {
      return {
        content: `Failed to send Telegram message to any chat. ${failures.join('; ')}`,
        isError: true,
      };
    }

    if (failures.length > 0) {
      const sent = targets.length - failures.length;
      return {
        content:
          `Sent Telegram message to ${sent}/${targets.length} chat(s); ` +
          `${failures.length} failed: ${failures.join('; ')}`,
      };
    }

    return {
      content:
        targets.length === 1
          ? `Sent Telegram message to chat ${targets[0]}.`
          : `Sent Telegram message to ${targets.length} chats.`,
    };
  };
}

export const sendTelegramHandler: ToolHandler = createSendTelegramHandler();
