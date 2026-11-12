/**
 * Core event-loop helpers for the Telegram streaming handler
 *
 * Extracted from `streamResponse` in streaming.ts — stream construction,
 * per-event chunk processing, and the main `while (true)` event loop body.
 * Each function takes explicit state parameters rather than closing over the
 * outer scope, mirroring the pattern in the other streaming.* siblings.
 * The public surface of streaming.ts is unchanged.
 * @module telegram/streaming.loop
 */

import type { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { IAgentSession, OutputEvent } from '../agent/types.js';
import { env } from '../config/env.js';
import { sendOrEdit, deliverClean } from './streaming.sender.js';
import type { StreamState } from './streaming.handlers.js';
import {
  handlePaused, handleResumed, handleDone, handleError, deliverOverflow,
  type HandlerParams,
} from './streaming.handlers.js';
import { handleProgressEvent } from './streaming.progress.js';
import type { WatchdogState } from './streaming.watchdog.js';

/**
 * Mutable snapshot of the stream_retry round boundary — tracks accumulated /
 * answerText lengths at the START of the current content run so a mid-stream
 * overload re-drive can discard only the partial text from that round.
 */
export interface ContentRunState {
  contentRunStartAccumulated: number;
  contentRunStartAnswer: number;
  inContentRun: boolean;
}

/**
 * Build the output event stream for a session turn.
 *
 * For ContentBlockParam arrays (e.g. photo + caption), prefer
 * `sendMessageStream` — `sendMessage` only accepts strings, and vision content
 * requires the streaming path so the model receives the image as a proper
 * multi-modal message. Falls back to a synthetic generator when
 * `sendMessageStream` is absent.
 */
export function buildStream(
  session: IAgentSession,
  content: string | ContentBlockParam[],
): AsyncIterable<OutputEvent> {
  const hasStream =
    'sendMessageStream' in session &&
    typeof session.sendMessageStream === 'function';

  if (Array.isArray(content)) {
    if (hasStream) return session.sendMessageStream!(content);
    return (async function* () {
      const msg = await session.sendMessage(
        content.map(b => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n'),
        { stream: false },
      );
      yield { type: 'message' as const, message: msg };
      yield { type: 'done' as const, metadata: msg.metadata };
    })();
  }

  if (hasStream) return session.sendMessageStream!(content);
  return (async function* () {
    const msg = await session.sendMessage(content, { stream: false });
    yield { type: 'message' as const, message: msg };
    yield { type: 'done' as const, metadata: msg.metadata };
  })();
}

/**
 * Update the watchdog's in-flight tool tracking for a chunk event.
 *
 * Tracks `tool_use_detail` (tool start) and `tool_result` (tool end) so the
 * watchdog can suspend while a long foreground tool (bash, nested afk chat)
 * runs silently on the parent stream without tripping a false timeout.
 */
export function updateWatchdogForChunk(
  event: OutputEvent & { type: 'chunk' },
  watchdog: WatchdogState,
): void {
  if (event.chunk.type === 'tool_use_detail') {
    if (watchdog.inFlightTools.size === 0) watchdog.toolInFlightSince = Date.now();
    watchdog.inFlightTools.add(event.chunk.toolUseId);
  } else if (event.chunk.type === 'tool_result') {
    watchdog.inFlightTools.delete(event.chunk.toolUseId);
    if (watchdog.inFlightTools.size === 0) watchdog.toolInFlightSince = null;
  }
}

/**
 * Process a `content` chunk: accumulate text and re-render the live preview.
 *
 * Also records the start of a content run for `stream_retry` rollback — when
 * the provider re-drives mid-stream, only the partial text from the current
 * round is discarded.
 */
export async function processChunkContent(
  event: OutputEvent & { type: 'chunk'; chunk: { type: 'content'; content: string } },
  state: StreamState,
  run: ContentRunState,
  ctx: Context,
  chatId: number,
  livePreview: () => string,
): Promise<void> {
  if (!run.inContentRun) {
    run.contentRunStartAccumulated = state.accumulated.length;
    run.contentRunStartAnswer = state.answerText.length;
    run.inContentRun = true;
  }
  state.accumulated += event.chunk.content;
  state.answerText += event.chunk.content;
  await sendOrEdit(state, ctx, chatId, livePreview());
}

/**
 * Process inline (non-chunk, non-progress, non-terminal) events:
 * `stream_retry`, `rate_limit`, `message`, `suggestion`, `notice`.
 *
 * Returns `true` when the caller should `continue` to the next iteration
 * (rate_limit fast-path), `false` otherwise.
 *
 * Invariant (`message` event): re-base progress entry offsets BEFORE
 * rendering. The assignment replaces the buffer wholesale, so every offset
 * recorded against the OLD buffer now indexes unrelated text. Re-base to the
 * new length so the preview degrades to footer placement. Copy, never mutate:
 * entries are readonly and `finalBody()` maps the same list.
 */
export async function processInlineEvent(
  event: OutputEvent,
  state: StreamState,
  run: ContentRunState,
  ctx: Context,
  chatId: number,
  livePreview: () => string,
): Promise<boolean> {
  if (event.type === 'stream_retry') {
    // Mid-stream overload re-drive: discard partial text from this round.
    state.accumulated = state.accumulated.slice(0, run.contentRunStartAccumulated);
    state.answerText = state.answerText.slice(0, run.contentRunStartAnswer);
    run.inContentRun = false;
    await sendOrEdit(state, ctx, chatId, livePreview(), true);
    return false;
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
    const effectiveMs =
      event.retryAfterMs !== undefined
        ? event.retryAfterMs < SDK_RETRY_AFTER_CEILING_MS
          ? event.retryAfterMs
          : SDK_FALLBACK_BACKOFF_MS
        : null;
    const secs = effectiveMs !== null ? Math.ceil(effectiveMs / 1_000) : null;
    const statusLine =
      secs !== null
        ? `⏸ Rate limited · retrying in ~${secs}s…`
        : '⏸ Rate limited · retrying…';
    await sendOrEdit(state, ctx, chatId, livePreview() + `\n\n${statusLine}`, true);
    return true; // caller should `continue`
  }

  if (event.type === 'message' && event.message.role === 'assistant') {
    state.accumulated = event.message.content;
    state.answerText = event.message.content;
    run.inContentRun = false;
    // Ordering constraint: re-base BEFORE rendering. This assignment replaced
    // the buffer wholesale, so every offset recorded against the OLD buffer now
    // indexes unrelated text. Re-base to the new length so the preview degrades
    // to footer placement (the interleave contract for an offset that no longer
    // means anything). Copy, never mutate: entries are readonly and `finalBody()`
    // maps the same list.
    state.progressEntries = state.progressEntries.map(e => ({
      ...e,
      at: state.accumulated.length,
    }));
    await sendOrEdit(state, ctx, chatId, livePreview());
    return false;
  }

  // Lane D — post-turn prompt suggestion. Skip when it duplicates the already-
  // rendered answer (compare against `answerText`, not `accumulated`: the gate's
  // purpose is "don't echo the ANSWER", and `accumulated` also carries `◦` lines).
  if (
    event.type === 'suggestion' &&
    event.suggestion.trim() !== state.answerText.trim()
  ) {
    state.accumulated += `\n\n💡 ${event.suggestion}`;
    state.answerText += `\n\n💡 ${event.suggestion}`;
    await sendOrEdit(state, ctx, chatId, livePreview());
    return false;
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
    return false;
  }

  return false;
}

/**
 * Run the main streaming event loop for one turn.
 *
 * Consumes `nextWithTimeout` until the stream is exhausted or a terminal event
 * (`done` / `error`) fires. Delegates each event type to the appropriate
 * handler. Mutates `state`, `watchdog`, and `run` in place.
 *
 * Returns the value of `progressGateOpen` at loop exit (used by the caller to
 * thread it back across the boundary).
 */
export async function runStreamLoop(params: {
  nextWithTimeout: () => Promise<IteratorResult<OutputEvent>>;
  state: StreamState;
  watchdog: WatchdogState;
  run: ContentRunState;
  ctx: Context;
  chatId: number;
  livePreview: () => string;
  finalBody: () => string;
  progressGateOpen: boolean;
  progressDelayMs: number;
  setProgressGateOpen: (v: boolean) => void;
  clearProgressTimer: () => void;
  handlerParams: HandlerParams;
  logger?: (...args: unknown[]) => void;
}): Promise<void> {
  const {
    nextWithTimeout, state, watchdog, run,
    ctx, chatId, livePreview, finalBody,
    progressDelayMs, setProgressGateOpen, clearProgressTimer,
    handlerParams, logger,
  } = params;
  let { progressGateOpen } = params;

  const traceEnabled = !!env.AFK_TELEGRAM_TRACE;

  while (true) {
    if (traceEnabled) console.log('[trace] awaiting next event');
    const result = await nextWithTimeout();
    if (traceEnabled)
      console.log(
        '[trace] event arrived:',
        result.done ? 'DONE' : (result.value as OutputEvent).type,
      );
    if (result.done) break;

    const event: OutputEvent = result.value;
    watchdog.lastActivityAt = Date.now();

    // Any event ends the API-round silence (messages.create has streamed).
    if (watchdog.apiRoundInFlight) {
      watchdog.apiRoundInFlight = false;
      watchdog.apiRoundSince = null;
    }

    if (!watchdog.receivedAny) {
      watchdog.receivedAny = true;
      if (traceEnabled) console.log('[trace] first stream event received:', event.type);
      logger?.('First stream event received:', event.type);
    }

    // Track in-flight FOREGROUND tool calls so the watchdog can suspend
    // while a long tool (bash / nested afk chat) runs silently.
    if (event.type === 'chunk') {
      updateWatchdogForChunk(event, watchdog);
    }

    if (event.type === 'chunk' && event.chunk.type === 'content') {
      await processChunkContent(
        event as OutputEvent & { type: 'chunk'; chunk: { type: 'content'; content: string } },
        state, run, ctx, chatId, livePreview,
      );
      continue;
    }

    if (event.type === 'chunk' && event.chunk.type === 'tool_diff') {
      // intentional no-op: diff is CLI-only; Telegram has no terminal palette
      continue;
    }

    // Lane D — progress summaries appear in the response as dim `◦`-prefixed lines.
    // Invariant: `inContentRun = false` MUST stay unconditional — it is the
    // stream_retry round boundary. Gate the RENDER (via handleProgressEvent), never
    // this assignment. See streaming.progress.ts for the full invariant comment.
    if (event.type === 'progress') {
      run.inContentRun = false;
      // A tool round finished — the provider is about to call messages.create.
      // Suspend the watchdog during the TTFB gap (see streaming.watchdog.ts).
      watchdog.apiRoundInFlight = true;
      watchdog.apiRoundSince = Date.now();
      await handleProgressEvent(
        event, state, progressGateOpen, progressDelayMs,
        ctx, chatId, livePreview,
        (v) => { progressGateOpen = v; setProgressGateOpen(v); },
        clearProgressTimer,
      );
      continue;
    }

    if (event.type === 'paused') { await handlePaused(event, handlerParams); continue; }
    if (event.type === 'resumed') { await handleResumed(event, handlerParams); continue; }
    if (event.type === 'done') { await handleDone(event.metadata, handlerParams); break; }
    if (event.type === 'error') { handleError(event.error, handlerParams); }

    // Remaining inline events: stream_retry, rate_limit, message, suggestion, notice
    const shouldContinue = await processInlineEvent(event, state, run, ctx, chatId, livePreview);
    if (shouldContinue) continue;
  }

  // Invariant: finalize BEFORE closing the generator so the session's
  // currentState stays 'streaming' while Telegram messages are in flight.
  // The in-place preview is edit-throttled and can freeze mid-stream. A `done`
  // event handled delivery above; any other exit (no terminal event, early break)
  // re-delivers everything as fresh messages so nothing is lost to a stale preview.
  // iter.return() is called by the outer finally in streaming.ts AFTER this block.
  const preview = state.sentMessage as Message.TextMessage | null;
  if (preview && !state.sawTerminalEvent) {
    const full =
      handlerParams.cleanFinal && state.answerText.trim()
        ? state.answerText
        : finalBody();
    if (full.trim()) {
      const delivered = await deliverClean(ctx, full);
      if (delivered) {
        await ctx.telegram.deleteMessage?.(chatId, preview.message_id).catch(() => {});
        state.sentMessage = null;
      }
    }
  } else {
    // Contract: deliverOverflow internalizes the full guard —
    // `!(cleanFinal && answerText.trim()) && finalBodyText && preview` — so
    // this bare `else` is safe without a redundant outer check.
    await deliverOverflow(
      ctx, handlerParams.cleanFinal, state.answerText, finalBody(), preview,
    );
  }
}
