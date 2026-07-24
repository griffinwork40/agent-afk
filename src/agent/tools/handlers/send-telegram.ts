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
import {
  resolveConfiguredNotifyTargets,
  resolveChatTarget,
  loadChatAliases,
} from '../../../telegram/notify-routing.js';
import { parseAllowedChatIds, isChatAllowed } from '../../../telegram/allowlist.js';

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
    const chat = obj['chat'];

    if (typeof message !== 'string') {
      return { content: 'Invalid input: message must be a string', isError: true };
    }

    if (chat !== undefined && typeof chat !== 'number' && typeof chat !== 'string') {
      return {
        content: 'Invalid input: chat must be a number (chat id) or string (chat id or alias name)',
        isError: true,
      };
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

    // Target resolution.
    //   - `chat` omitted → default routing (byte-identical to legacy behavior):
    //     resolveConfiguredNotifyTargets() (primary/broadcast/custom).
    //   - `chat` present → resolve the alias/number to a single id, then
    //     FAIL-CLOSED against the inbound allowlist. This gate does NOT apply to
    //     the default path, so custom-mode broadcast targets keep their
    //     intentional allowlist-independence.
    let targets: number[];
    if (chat !== undefined) {
      const resolved = resolveChatTarget(chat, loadChatAliases());
      if (!resolved.ok) {
        return { content: resolved.message, isError: true };
      }
      const allowlist = parseAllowedChatIds(env.AFK_TELEGRAM_ALLOWED_CHAT_IDS);
      if (!isChatAllowed(resolved.id, allowlist)) {
        const allowed = [...allowlist];
        return {
          content:
            `Refusing to send: chat ${resolved.id} is not in the allowlist ` +
            `(AFK_TELEGRAM_ALLOWED_CHAT_IDS). ` +
            (allowed.length > 0
              ? `Allowed chat id(s): ${allowed.join(', ')}. `
              : 'The allowlist is empty or unset. ') +
            'Add the chat id to the allowlist before targeting it.',
          isError: true,
        };
      }
      targets = [resolved.id];
    } else {
      targets = resolveConfiguredNotifyTargets();
    }

    if (targets.length === 0) {
      return {
        content:
          'Telegram is not configured: AFK_TELEGRAM_ALLOWED_CHAT_IDS is empty or unset. ' +
          'Add the operator chat ID(s) before using send_telegram.',
        isError: true,
      };
    }

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
