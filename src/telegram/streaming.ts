/**
 * Streaming response handler for Telegram
 * Consumes session output stream and sends token/chunk-by-chunk updates to Telegram.
 * @module telegram/streaming
 */

import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { StreamTimeoutError } from './stream-timeout-error.js';
import type { IAgentSession, ResponseMetadata } from '../agent/types.js';
import { runWithSink } from '../agent/_lib/skill-sink-channel.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import {
  formatTelegramActivity,
  formatTelegramAgentLabel,
  renderSubagentFooter,
} from './streaming.activity.js';
import {
  computeLivePreview,
} from './streaming.preview.js';
import type { ProgressEntry } from './streaming.preview.js';
import { computeFinalBody } from './streaming.body.js';
import { sendOrEdit } from './streaming.sender.js';
import {
  type StreamState, type HandlerParams,
} from './streaming.handlers.js';
import {
  makeNextWithTimeout, PROGRESS_START_DELAY_MS, type WatchdogState,
} from './streaming.watchdog.js';
import { makeSubagentSink } from './streaming.progress.js';
import { buildStream, runStreamLoop } from './streaming.loop.js';
import type { ContentRunState } from './streaming.loop.js';

// Backward-compat re-exports: extracted to sibling modules but callers still
// import from this file. StreamTimeoutError is in its own module so
// `instanceof` survives a `vi.mock` of './streaming.js' in tests.
export { formatTelegramActivity, formatTelegramAgentLabel, renderSubagentFooter };
export { replyWithFloodRetry } from './streaming.retry.js';
export { renderProgressRegion, renderInterleavedPreview } from './streaming.preview.js';
export type { ProgressEntry } from './streaming.preview.js';
export { StreamTimeoutError };

/**
 * One-line activity receipt appended to the CLEAN final message, replacing the
 * `◦` progress log that cleanFinal deletes: the turn's cost stays visible
 * without the per-round noise. Empty when no tool work happened, so plain
 * question/answer turns are unchanged.
 *
 * Plain text on purpose — `markdownToTelegramHtml` escapes `<`/`>` before
 * injecting its own fixed tag set (formatter.ts), so any HTML written here
 * would reach the user as literal visible markup.
 *
 * Invariant: must NOT use the `◦` prefix. In this module `◦` marks live
 * progress/status noise that cleanFinal exists to strip, and tests assert the
 * delivered answer contains no `◦` at all. The receipt is a distinct concept
 * (a kept summary, not stripped noise) and carries its own marker.
 */
export function renderActivityReceipt(toolRounds: number, elapsedMs: number): string {
  if (toolRounds <= 0) return '';
  const secs = Math.max(1, Math.round(elapsedMs / 1_000));
  return `\n\n⏱️ ${toolRounds} ${toolRounds === 1 ? 'step' : 'steps'} · ${secs}s`;
}



/**
 * Wrap `ctx.reply` to fire `onBotMessage(chatId, messageId)` each time a NEW
 * Telegram message is sent (not edits, which reuse an existing message_id).
 * Returns a shallow-prototype-delegating copy of `ctx` with an intercepted
 * reply method; leaves the original context object unmodified.
 */
function withReplyTracking(
  ctx: Context,
  chatId: number,
  onBotMessage: (chatId: number, messageId: number) => void,
): Context {
  const orig = ctx.reply.bind(ctx) as typeof ctx.reply;
  return Object.create(ctx, {
    reply: {
      value: async (...args: Parameters<typeof ctx.reply>) => {
        const msg = await orig(...args);
        try { onBotMessage(chatId, (msg as { message_id?: number }).message_id ?? 0); } catch { /* non-fatal */ }
        return msg;
      },
      configurable: true, writable: true,
    },
  }) as Context;
}

/**
 * Options bag for {@link streamResponse}.
 *
 * `onComplete` — fired once when the turn finishes successfully (`done` event)
 * with the assistant text and turn metadata. Used to persist the turn to the
 * shared session store. Never fires on error / timeout paths.
 *
 * `progressDelayMs` — how long before `◦` progress lines start rendering.
 * Defaults to PROGRESS_START_DELAY_MS. Pass 0 to render immediately.
 *
 * `onBotMessage` — fired each time the bot sends a FRESH Telegram message
 * (preview placeholder and each cleanFinal chunk). Receives (chatId, messageId).
 * Used to map bot message ids → session ids for thumbs-reaction feedback.
 * Not called for edits (those reuse an existing message_id). Non-fatal: errors
 * in the callback are silently swallowed so delivery is never disrupted.
 */
export interface StreamResponseOptions {
  cleanFinal?: boolean;
  onComplete?: (assistantText: string, metadata?: ResponseMetadata) => void | Promise<void>;
  progressDelayMs?: number;
  onBotMessage?: (chatId: number, messageId: number) => void;
}

/**
 * Stream agent response back to Telegram by consuming getOutputStream() / sendMessageStream.
 * Sends an initial placeholder, then edits it with accumulated content as chunks arrive.
 * Splits into multiple messages if the response exceeds Telegram's length limit.
 * Times out if the SDK never sends an event (e.g. subprocess hang or auth issue).
 *
 * When `content` is a ContentBlockParam array (e.g. photo + caption), the
 * non-streaming fallback is skipped unconditionally — sendMessage only accepts
 * strings, and vision content must travel through the streaming path to reach
 * the model as a proper multi-modal message.
 */
export async function streamResponse(
  ctx: Context,
  session: IAgentSession,
  content: string | ContentBlockParam[],
  logger?: (...args: unknown[]) => void,
  options: StreamResponseOptions = {}
): Promise<void> {
  if (!ctx.chat?.id) {
    logger?.('streamResponse: ctx.chat is undefined (non-chat context); skipping');
    return;
  }
  const chatId = ctx.chat.id;
  const cleanFinal = options.cleanFinal ?? false;
  const progressDelayMs = options.progressDelayMs ?? PROGRESS_START_DELAY_MS;

  // When onBotMessage is set, wrap ctx.reply to fire the hook on every new
  // send (edits reuse an existing message_id and are NOT intercepted).
  if (options.onBotMessage) ctx = withReplyTracking(ctx, chatId, options.onBotMessage);

  // Invariant: `accumulated` is NEVER mutated to carry `◦` progress lines — they
  // live only in `progressEntries` and are composed in at render time. An earlier
  // design rewrote a region INSIDE `accumulated` at an offset; because a following
  // content chunk froze that region in place, every later progress event started a
  // new one, so the MAX_PROGRESS_LINES bound held only within a run of CONSECUTIVE
  // progress events. Trimming over the ENTRY LIST keeps the bound global.
  // The live preview interleaves those entries chronologically (computeLivePreview);
  // `finalBody` deliberately keeps the legacy trailing footer, because it IS
  // delivered on a progress-only or non-terminal-exit turn and is held byte-stable.
  const state: StreamState = {
    accumulated: '', answerText: '',
    sentMessage: null as Message.TextMessage | null,
    lastEditAt: 0, pausedUntil: null, countdownInterval: null,
    editInFlight: false, lastCountdownBucket: -1, sawTerminalEvent: false,
    progressEntries: [] as ProgressEntry[], progressRounds: 0,
    turnEnded: false, progressTimer: null, turnStartedAt: Date.now(),
  };

  // stream_retry rollback: snapshot accumulator lengths at the start of the
  // current content run so a mid-stream overload re-drive discards only the
  // round's partial text (the model re-streams from scratch).
  const run: ContentRunState = {
    contentRunStartAccumulated: 0,
    contentRunStartAnswer: 0,
    inContentRun: false,
  };

  const watchdog: WatchdogState = {
    receivedAny: false, timedOut: false, lastActivityAt: Date.now(),
    inFlightTools: new Set<string>(), toolInFlightSince: null,
    get pausedUntil() { return state.pausedUntil; },
    apiRoundInFlight: false, apiRoundSince: null,
  };

  const subagentState = { subagentSteps: 0, recentSubagentSteps: [] as string[] };
  let progressGateOpen = progressDelayMs <= 0;

  const clearProgressTimer = (): void => {
    if (state.progressTimer !== null) { clearTimeout(state.progressTimer); state.progressTimer = null; }
  };

  const livePreview = (): string => computeLivePreview({
    accumulated: state.accumulated, progressEntries: state.progressEntries,
    progressGateOpen, subagentSteps: subagentState.subagentSteps,
    recentSubagentSteps: subagentState.recentSubagentSteps,
  });
  const finalBody = (): string => computeFinalBody({ accumulated: state.accumulated, progressEntries: state.progressEntries });

  const handlerParams: HandlerParams = {
    state, ctx, chatId, cleanFinal, livePreview, finalBody, clearProgressTimer,
    renderActivityReceipt, onComplete: options.onComplete, logger,
  };

  try {
    const stream = buildStream(session, content);

    // Send placeholder immediately so user sees activity; avoids "silent hang" if SDK is slow
    await sendOrEdit(state, ctx, chatId, 'Thinking…');

    const iter = stream[Symbol.asyncIterator]();
    const nextWithTimeout = makeNextWithTimeout(iter, watchdog);
    const subagentSink = makeSubagentSink(
      state, ctx, chatId, livePreview,
      () => { watchdog.lastActivityAt = Date.now(); },
      subagentState,
    );

    try {
      // Intentional: post-loop finalization (deliverClean / deliverOverflow) runs
      // inside the runWithSink AsyncLocalStorage scope so skill-sink context is
      // still active during final delivery.
      await runWithSink(subagentSink, async () => {
        await runStreamLoop({
          nextWithTimeout, state, watchdog, run,
          ctx, chatId, livePreview, finalBody,
          progressGateOpen,
          progressDelayMs,
          setProgressGateOpen: (v) => { progressGateOpen = v; },
          clearProgressTimer,
          handlerParams,
          logger,
        });
      });
    } finally {
      // Park the still-running provider turn on ANY exit without a terminal event:
      // timeout, Telegram render exception, or early break. Without this, the provider
      // keeps streaming into the shared providerIterator with no consumer, and the NEXT
      // message drains those buffered events (the "send '.' to recover" bug). Must run
      // BEFORE iter.return(), which flips currentState to 'idle'.
      if (watchdog.timedOut || !state.sawTerminalEvent) {
        await Promise.resolve(session.interrupt?.()).catch(() => {});
      }
      // Stop the countdown timer on EVERY exit (incl. throw): previously cleared only
      // on done/error, so a timeout-throw while paused leaked an interval forever.
      if (state.countdownInterval !== null) { clearInterval(state.countdownInterval); state.countdownInterval = null; }
      state.turnEnded = true;
      clearProgressTimer();
      state.editInFlight = false;
      watchdog.apiRoundInFlight = false;
      watchdog.apiRoundSince = null;
      // Always close the generator so session.currentState resets to 'idle' only after
      // all Telegram messages are sent. Without this, a throw at event.type === 'error'
      // skips iter.return() and leaves the session permanently "busy".
      await Promise.resolve(iter.return?.(undefined)).catch(() => {});
    }
  } catch (error) {
    logger?.('Streaming error:', error);
    throw error;
  }
}
