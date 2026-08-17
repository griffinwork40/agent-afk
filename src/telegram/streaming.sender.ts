/**
 * Telegram message send/edit helpers for the streaming handler
 *
 * `sendOrEdit` (throttled in-place preview edit) and `deliverClean`
 * (fresh multi-chunk delivery for the `cleanFinal` path) extracted from
 * `streamResponse` in streaming.ts. Both are module-level functions that take
 * explicit state parameters instead of closing over the outer scope.
 * Extracted from streaming.ts — the public surface of streaming.ts is unchanged.
 * @module telegram/streaming.sender
 */

import type { Context } from 'telegraf';
import { TelegramError } from 'telegraf';
import type { Message } from 'telegraf/types';
import { splitLongMessage, markdownToTelegramHtml } from './formatter.js';
import {
  floodRetryAfterMs,
  realSleep,
  replyWithFloodRetry as replyWithFloodRetryImpl,
} from './streaming.retry.js';

/** Minimum interval (ms) between Telegram edit requests to avoid rate limits */
export const EDIT_THROTTLE_MS = 300;

/**
 * Shown as a fresh message when Telegram refuses part of a multi-message reply
 * (flood-control that outlived our retries, or another transport failure) so the
 * dropped tail is VISIBLE instead of silently lost — the long-reply cutoff bug.
 */
export const DELIVERY_TRUNCATED_NOTICE =
  '⚠️ Telegram dropped part of this reply (rate limit) — ask me to resend it.';

/**
 * Mutable state slice consumed by `sendOrEdit`. Extracted so the sender can
 * update `sentMessage` and `lastEditAt` without closing over outer variables.
 */
export interface SenderState {
  sentMessage: Message.TextMessage | null;
  lastEditAt: number;
}

/**
 * Send the first message or throttled-edit the in-place preview.
 *
 * markdownToTelegramHtml runs 8 serial regex passes over the full accumulated
 * string (O(input length)). With ~200 chunks in a 4000-char response, calling
 * it unconditionally here would mean ~800k char-ops for ~13 actual Telegram
 * edits. Move the conversion to AFTER the throttle gate so it only runs when
 * we are actually going to send something to Telegram.
 *
 * Module-level replacement for the former inner closure `sendOrEdit` in
 * `streamResponse`. Takes explicit state to avoid closing over mutable outer
 * variables.
 */
export async function sendOrEdit(
  state: SenderState,
  ctx: Context,
  chatId: number,
  text: string,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!state.sentMessage) {
    const html = markdownToTelegramHtml(text || '…');
    const chunks = splitLongMessage(html);
    try {
      state.sentMessage = await ctx.reply(chunks[0] ?? '…', { parse_mode: 'HTML' });
    } catch (e) {
      if (e instanceof TelegramError && e.code === 400 && /can't parse entities/i.test(e.description ?? '')) {
        // Malformed HTML from formatter — retry without parse_mode using raw text as fallback
        state.sentMessage = await ctx.reply(text || '…');
      } else {
        throw e;
      }
    }
    return;
  }
  if (!force && now - state.lastEditAt < EDIT_THROTTLE_MS && text.length < 100) {
    return;
  }
  state.lastEditAt = now;
  const html = markdownToTelegramHtml(text || '…');
  const chunks = splitLongMessage(html);
  try {
    await ctx.telegram.editMessageText(
      chatId,
      state.sentMessage.message_id,
      undefined,
      chunks[0] ?? html,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    if (e instanceof TelegramError && e.code === 400 && /can't parse entities/i.test(e.description ?? '')) {
      // Malformed HTML from formatter — retry without parse_mode using raw text as fallback
      try {
        await ctx.telegram.editMessageText(
          chatId,
          state.sentMessage.message_id,
          undefined,
          text
        );
      } catch {
        // Plain-text retry also failed (e.g. unchanged content); ignore
      }
    } else {
      // Retry Telegram flood-control (429) once so in-turn edits survive
      // the rapid edit bursts subagent tool calls produce. Without this,
      // the preview message freezes and the user sees no further updates.
      const waitMs = floodRetryAfterMs(e);
      if (waitMs !== null) {
        const preSleepEdit = state.lastEditAt;
        await realSleep(waitMs);
        // If a newer edit landed while we slept (e.g. from a concurrent
        // fire-and-forget subagentSink call), our pre-sleep content is
        // stale — replaying it would revert the preview to an older state.
        if (state.lastEditAt !== preSleepEdit) {
          // Stale retry — a newer edit already updated the message; skip.
        } else {
          try {
            await ctx.telegram.editMessageText(
              chatId, state.sentMessage.message_id, undefined,
              chunks[0] ?? html, { parse_mode: 'HTML' },
            );
          } catch {
            // Retry exhausted — the edit is lost but the turn continues.
          }
        }
      }
      // Unchanged-content 400 and other non-429 errors: ignore (the edit
      // is cosmetic and the turn must not fail on a rendering hiccup).
    }
  }
}

/**
 * Deliver `text` as one or more fresh messages (used for cleanFinal). Mirrors
 * sendOrEdit's HTML-then-plaintext fallback so a formatter bug can never
 * swallow the final answer, and retries flood-control (429) so a long reply's
 * back-to-back sends aren't dropped mid-way. If Telegram still refuses a chunk
 * (retries exhausted, or another non-recoverable transport error), the chunks
 * already sent stand and a VISIBLE truncation notice is posted — never the old
 * silent `throw` that dropped the tail and showed the user nothing.
 *
 * Returns whether ANY content actually landed. Callers use this to gate
 * deleting the live preview: if the very first chunk fails, `delivered` is
 * still false and the preview must survive so the user is never left with
 * zero visible content (see the `done` and non-terminal-exit call sites).
 *
 * Module-level replacement for the former inner closure `deliverClean` in
 * `streamResponse`. Takes explicit state to avoid closing over mutable outer
 * variables.
 */
export async function deliverClean(ctx: Context, text: string): Promise<boolean> {
  let delivered = false;
  const reply = (t: string, extra?: { parse_mode?: 'HTML' }): Promise<unknown> => ctx.reply(t, extra);
  for (const chunk of splitLongMessage(text)) {
    if (!chunk) continue;
    try {
      for (const htmlChunk of splitLongMessage(markdownToTelegramHtml(chunk))) {
        if (htmlChunk) {
          await replyWithFloodRetryImpl(reply, htmlChunk, { parse_mode: 'HTML' });
          delivered = true;
        }
      }
    } catch (e) {
      if (e instanceof TelegramError && e.code === 400 && /can't parse entities/i.test(e.description ?? '')) {
        // Malformed HTML from the formatter — resend the raw chunk plain.
        try {
          await replyWithFloodRetryImpl(reply, chunk);
          delivered = true;
        } catch {
          // plain retry failed; ignore
        }
      } else if (e instanceof TelegramError) {
        // Flood-control that outlived our retries, or another Telegram transport
        // failure: the chunks before this one are delivered; the tail is not.
        // Announce it instead of silently dropping, then stop.
        await ctx.reply(DELIVERY_TRUNCATED_NOTICE).catch(() => {});
        return delivered;
      } else {
        throw e;
      }
    }
  }
  return delivered;
}
