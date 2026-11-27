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
 *   1. First `sendOrEditDraft` call: generate an integer `draft_id`, store it on
 *      `DraftState.draftId`, and send the initial draft via `sendMessageDraft`.
 *      `isDraftMode` is set to true only after the first API call succeeds.
 *   2. Subsequent calls: reuse the same `draft_id` (Telegram updates in place).
 *   3. `finalizeDraft`: send a plain `sendMessage` which replaces the draft,
 *      then clear the draft state so subsequent calls are no-ops.
 *
 * @module telegram/streaming.draft
 */

import { TelegramError } from 'telegraf';
import type { Context } from 'telegraf';
import { markdownToTelegramHtml, splitLongMessage } from './formatter.js';
import { floodRetryAfterMs, realSleep, replyWithFloodRetry as replyWithFloodRetryImpl } from './streaming.retry.js';

/** Throttle interval matching the 20-calls-per-5 s Bot API budget. */
export const DRAFT_THROTTLE_MS = 250;

/**
 * Mutable state slice for a draft streaming turn.
 * Stored alongside StreamState so handlers can finalize or clean up.
 */
export interface DraftState {
  /** Stable 32-bit signed positive integer sent as `draft_id` for every update in this turn. */
  draftId: number | null;
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
 * Generate a random positive 32-bit signed integer for use as `draft_id`.
 * Bot API requires a nonzero integer (32-bit signed).
 */
function generateDraftId(): number {
  return Math.floor(Math.random() * 2_147_483_647) + 1;
}

/**
 * Send or update a Telegram draft message for a private-chat streaming turn.
 *
 * On the first call: generates an integer `draft_id`, stores it on `state`, and
 * sends the initial draft.  On subsequent calls: reuses `state.draftId`.
 * Throttled at DRAFT_THROTTLE_MS; calls that arrive faster are skipped.
 * On 429 the function honors `retry_after` (capped at MAX_RETRY_AFTER_MS) and
 * retries once — same pattern as `sendOrEdit` in streaming.sender.ts.
 *
 * `isDraftMode` is set to `true` only after the first API call succeeds.
 * On API error the first call clears `draftId` so the next call retries.
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

  // Generate a draft_id on the first call (before throttle so we have an id
  // ready, but isDraftMode stays false until the API call succeeds).
  // Use strict null check: generateDraftId() always returns >= 1, but
  // draftId is typed `number | null` and 0 is not a valid draft_id anyway.
  if (state.draftId === null) {
    state.draftId = generateDraftId();
  }

  // Throttle gate: suppress calls that arrive faster than DRAFT_THROTTLE_MS.
  // Use lastDraftAt > 0 as the sentinel (not isDraftMode) so calls are also
  // suppressed after a 429 retry exhaustion — which stamps lastDraftAt but
  // leaves isDraftMode=false — preventing a burst against the rate-limit budget
  // immediately after recovery.  The very first call (lastDraftAt === 0) always
  // bypasses the gate so it always reaches the API.
  if (!force && state.lastDraftAt > 0 && now - state.lastDraftAt < DRAFT_THROTTLE_MS) {
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
 * Long messages are split to stay within the 4096-char Telegram limit.
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
  const reply = (t: string, extra?: { parse_mode?: 'HTML' }): Promise<unknown> =>
    ctx.telegram.sendMessage(chatId, t, extra);
  const chunks = splitLongMessage(html);
  try {
    for (const chunk of chunks) {
      if (chunk) await replyWithFloodRetryImpl(reply, chunk, { parse_mode: 'HTML' });
    }
  } catch (e) {
    if (
      e instanceof TelegramError &&
      e.code === 400 &&
      /can't parse entities/i.test(e.description ?? '')
    ) {
      // Entity-parse fallback: split the raw text and send plain.
      const plainChunks = splitLongMessage(text || '…');
      for (const chunk of plainChunks) {
        if (chunk) await replyWithFloodRetryImpl(reply, chunk);
      }
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
 * Call `sendMessageDraft` via `callApi`, updating `state.lastDraftAt` and
 * setting `state.isDraftMode = true` on success.  Retries once on 429
 * honoring `retry_after`, then gives up silently — a missed draft update is
 * cosmetic; the turn must not fail.
 *
 * On first-call failure, clears `draftId` so the next call retries cleanly.
 */
async function callDraftApi(
  ctx: Context,
  chatId: number,
  draftId: number,
  html: string,
  state: DraftState,
): Promise<void> {
  const params = {
    chat_id: chatId,
    text: html,
    draft_id: draftId,
    parse_mode: 'HTML' as const,
    // can_stop: false — the bot controls the generation lifecycle; the user
    // cannot interrupt a draft-streaming turn mid-flight via the client UI.
    can_stop: false,
    // keep_on_stop: false — if the draft is somehow stopped, discard it rather
    // than leaving a stale draft visible in the chat.
    keep_on_stop: false,
  };

  try {
    await (ctx.telegram as unknown as { callApi: (method: string, params: unknown) => Promise<unknown> })
      .callApi('sendMessageDraft', params);
    state.lastDraftAt = Date.now();
    state.isDraftMode = true;
  } catch (e) {
    const waitMs = floodRetryAfterMs(e);
    if (waitMs !== null) {
      const cappedWait = Math.min(waitMs, MAX_DRAFT_RETRY_AFTER_MS);
      await realSleep(cappedWait);
      try {
        await (ctx.telegram as unknown as { callApi: (method: string, params: unknown) => Promise<unknown> })
          .callApi('sendMessageDraft', params);
        state.lastDraftAt = Date.now();
        state.isDraftMode = true;
      } catch {
        // Retry exhausted — the draft update is lost but the turn continues.
        // Set lastDraftAt so the next call doesn't burst immediately after
        // recovery (avoids hitting the 20/5 s budget on the next live update).
        state.lastDraftAt = Date.now();
        // Clear draftId so the next call starts fresh.
        state.draftId = null;
      }
    } else {
      // Non-429 errors (e.g. chat type mismatch): clear draftId and stamp
      // lastDraftAt so the throttle gate (keyed on lastDraftAt > 0) blocks the
      // immediate next call — without this, a first-call non-429 failure left
      // lastDraftAt === 0 and the next call bypassed the throttle entirely.
      state.draftId = null;
      state.lastDraftAt = Date.now();
    }
  }
}
