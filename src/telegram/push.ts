/**
 * Telegram outbound push primitive.
 *
 * Standalone pure function — no coupling to `TelegramBot` (which owns inbound
 * polling, session lifecycle, and command routing). Use this from anywhere
 * that needs to send an out-of-band notification to a known chat (daemon
 * task completion, crash alerts, scheduled digests).
 *
 * Routing reads `TELEGRAM_BOT_TOKEN` and `AFK_TELEGRAM_ALLOWED_CHAT_IDS`
 * from env. If either is unset, `pushIfConfigured` returns silently —
 * callers shouldn't have to gate every call site.
 *
 * @module telegram/push
 */

import type { InlineKeyboardMarkup } from 'telegraf/types';

import { parseAllowedChatIds } from './allowlist.js';
import { splitLongMessage } from './formatter.js';
import { env } from '../config/env.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

export interface PushOptions {
  token: string;
  chatId: string | number;
  text: string;
  /** Optional parse mode. Telegram supports 'MarkdownV2' | 'HTML' | 'Markdown'. */
  parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown';
  /**
   * Optional inline keyboard (or other reply markup). Forwarded verbatim as
   * the `reply_markup` field on Telegram's `sendMessage`. Callers that want
   * inline buttons attach an `InlineKeyboardMarkup` here; everything else
   * (force reply, custom keyboards) is intentionally out of scope today and
   * can be added by widening the union when needed.
   */
  replyMarkup?: InlineKeyboardMarkup;
  /** Override fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override API base (tests). */
  apiBase?: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** Telegram-returned error description on failure. */
  errorMessage?: string;
}

/**
 * POST to Telegram's `sendMessage`. Resolves with the result regardless of
 * outcome — never throws on HTTP failure. Throws only on programming errors
 * (missing required args).
 *
 * Truncates `text` to 4096 chars (Telegram's hard limit).
 */
export async function push(options: PushOptions): Promise<PushResult> {
  if (!options.token) throw new Error('push: token is required');
  if (options.chatId === '' || options.chatId == null || options.chatId === 0) {
    throw new Error('push: chatId is required');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? TELEGRAM_API_BASE;
  const url = `${apiBase}/bot${options.token}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: options.chatId,
    text: options.text.slice(0, 4096),
  };
  if (options.parseMode) body['parse_mode'] = options.parseMode;
  if (options.replyMarkup) body['reply_markup'] = options.replyMarkup;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.ok) {
      return { ok: true, status: response.status };
    }
    let errorMessage: string | undefined;
    try {
      const json = (await response.json()) as { description?: string };
      errorMessage = json.description;
    } catch {
      errorMessage = `HTTP ${response.status}`;
    }
    return {
      ok: false,
      status: response.status,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Push to every chat in `AFK_TELEGRAM_ALLOWED_CHAT_IDS`, splitting long text
 * into sequential Telegram-safe messages. Returns `null` if unconfigured (so
 * callers don't need to gate every call site).
 */
export async function pushIfConfigured(
  text: string,
  opts: {
    parseMode?: PushOptions['parseMode'];
    replyMarkup?: PushOptions['replyMarkup'];
    fetchImpl?: typeof fetch;
  } = {},
): Promise<PushResult[] | null> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const chatIds = parseAllowedChatIds(env.AFK_TELEGRAM_ALLOWED_CHAT_IDS);
  if (chatIds.size === 0) return null;

  const chunks = splitLongMessage(text);
  const results: PushResult[] = [];
  for (const chatId of chatIds) {
    for (let i = 0; i < chunks.length; i++) {
      results.push(await push({
        token,
        chatId,
        text: chunks[i] ?? '',
        ...(opts.parseMode !== undefined ? { parseMode: opts.parseMode } : {}),
        ...(opts.replyMarkup !== undefined && i === 0 ? { replyMarkup: opts.replyMarkup } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      }));
    }
  }
  return results;
}
