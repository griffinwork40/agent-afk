/**
 * Per-event-type handlers for the Telegram streaming handler
 *
 * Named handler functions for `paused`, `resumed`, `done`, and `error`
 * `OutputEvent` types, extracted from `streamResponse` in streaming.ts.
 * Each takes an explicit `StreamState` bag rather than closing over the outer
 * scope, mirroring the pattern in `src/agent/session/stream-consumer.ts`.
 * Extracted from streaming.ts — the public surface of streaming.ts is unchanged.
 * @module telegram/streaming.handlers
 */

import { TelegramError } from 'telegraf';
import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { splitLongMessage, markdownToTelegramHtml } from './formatter.js';
import { sendOrEdit, deliverClean, DELIVERY_TRUNCATED_NOTICE } from './streaming.sender.js';
import type { SenderState } from './streaming.sender.js';
import { computeFinalBody } from './streaming.body.js';
import type { ProgressEntry } from './streaming.preview.js';
import { replyWithFloodRetry as replyWithFloodRetryImpl } from './streaming.retry.js';
import type { ResponseMetadata } from '../agent/types.js';

/** Countdown update granularity during a usage-limit pause: every 5 minutes. */
export const PAUSE_COUNTDOWN_INTERVAL_MS = 5 * 60 * 1_000;
/** Extra slack (ms) added to the timeout deadline while paused. */
export const PAUSE_SLACK_MS = 90_000;

/**
 * Full mutable state bag for a streaming turn. Passed by reference so handlers
 * can update shared mutable fields that the main event loop depends on.
 */
export interface StreamState extends SenderState {
  // Inherited from SenderState: sentMessage, lastEditAt
  accumulated: string;
  answerText: string;
  pausedUntil: Date | null;
  countdownInterval: ReturnType<typeof setInterval> | null;
  editInFlight: boolean;
  lastCountdownBucket: number;
  sawTerminalEvent: boolean;
  progressEntries: ProgressEntry[];
  progressRounds: number;
  turnEnded: boolean;
  progressTimer: ReturnType<typeof setTimeout> | null;
  turnStartedAt: number;
}

/** Parameters shared across all event handlers. */
export interface HandlerParams {
  state: StreamState;
  ctx: Context;
  chatId: number;
  cleanFinal: boolean;
  livePreview: () => string;
  finalBody: () => string;
  clearProgressTimer: () => void;
  renderActivityReceipt: (toolRounds: number, elapsedMs: number) => string;
  onComplete?: (assistantText: string, metadata?: ResponseMetadata) => void | Promise<void>;
  logger?: (...args: unknown[]) => void;
}

/**
 * Handle a `paused` event — usage-limit pause. Renders a countdown message and
 * arms a periodic interval to keep the Telegram message current without flooding
 * the edit API. Only arms the countdown when `autoResume` is true (when the
 * provider will NOT auto-resume, a live countdown is meaningless because the
 * session is effectively stopped — Telegram parity with render.ts:542-554).
 */
export async function handlePaused(
  event: {
    resetsAt?: Date | null;
    autoResume?: boolean;
    accountId?: string;
  },
  params: HandlerParams,
): Promise<void> {
  const { state, ctx, chatId } = params;
  state.pausedUntil = event.resetsAt ?? null;
  const autoResume = event.autoResume ?? true;
  const minutesRemaining = state.pausedUntil !== null
    ? Math.max(0, Math.ceil((state.pausedUntil.getTime() - Date.now()) / 60_000))
    : null;
  const timeStr = state.pausedUntil !== null
    ? state.pausedUntil.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    : null;
  const accountLine = event.accountId ? `\n\nAccount: ${event.accountId}` : '';
  const pauseMsg = timeStr !== null && minutesRemaining !== null
    ? autoResume
      ? `⏸ **Usage paused**${accountLine}\n\nResets at ${timeStr} (in ~${minutesRemaining} min).\n\nI'll auto-resume when the limit resets — no need to retype.`
      : `⏸ **Usage paused**${accountLine}\n\nResets at ${timeStr} (in ~${minutesRemaining} min).\n\nWait for the limit to reset, then send again — or abort and retry later.`
    : autoResume
      ? `⏸ **Usage paused**${accountLine}\n\nNo reset time available. I'll resume automatically if you log in with a different Claude account — or abort and retry later.`
      : `⏸ **Usage paused**${accountLine}\n\nNo reset time available. Wait for the limit to reset, then send again — or abort and retry later.`;
  await sendOrEdit(state, ctx, chatId, pauseMsg, true);

  if (state.pausedUntil !== null && autoResume) {
    state.lastCountdownBucket = minutesRemaining !== null ? Math.floor(minutesRemaining / 5) : -1;
    state.countdownInterval = setInterval(() => {
      if (state.pausedUntil === null || state.editInFlight) return;
      const remaining = Math.max(0, Math.ceil((state.pausedUntil!.getTime() - Date.now()) / 60_000));
      const bucket = Math.floor(remaining / 5);
      if (bucket !== state.lastCountdownBucket) {
        state.lastCountdownBucket = bucket;
        const ts = state.pausedUntil!.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
        const msg = `⏸ **Usage paused**\n\nResets at ${ts} (in ~${remaining} min).\n\nI'll auto-resume when the limit resets — no need to retype.`;
        state.editInFlight = true;
        void sendOrEdit(state, ctx, chatId, msg, true).finally(() => { state.editInFlight = false; });
      }
    }, PAUSE_COUNTDOWN_INTERVAL_MS);
  }
}

/**
 * Handle a `resumed` event — clear the usage-limit countdown and show a
 * "Resumed" edit.
 */
export async function handleResumed(
  event: { hotSwapped?: boolean; accountId?: string },
  params: HandlerParams,
): Promise<void> {
  const { state, ctx, chatId } = params;
  if (state.countdownInterval !== null) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  state.pausedUntil = null;
  const resumeMsg = event.hotSwapped && event.accountId
    ? `▶ **Resumed on ${event.accountId}**`
    : '▶ **Resumed**';
  await sendOrEdit(state, ctx, chatId, resumeMsg, true);
}

/**
 * Handle a `done` event — deliver the final answer (cleanFinal or in-place),
 * invoke `onComplete`, and mark the turn as finished.
 *
 * Returns `true` to signal the main event loop to break.
 */
export async function handleDone(
  metadata: ResponseMetadata | undefined,
  params: HandlerParams,
): Promise<true> {
  const {
    state, ctx, chatId, cleanFinal, finalBody, clearProgressTimer,
    onComplete, logger, renderActivityReceipt,
  } = params;
  state.sawTerminalEvent = true;
  state.turnEnded = true;
  clearProgressTimer();
  if (state.countdownInterval !== null) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  if (cleanFinal && state.answerText.trim()) {
    // Deliver the answer as a fresh, noise-free message, then remove the
    // live preview so the conversation ends on a single clean reply. Only
    // delete the preview if something actually landed — if the very first
    // chunk failed, `delivered` is false and the frozen preview must
    // survive so the user is never left with zero visible content.
    // The receipt is appended at DELIVERY only, never to `answerText`
    // itself: `answerText` is what onComplete records into the resumable
    // session store below, and a UI receipt there would corrupt the
    // stored transcript (and be replayed by `afk --resume`).
    const delivered = await deliverClean(
      ctx,
      state.answerText + renderActivityReceipt(state.progressRounds, Date.now() - state.turnStartedAt),
    );
    if (delivered && state.sentMessage) {
      await ctx.telegram.deleteMessage?.(chatId, state.sentMessage.message_id).catch(() => {});
      // Null the preview ref so the post-loop overflow block (which would
      // otherwise re-send the noisy `accumulated` buffer) is skipped.
      state.sentMessage = null;
    }
  } else if (finalBody().trim()) {
    // Invariant: a turn must never end on the bare `Thinking…` placeholder.
    // finalBody() is `accumulated` PLUS the ungated progress region, so a
    // progress-only turn whose lines the gate withheld still delivers them
    // (`accumulated` alone is empty there). Covers the plain non-cleanFinal
    // path and the cleanFinal-with-no-answer path in one branch.
    await sendOrEdit(state, ctx, chatId, finalBody(), true);
  }
  // Record the completed turn into the shared session store (Telegram
  // → CLI resume). answerText is the noise-free assistant answer.
  if (onComplete) {
    try {
      await onComplete(state.answerText, metadata);
    } catch (e) {
      logger?.('streamResponse onComplete (turn recording) failed:', e);
    }
  }
  return true;
}

/**
 * Handle an `error` event — the provider already emitted a terminal error and
 * parked itself, so no interrupt() is needed (and would wrongly abort the
 * NEXT turn). Marks the turn as finished and throws the error.
 */
export function handleError(error: unknown, params: HandlerParams): never {
  const { state, clearProgressTimer } = params;
  // The provider already emitted a terminal error and parked itself, so
  // no interrupt() is needed (and would wrongly abort the NEXT turn).
  state.sawTerminalEvent = true;
  state.turnEnded = true;
  clearProgressTimer();
  if (state.countdownInterval !== null) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  throw error;
}

/**
 * Post-loop overflow delivery: sends chunks[1..] as fresh replies when `done`
 * fired with `sendOrEdit` (which only ever renders chunk[0] into the preview).
 *
 * The gate is the exact negation of the `done` handler's own
 * `cleanFinal && answerText.trim()` guard: it fires for every case where that
 * handler took its `sendOrEdit` branch instead of `deliverClean` — the plain
 * non-cleanFinal path, AND a cleanFinal turn whose `answerText` is empty (e.g. a
 * progress-only turn that produced no final assistant text, only accumulated `◦`
 * status lines). A bare `!cleanFinal` gate (the original #623 fix) wrongly excluded
 * that second case too, silently truncating a long progress-only cleanFinal turn to
 * chunk[0] — flagged independently by this repo's own review pipeline and Codex
 * (PR #626 review). It still correctly excludes a FAILED deliverClean (first chunk
 * fails past retries): that case has `cleanFinal && answerText.trim()` true
 * regardless of delivery outcome, so `!(...)` is false and this branch is skipped —
 * preserving the original #623 fix (no contradictory resend after the truncation
 * notice `deliverClean` already posted).
 * Must split the SAME text the `done` handler flushed (finalBody, which
 * includes the progress region) or chunks[1..] would not line up with the
 * chunk[0] already rendered into the preview.
 */
export async function deliverOverflow(
  ctx: Context,
  cleanFinal: boolean,
  answerText: string,
  finalBodyText: string,
  preview: Message.TextMessage | null,
): Promise<void> {
  if (!(!(cleanFinal && answerText.trim()) && finalBodyText && preview)) return;
  const chunks = splitLongMessage(markdownToTelegramHtml(finalBodyText));
  if (chunks.length <= 1) return;
  const reply = (t: string, extra?: { parse_mode?: 'HTML' }): Promise<unknown> => ctx.reply(t, extra);
  try {
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk) await replyWithFloodRetryImpl(reply, chunk, { parse_mode: 'HTML' });
    }
  } catch (e) {
    if (e instanceof TelegramError) {
      // Flood-control that outlived our retries, or another Telegram
      // transport failure: chunk[0] already lives in the (undeleted)
      // preview, so announce the dropped tail instead of throwing it
      // uncaught into the `finally` and silently losing it — the exact
      // bug this PR set out to kill, for the non-cleanFinal path.
      await ctx.reply(DELIVERY_TRUNCATED_NOTICE).catch(() => {});
    } else {
      throw e;
    }
  }
}

// Re-export computeFinalBody for use in streaming.ts so it doesn't need an
// additional sibling import just for the inline finalBody closure.
export { computeFinalBody };
