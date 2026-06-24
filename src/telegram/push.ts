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

import { resolveConfiguredNotifyTargets } from './notify-routing.js';
import { splitLongMessage, markdownToTelegramHtml } from './formatter.js';
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
 * Push agent-authored markdown to one chat as Telegram HTML, falling back to
 * plain text if Telegram rejects the rendered HTML ("can't parse entities").
 *
 * Out-of-band notifications (daemon task completions, the `send_telegram` tool,
 * digests) carry GitHub-flavored markdown. Sent through `push()` with no
 * `parse_mode`, Telegram renders the raw `**bold**` / `` `code` `` markers
 * verbatim instead of formatting them. This mirrors the interactive streaming
 * path's `deliverClean` resilience (src/telegram/streaming.ts): render to HTML,
 * split the rendered HTML back under Telegram's 4096-char limit, and if a
 * formatter edge case yields HTML Telegram won't parse, resend the original
 * text plain so the message is never silently dropped.
 */
export async function pushMarkdown(
  options: Omit<PushOptions, 'parseMode'>,
): Promise<PushResult> {
  const html = markdownToTelegramHtml(options.text);
  // Re-split the RENDERED html before sending: escaping (& → &amp;) and tag
  // injection (<b>, <code>) expand the text, so a chunk near the 4096 raw limit
  // can render past it — and push() hard-truncates at 4096, silently dropping
  // the tail. Splitting the html keeps every sendMessage within the limit.
  // Sends are sequential so Telegram preserves message order.
  const htmlChunks = splitLongMessage(html);
  let result: PushResult = { ok: true, status: 200 };
  for (const htmlChunk of htmlChunks) {
    result = await push({ ...options, text: htmlChunk, parseMode: 'HTML' });
    if (result.ok) continue;
    // Fall back to plain text ONLY on Telegram's parse-entities rejection — other
    // failures (rate limit, 403, network) must not trigger a duplicate send.
    if (
      result.status === 400 &&
      /can't parse entities/i.test(result.errorMessage ?? '')
    ) {
      // Resend the ORIGINAL raw text plain so nothing is dropped. Like
      // deliverClean, this may re-send a sub-chunk already accepted above — a
      // rare edge (multi-chunk render + mid-stream parse failure) accepted
      // over silent loss.
      return push({ ...options });
    }
    return result;
  }
  return result;
}

/**
 * Push a notification to the configured delivery targets, splitting long text
 * into sequential Telegram-safe messages. Targets are resolved by
 * `resolveConfiguredNotifyTargets()` — by default a single "primary" chat, not
 * the whole allowlist (see notify-routing.ts). Returns `null` if unconfigured
 * (no token, or no resolvable targets) so callers don't gate every call site.
 *
 * Set `markdown: true` for agent-authored content so each chunk is rendered to
 * Telegram HTML (with a plain-text fallback) instead of being shown verbatim;
 * leave it off for pre-formatted or markup-sensitive text (e.g. raw URLs).
 * `markdown` and `parseMode` are mutually exclusive — `markdown` wins.
 */
export async function pushIfConfigured(
  text: string,
  opts: {
    parseMode?: PushOptions['parseMode'];
    markdown?: boolean;
    replyMarkup?: PushOptions['replyMarkup'];
    fetchImpl?: typeof fetch;
  } = {},
): Promise<PushResult[] | null> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const chatIds = resolveConfiguredNotifyTargets();
  if (chatIds.length === 0) return null;

  // Split the RAW markdown first, then render each chunk — splitting already
  // rendered HTML could sever a tag mid-chunk and trip Telegram's parser.
  const chunks = splitLongMessage(text);
  const results: PushResult[] = [];
  for (const chatId of chatIds) {
    for (let i = 0; i < chunks.length; i++) {
      const base = {
        token,
        chatId,
        text: chunks[i] ?? '',
        ...(opts.replyMarkup !== undefined && i === 0 ? { replyMarkup: opts.replyMarkup } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      };
      results.push(
        opts.markdown
          ? await pushMarkdown(base)
          : await push({
              ...base,
              ...(opts.parseMode !== undefined ? { parseMode: opts.parseMode } : {}),
            }),
      );
    }
  }
  return results;
}
