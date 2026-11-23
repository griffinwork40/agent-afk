/**
 * Telegram sendMessageDraft sender for private-chat streaming
 *
 * Wraps Bot API 9.3+ `sendMessageDraft` / `stopMessageGenerationDraft` via
 * `ctx.telegram.callApi(...)`.  Private chats only — groups fall back to the
 * existing `sendOrEdit` path in streaming.sender.ts.
 *
 * Rate-limit contract (Bot API):
 *   - 20 calls per 5 s (= one call per 250 ms) per peer
 *   - 40 calls per 30 s per peer
 * We throttle at DRAFT_THROTTLE_MS (250 ms) to stay inside the 20/5 s budget.
 * On 429 we honor `retry_after` exactly as streaming.retry.ts does.
 *
 * Lifecycle:
 *   1. First `sendOrEditDraft` call: generate a UUID `draft_id`, store it on
 *      `DraftState.draftId`, and send the initial draft via `sendMessageDraft`.
 *   2. Subsequent calls: reuse the same `draft_id` (Telegram updates in place).
 *   3. `finalizeDraft`: send a plain `sendMessage` which replaces the draft,
 *      then clear the draft state so subsequent calls are no-ops.
 *
 * @module telegram/streaming.draft
 */

import { randomUUID } from 'crypto';
import { TelegramError } from 'telegraf';
import type { Context } from 'telegraf';
import { markdownToTelegramHtml } from './formatter.js';
import { floodRetryAfterMs, realSleep } from './streaming.retry.js';

/** Throttle interval matching the 20-calls-per-5 s Bot API budget. */
export const DRAFT_THROTTLE_MS = 250;

/**
 * Mutable state slice for a draft streaming turn.
 * Stored alongside StreamState so handlers can finalize or clean up.
 */
export interface DraftState {
  /** Stable UUID sent as `draft_id` for every update in this turn. */
  draftId: string | null;
  /** Timestamp (ms) of the most recent successful `sendMessageDraft` call. */
  lastDraftAt: number;
  /** True while this turn is using the draft path (private chat). */
  isDraftMode: boolean;
}

/** Build a fresh, zeroed DraftState for a new turn. */
export function makeDraftState(): DraftState {
  return { draftId: null, lastDraftAt: 0, isDraftMode: false };
}

/**
 * Send or update a Telegram draft message for a private-chat streaming turn.
 *
 * On the first call: generates a UUID `draft_id`, stores it on `state`, and
 * sends the initial draft.  On subsequent calls: reuses `state.draftId`.
 * Throttled at DRAFT_THROTTLE_MS; calls that arrive faster are skipped.
 * On 429 the function honors `retry_after` (capped at MAX_RETRY_AFTER_MS) and
 * retries once — same pattern as `sendOrEdit` in streaming.sender.ts.
 *
 * `force = true` bypasses the throttle gate (used for the final live update
 * before `finalizeDraft` is called).
 */
export async function sendOrEditDraft(
  state: DraftState,
  ctx: Context,
  chatId: number,
  text: string,
  force = false,
): Promise<void> {
  const now = Date.now();

  if (!state.draftId) {
    state.draftId = randomUUID();
    state.isDraftMode = true;
  }

  if (!force && now - state.lastDraftAt < DRAFT_THROTTLE_MS) {
    return;
  }

  const html = markdownToTelegramHtml(text || '…');
  await callDraftApi(ctx, chatId, state.draftId, html, state);
}

/**
 * Finalize the streaming turn by sending a plain `sendMessage` which replaces
 * the in-flight draft.  Clears `draftId` so subsequent calls are no-ops.
 *
 * Uses HTML parse mode and falls back to plain text on a 400 entity-parse
 * error — matching the resilience pattern of `deliverClean` in sender.ts.
 */
export async function finalizeDraft(
  state: DraftState,
  ctx: Context,
  chatId: number,
  text: string,
): Promise<void> {
  if (!state.isDraftMode) return;
  state.draftId = null;
  state.isDraftMode = false;

  const html = markdownToTelegramHtml(text || '…');
  try {
    await ctx.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' });
  } catch (e) {
    if (
      e instanceof TelegramError &&
      e.code === 400 &&
      /can't parse entities/i.test(e.description ?? '')
    ) {
      await ctx.telegram.sendMessage(chatId, text || '…');
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Upper bound on a single honored `retry_after` for draft calls. */
const MAX_DRAFT_RETRY_AFTER_MS = 30_000;

/**
 * Call `sendMessageDraft` via `callApi`, updating `state.lastDraftAt` on
 * success.  Retries once on 429 honoring `retry_after`, then gives up
 * silently — a missed draft update is cosmetic; the turn must not fail.
 */
async function callDraftApi(
  ctx: Context,
  chatId: number,
  draftId: string,
  html: string,
  state: DraftState,
): Promise<void> {
  const params = {
    chat_id: chatId,
    text: html,
    draft_id: draftId,
    parse_mode: 'HTML' as const,
    can_stop: false,
    keep_on_stop: false,
  };

  try {
    await (ctx.telegram as unknown as { callApi: (method: string, params: unknown) => Promise<unknown> })
      .callApi('sendMessageDraft', params);
    state.lastDraftAt = Date.now();
  } catch (e) {
    const waitMs = floodRetryAfterMs(e);
    if (waitMs !== null) {
      const cappedWait = Math.min(waitMs, MAX_DRAFT_RETRY_AFTER_MS);
      await realSleep(cappedWait);
      try {
        await (ctx.telegram as unknown as { callApi: (method: string, params: unknown) => Promise<unknown> })
          .callApi('sendMessageDraft', params);
        state.lastDraftAt = Date.now();
      } catch {
        // Retry exhausted — the draft update is lost but the turn continues.
      }
    }
    // Non-429 errors (e.g. chat type mismatch): silently ignore.
    // The turn must not fail on a cosmetic draft update.
  }
}
