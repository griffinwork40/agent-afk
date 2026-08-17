/**
 * Streaming response handler for Telegram
 * Consumes session output stream and sends token/chunk-by-chunk updates to Telegram.
 * @module telegram/streaming
 */

import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { StreamTimeoutError } from './stream-timeout-error.js';
import type { IAgentSession, OutputEvent, ResponseMetadata } from '../agent/types.js';
import { runWithSink } from '../agent/_lib/skill-sink-channel.js';
import { env } from '../config/env.js';
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
import { sendOrEdit, deliverClean } from './streaming.sender.js';
import {
  handlePaused, handleResumed, handleDone, handleError, deliverOverflow,
  type StreamState, type HandlerParams,
} from './streaming.handlers.js';
import {
  makeNextWithTimeout, PROGRESS_START_DELAY_MS, type WatchdogState,
} from './streaming.watchdog.js';
import { handleProgressEvent, makeSubagentSink } from './streaming.progress.js';

// Re-export so existing consumers (tests, other modules) keep importing from
// this module unchanged — the extraction is invisible to callers.
export { formatTelegramActivity, formatTelegramAgentLabel, renderSubagentFooter };
// Retry helpers — moved to streaming.retry.ts; re-exported for backward compat.
export { replyWithFloodRetry } from './streaming.retry.js';
// Preview helpers — moved to streaming.preview.ts; re-exported for backward compat.
export { renderProgressRegion, renderInterleavedPreview } from './streaming.preview.js';
export type { ProgressEntry } from './streaming.preview.js';

// StreamTimeoutError lives in its own module so the message handler's
// `instanceof` check survives `vi.mock('./streaming.js')` in tests (see
// stream-timeout-error.ts). Imported above for local use (the watchdog throws
// it); re-exported here so callers/tests that import it from the streaming
// module keep working.
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
  options: {
    cleanFinal?: boolean;
    /**
     * Fired once when the turn completes successfully (the `done` event),
     * with the assistant's answer text and the turn metadata. Used by the
     * Telegram bot to record the turn into the shared session store. Never
     * fires on error/timeout paths (those throw before `done`). Failures in
     * the callback are caught and logged — they never disrupt delivery.
     */
    onComplete?: (assistantText: string, metadata?: ResponseMetadata) => void | Promise<void>;
    /**
     * How long the turn must run before `◦` tool-progress lines start rendering.
     * Defaults to PROGRESS_START_DELAY_MS. Pass 0 to render immediately (tests
     * assert progress output without depending on wall-clock timing).
     */
    progressDelayMs?: number;
  } = {}
): Promise<void> {
  if (!ctx.chat?.id) {
    logger?.('streamResponse: ctx.chat is undefined (non-chat context); skipping');
    return;
  }
  const chatId = ctx.chat.id;
  const cleanFinal = options.cleanFinal ?? false;
  const progressDelayMs = options.progressDelayMs ?? PROGRESS_START_DELAY_MS;

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
  let contentRunStartAccumulated = 0;
  let contentRunStartAnswer = 0;
  let inContentRun = false;

  const watchdog: WatchdogState = {
    receivedAny: false, timedOut: false, lastActivityAt: Date.now(),
    inFlightTools: new Set<string>(), toolInFlightSince: null,
    get pausedUntil() { return state.pausedUntil; },
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
    // For content-block arrays (e.g. photo + caption), prefer sendMessageStream —
    // sendMessage only accepts a string, and vision content requires the streaming
    // path so the model receives the image as a proper multi-modal message.
    const stream = Array.isArray(content)
      ? 'sendMessageStream' in session && typeof session.sendMessageStream === 'function'
        ? session.sendMessageStream(content)
        : (async function* () {
            const msg = await session.sendMessage(
              content.map(b => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n'), { stream: false });
            yield { type: 'message' as const, message: msg };
            yield { type: 'done' as const, metadata: msg.metadata };
          })()
      : 'sendMessageStream' in session && typeof session.sendMessageStream === 'function'
        ? session.sendMessageStream(content)
        : (async function* () {
            const msg = await session.sendMessage(content, { stream: false });
            yield { type: 'message' as const, message: msg };
            yield { type: 'done' as const, metadata: msg.metadata };
          })();

    // Send placeholder immediately so user sees activity; avoids "silent hang" if SDK is slow
    await sendOrEdit(state, ctx, chatId, 'Thinking…');

    const iter = stream[Symbol.asyncIterator]();
    const nextWithTimeout = makeNextWithTimeout(iter, watchdog);
    const subagentSink = makeSubagentSink(
      state, ctx, chatId, livePreview,
      () => { watchdog.lastActivityAt = Date.now(); },
      subagentState,
    );
    const traceEnabled = !!env.AFK_TELEGRAM_TRACE;

    try {
      await runWithSink(subagentSink, async () => {
        while (true) {
          if (traceEnabled) console.log('[trace] awaiting next event');
          const result = await nextWithTimeout();
          if (traceEnabled) console.log('[trace] event arrived:', result.done ? 'DONE' : (result.value as OutputEvent).type);
          if (result.done) break;
          const event: OutputEvent = result.value;
          watchdog.lastActivityAt = Date.now();
          if (!watchdog.receivedAny) {
            watchdog.receivedAny = true;
            console.log('📡 First stream event received:', event.type);
            logger?.('First stream event received:', event.type);
          }

          // Track in-flight FOREGROUND tool calls so the watchdog can suspend
          // while a long tool (bash / nested afk chat) runs silently.
          if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
            if (watchdog.inFlightTools.size === 0) watchdog.toolInFlightSince = Date.now();
            watchdog.inFlightTools.add(event.chunk.toolUseId);
          } else if (event.type === 'chunk' && event.chunk.type === 'tool_result') {
            watchdog.inFlightTools.delete(event.chunk.toolUseId);
            if (watchdog.inFlightTools.size === 0) watchdog.toolInFlightSince = null;
          }

          if (event.type === 'chunk' && event.chunk.type === 'content') {
            if (!inContentRun) {
              contentRunStartAccumulated = state.accumulated.length;
              contentRunStartAnswer = state.answerText.length;
              inContentRun = true;
            }
            state.accumulated += event.chunk.content;
            state.answerText += event.chunk.content;
            await sendOrEdit(state, ctx, chatId, livePreview());
          }
          if (event.type === 'stream_retry') {
            // Mid-stream overload re-drive: discard partial text from this round.
            state.accumulated = state.accumulated.slice(0, contentRunStartAccumulated);
            state.answerText = state.answerText.slice(0, contentRunStartAnswer);
            inContentRun = false;
            await sendOrEdit(state, ctx, chatId, livePreview(), true);
          }
          if (event.type === 'rate_limit') {
            // Provider throttled (Claude 429/529) — show visible status, bump watchdog.
            //
            // Invariant: display the EFFECTIVE backoff, not the raw retry-after header.
            // The Anthropic SDK discards retry-after >= 60s and uses its own ~8s default
            // (SDK_HONORED_RETRY_AFTER_CEILING_MS = 60_000 in first-byte-timeout.ts). A
            // raw retry-after: 3600 would tell the user "~3600s" while the SDK retries
            // in seconds.
            const SDK_RETRY_AFTER_CEILING_MS = 60_000;
            const SDK_FALLBACK_BACKOFF_MS = 8_000;
            const effectiveMs = event.retryAfterMs !== undefined
              ? (event.retryAfterMs < SDK_RETRY_AFTER_CEILING_MS ? event.retryAfterMs : SDK_FALLBACK_BACKOFF_MS)
              : null;
            const secs = effectiveMs !== null ? Math.ceil(effectiveMs / 1_000) : null;
            const statusLine = secs !== null ? `⏸ Rate limited · retrying in ~${secs}s…` : '⏸ Rate limited · retrying…';
            await sendOrEdit(state, ctx, chatId, livePreview() + `\n\n${statusLine}`, true);
            continue;
          }
          if (event.type === 'chunk' && event.chunk.type === 'tool_diff') {
            // intentional no-op: diff is CLI-only; Telegram has no terminal palette
          }
          if (event.type === 'message' && event.message.role === 'assistant') {
            state.accumulated = event.message.content;
            state.answerText = event.message.content;
            inContentRun = false;
            // Ordering constraint: re-base BEFORE rendering. This assignment replaced the
            // buffer wholesale, so every offset recorded against the OLD buffer now indexes
            // unrelated text. Re-base to the new length so the preview degrades to footer
            // placement (the interleave contract for an offset that no longer means anything).
            // Copy, never mutate: entries are readonly and `finalBody()` maps the same list.
            state.progressEntries = state.progressEntries.map((e) => ({ ...e, at: state.accumulated.length }));
            await sendOrEdit(state, ctx, chatId, livePreview());
          }
          // Lane D — progress summaries appear in the response as dim `◦`-prefixed lines.
          // Invariant: `inContentRun = false` MUST stay unconditional — it is the
          // stream_retry round boundary. Gate the RENDER (via handleProgressEvent), never
          // this assignment. See streaming.progress.ts for the full invariant comment.
          if (event.type === 'progress') {
            inContentRun = false;
            await handleProgressEvent(
              event, state, progressGateOpen, progressDelayMs, ctx, chatId, livePreview,
              (v) => { progressGateOpen = v; }, clearProgressTimer,
            );
          }
          // Lane D — post-turn prompt suggestion. Skip when it duplicates the already-
          // rendered answer (compare against `answerText`, not `accumulated`: the gate's
          // purpose is "don't echo the ANSWER", and `accumulated` also carries `◦` lines).
          if (event.type === 'suggestion' && event.suggestion.trim() !== state.answerText.trim()) {
            state.accumulated += `\n\n💡 ${event.suggestion}`;
            state.answerText += `\n\n💡 ${event.suggestion}`;
            await sendOrEdit(state, ctx, chatId, livePreview());
          }
          // Display-only harness notice (issue #970). Appended inline as a
          // distinct italic info line so the operator sees truncations and
          // refusals without the text blending with model output. The `ℹ`
          // prefix makes the provenance clear. Not funnelled through answerText
          // (that carries genuine model output only) — accumulated is the write
          // target so `livePreview()` includes it in the sent message.
          if (event.type === 'notice') {
            const noticeText = `\n\n_ℹ ${event.text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')}_`;
            state.accumulated += noticeText;
            await sendOrEdit(state, ctx, chatId, livePreview());
          }
          if (event.type === 'paused') { await handlePaused(event, handlerParams); continue; }
          if (event.type === 'resumed') { await handleResumed(event, handlerParams); continue; }
          if (event.type === 'done') { await handleDone(event.metadata, handlerParams); break; }
          if (event.type === 'error') { handleError(event.error, handlerParams); }
        }
      }); // end runWithSink

      // Invariant: finalize BEFORE closing the generator so the session's
      // currentState stays 'streaming' while Telegram messages are in flight.
      // The in-place preview is edit-throttled and can freeze mid-stream. A `done`
      // event handled delivery above; any other exit (no terminal event, early break)
      // re-delivers everything as fresh messages so nothing is lost to a stale preview.
      const preview = state.sentMessage as Message.TextMessage | null;
      if (preview && !state.sawTerminalEvent) {
        const full = cleanFinal && state.answerText.trim() ? state.answerText : finalBody();
        if (full.trim()) {
          const delivered = await deliverClean(ctx, full);
          if (delivered) {
            await ctx.telegram.deleteMessage?.(chatId, preview.message_id).catch(() => {});
            state.sentMessage = null;
          }
        }
      } else {
        await deliverOverflow(ctx, cleanFinal, state.answerText, finalBody(), preview);
      }
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
