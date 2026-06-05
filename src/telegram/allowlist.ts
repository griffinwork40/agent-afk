/**
 * Chat-ID allowlist for the Telegram bot.
 *
 * Fail-closed: if the allowlist is empty (env var unset or no valid entries),
 * every update is rejected. Negative IDs (groups/channels) are supported.
 *
 * @module telegram/allowlist
 */

import type { Context, MiddlewareFn } from 'telegraf';

export type LogFn = (...args: unknown[]) => void;

/**
 * Parse a comma-separated list of chat IDs into a Set<number>.
 * Whitespace is trimmed; empty and non-numeric entries are skipped (with a
 * warning via `log`). Returns an empty set when the input is undefined/empty —
 * callers must treat that as "deny all".
 */
export function parseAllowedChatIds(
  raw: string | undefined,
  log: LogFn = () => {}
): Set<number> {
  const ids = new Set<number>();
  if (!raw) return ids;

  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Telegram group/channel IDs are negative integers, so allow a leading '-'.
    if (!/^-?\d+$/.test(trimmed)) {
      log('[allowlist] Ignoring non-numeric chat ID:', trimmed);
      continue;
    }
    ids.add(Number(trimmed));
  }
  return ids;
}

/**
 * Build a Telegraf middleware that drops updates from chat IDs outside the
 * allowlist. Missing `ctx.chat?.id` is also rejected — fail-closed.
 *
 * Rejected updates are silently dropped (no reply) to avoid confirming the
 * bot's presence to unauthorized probes; a verbose log line is emitted if a
 * `log` function is supplied.
 */
export function createAllowlistMiddleware(
  allowedIds: Set<number>,
  log: LogFn = () => {}
): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !allowedIds.has(chatId)) {
      log('[allowlist] Rejecting update from chat:', chatId ?? '<unknown>');
      return;
    }
    await next();
  };
}
