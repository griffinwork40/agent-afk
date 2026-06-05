/**
 * Streaming response handler for Telegram
 * Consumes session output stream and sends token/chunk-by-chunk updates to Telegram.
 * @module telegram/streaming
 */

import type { Context } from 'telegraf';
import { TelegramError } from 'telegraf';
import type { Message } from 'telegraf/types';
import { splitLongMessage, markdownToTelegramHtml } from './formatter.js';
import type { IAgentSession, OutputEvent, SubagentProgressMeta, ResponseMetadata } from '../agent/types.js';
import { runWithSink } from '../agent/_lib/skill-sink-channel.js';
import { env } from '../config/env.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

/** Minimum interval (ms) between Telegram edit requests to avoid rate limits */
const EDIT_THROTTLE_MS = 300;

/** Max wait for first stream event (e.g. SDK/API cold start) */
const FIRST_EVENT_TIMEOUT_MS = 90_000;
/** Max wait between subsequent events (e.g. long thinking) */
const NEXT_EVENT_TIMEOUT_MS = 60_000;

/** Countdown update granularity during a usage-limit pause: every 5 minutes. */
const PAUSE_COUNTDOWN_INTERVAL_MS = 5 * 60 * 1_000;
/** Extra slack (ms) added to the timeout deadline while paused. */
const PAUSE_SLACK_MS = 90_000;

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
  } = {}
): Promise<void> {
  if (!ctx.chat?.id) {
    logger?.('streamResponse: ctx.chat is undefined (non-chat context); skipping');
    return;
  }

  // ctx.chat is narrowed to defined here in the linear flow; capture the id so
  // the deeper closures (which lose the narrowing) have a non-undefined chat_id.
  const chatId = ctx.chat.id;
  // cleanFinal: on completion, deliver the assistant's answer as a fresh, clean
  // message and remove the live preview — so the conversation does not end on
  // the repeatedly-edited buffer that carries `◦` tool/progress noise. Default
  // off preserves the legacy edit-in-place behavior for callers that don't opt in.
  const cleanFinal = options.cleanFinal ?? false;

  let accumulated = '';
  // answerText tracks ONLY the assistant's answer (content chunks + the
  // authoritative assistant message + 💡 suggestion), excluding the `◦` progress
  // and status lines mixed into `accumulated` for the live preview. Used to build
  // the cleanFinal message.
  let answerText = '';
  let sentMessage: Message.TextMessage | null = null;
  let lastEditAt = 0;
  let pausedUntil: Date | null = null;
  let countdownInterval: ReturnType<typeof setInterval> | null = null;
  let editInFlight = false;
  let lastCountdownBucket = -1;
  // stream_retry rollback: snapshot the accumulator lengths at the start of
  // the current content run so a mid-stream overload re-drive can discard the
  // round's partial text (the model re-streams it from scratch). The final
  // `message` event overwrites `accumulated` regardless, so this only cleans
  // the transient live preview during the retry window.
  let contentRunStartAccumulated = 0;
  let contentRunStartAnswer = 0;
  let inContentRun = false;

  const sendOrEdit = async (text: string, force = false): Promise<void> => {
    // markdownToTelegramHtml runs 8 serial regex passes over the full accumulated
    // string (O(input length)). With ~200 chunks in a 4000-char response, calling
    // it unconditionally here would mean ~800k char-ops for ~13 actual Telegram
    // edits. Move the conversion to AFTER the throttle gate so it only runs when
    // we are actually going to send something to Telegram.
    const now = Date.now();
    if (!sentMessage) {
      const html = markdownToTelegramHtml(text || '…');
      const chunks = splitLongMessage(html);
      try {
        sentMessage = await ctx.reply(chunks[0] ?? '…', { parse_mode: 'HTML' });
      } catch (e) {
        if (e instanceof TelegramError && e.code === 400 && /can't parse entities/i.test(e.description)) {
          // Malformed HTML from formatter — retry without parse_mode using raw text as fallback
          sentMessage = await ctx.reply(text || '…');
        } else {
          throw e;
        }
      }
      return;
    }
    if (!force && now - lastEditAt < EDIT_THROTTLE_MS && text.length < 100) {
      return;
    }
    lastEditAt = now;
    const html = markdownToTelegramHtml(text || '…');
    const chunks = splitLongMessage(html);
    try {
      await ctx.telegram.editMessageText(
        ctx.chat?.id,
        sentMessage.message_id,
        undefined,
        chunks[0] ?? html,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      if (e instanceof TelegramError && e.code === 400 && /can't parse entities/i.test(e.description)) {
        // Malformed HTML from formatter — retry without parse_mode using raw text as fallback
        try {
          await ctx.telegram.editMessageText(
            ctx.chat?.id,
            sentMessage.message_id,
            undefined,
            text
          );
        } catch {
          // Plain-text retry also failed (e.g. unchanged content); ignore
        }
      }
      // All other errors (rate limit, unchanged content, etc.) are silently ignored
    }
  };

  // Deliver `text` as one or more fresh messages (used for cleanFinal). Mirrors
  // sendOrEdit's HTML-then-plaintext fallback so a formatter bug can never
  // swallow the final answer.
  const deliverClean = async (text: string): Promise<void> => {
    for (const chunk of splitLongMessage(text)) {
      if (!chunk) continue;
      try {
        for (const htmlChunk of splitLongMessage(markdownToTelegramHtml(chunk))) {
          if (htmlChunk) await ctx.reply(htmlChunk, { parse_mode: 'HTML' });
        }
      } catch (e) {
        if (e instanceof TelegramError && e.code === 400 && /can't parse entities/i.test(e.description)) {
          await ctx.reply(chunk).catch(() => {});
        } else {
          throw e;
        }
      }
    }
  };

  try {
    const stream =
      // For content-block arrays (e.g. photo + caption), prefer sendMessageStream —
      // sendMessage only accepts a string, and vision content requires the streaming path
      // so the model receives the image as a proper multi-modal message.
      // Guard with the same capability check as the string path: if sendMessageStream is
      // absent (e.g. a lightweight session stub), fall through to the sendMessage fallback.
      Array.isArray(content)
        ? 'sendMessageStream' in session && typeof session.sendMessageStream === 'function'
          ? session.sendMessageStream(content)
          : (async function* () {
              const msg = await session.sendMessage(
                content.map(b => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n'),
                { stream: false }
              );
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
    await sendOrEdit('Thinking…');

    const iter = stream[Symbol.asyncIterator]();
    let receivedAny = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const nextWithTimeout = (): Promise<IteratorResult<OutputEvent>> => {
      // During a usage-limit pause, extend the deadline to reset time + slack
      // so we don't fire a "timed out" error while the provider is waiting.
      const waitMs = pausedUntil !== null
        ? Math.max(NEXT_EVENT_TIMEOUT_MS, pausedUntil.getTime() - Date.now() + PAUSE_SLACK_MS)
        : (receivedAny ? NEXT_EVENT_TIMEOUT_MS : FIRST_EVENT_TIMEOUT_MS);
      return new Promise<IteratorResult<OutputEvent>>((resolve, reject) => {
        timeoutId = setTimeout(() => {
          timeoutId = null;
          reject(
            new Error(
              receivedAny
                ? 'Response timed out. Try sending a shorter message or try again.'
                : 'Request timed out. The agent may still be starting (first message can take a minute). Try again in a moment.'
            )
          );
        }, waitMs);
        iter.next().then(
          (result) => {
            if (timeoutId != null) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            resolve(result as IteratorResult<OutputEvent>);
          },
          (err) => {
            if (timeoutId != null) {
              clearTimeout(timeoutId);
              timeoutId = null;
            }
            reject(err);
          }
        );
      });
    };

    // Subagent progress sink: converts child-agent events into Telegram-
    // visible annotations on the accumulated message. Without this,
    // subagent events are silently dropped because no ambient sink is set.
    const subagentSink = (event: OutputEvent, meta: SubagentProgressMeta): void => {
      const label = meta.agentType ?? meta.subagentId;
      if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
        const toolArgs = event.chunk.toolInput.length > 60
          ? event.chunk.toolInput.slice(0, 57) + '...'
          : event.chunk.toolInput;
        accumulated += `\n◦ ${label}: ${event.chunk.toolName} ${toolArgs}`;
        void sendOrEdit(accumulated);
      } else if (event.type === 'done') {
        accumulated += `\n◦ ${label}: Done`;
        void sendOrEdit(accumulated);
      }
    };

    // Hoist the trace flag once — avoids a getter call on every streaming event.
    const traceEnabled = !!env.AFK_TELEGRAM_TRACE;

    try {
      await runWithSink(subagentSink, async () => {
      while (true) {
        if (traceEnabled) console.log('[trace] awaiting next event');
        const result = await nextWithTimeout();
        if (traceEnabled) console.log('[trace] event arrived:', result.done ? 'DONE' : (result.value as OutputEvent).type);
        if (result.done) break;
        const event: OutputEvent = result.value;
        if (!receivedAny) {
          receivedAny = true;
          console.log('📡 First stream event received:', event.type);
          logger?.('First stream event received:', event.type);
        }

        if (event.type === 'chunk' && event.chunk.type === 'content') {
          if (!inContentRun) {
            contentRunStartAccumulated = accumulated.length;
            contentRunStartAnswer = answerText.length;
            inContentRun = true;
          }
          accumulated += event.chunk.content;
          answerText += event.chunk.content;
          await sendOrEdit(accumulated);
        }
        if (event.type === 'stream_retry') {
          // Mid-stream overload re-drive: discard the current round's partial
          // text (re-streamed from scratch after the backoff). The final
          // `message` event overwrites `accumulated` anyway — this just stops
          // the live preview from showing the text twice during the retry.
          accumulated = accumulated.slice(0, contentRunStartAccumulated);
          answerText = answerText.slice(0, contentRunStartAnswer);
          inContentRun = false;
          await sendOrEdit(accumulated, true);
        }
        if (event.type === 'chunk' && event.chunk.type === 'tool_diff') {
          // intentional no-op: diff is CLI-only; Telegram has no terminal palette
        }
        if (event.type === 'message' && event.message.role === 'assistant') {
          accumulated = event.message.content;
          answerText = event.message.content;
          inContentRun = false;
          await sendOrEdit(accumulated);
        }
        // Lane D — progress summaries appear in the response as dim lines
        // prefixed with `◦`. These are debounced by the EDIT_THROTTLE_MS
        // above since they go through sendOrEdit on the same accumulated
        // buffer, so rapid progress bursts won't spam the Telegram API.
        if (event.type === 'progress') {
          // Round boundary: a new content run after this starts a fresh
          // snapshot, so a later stream_retry rolls back only the new round.
          inContentRun = false;
          const { description, summary, lastToolName } = event.progress;
          const line = lastToolName
            ? `\n◦ ${description} (${lastToolName})`
            : `\n◦ ${description}`;
          accumulated += line;
          if (summary) accumulated += `\n  ${summary}`;
          await sendOrEdit(accumulated);
        }
        // Lane D — post-turn prompt suggestion appended to the message.
        // Skip when the suggestion duplicates the already-rendered response:
        // anthropic-direct's loop yields the assistant's short final text
        // (≤200 chars) as a suggestion for surfaces that want to surface it
        // (the CLI drops these). Telegram has already rendered that exact
        // text via chunk/message events, so appending `\n\n💡 <same text>`
        // would produce a visible duplicate prefixed with 💡. Only append
        // true follow-up hints whose payload differs from the response.
        if (event.type === 'suggestion' && event.suggestion.trim() !== accumulated.trim()) {
          accumulated += `\n\n💡 ${event.suggestion}`;
          answerText += `\n\n💡 ${event.suggestion}`;
          await sendOrEdit(accumulated);
        }
        if (event.type === 'paused') {
          // Start a 5-minute-granularity countdown updater so the Telegram
          // message reflects time remaining without flooding the edit API.
          //
          // Branch pause copy + countdown on event.autoResume (Telegram parity
          // with render.ts:542-554): when the provider will NOT auto-resume,
          // the user must retype after the limit clears, and a live countdown
          // is meaningless because the session is effectively stopped.
          pausedUntil = event.resetsAt ?? null;
          const autoResume = event.autoResume ?? true;
          const minutesRemaining = pausedUntil !== null
            ? Math.max(0, Math.ceil((pausedUntil.getTime() - Date.now()) / 60_000))
            : null;
          const timeStr = pausedUntil !== null
            ? pausedUntil.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
            : null;
          const accountLine = event.accountId ? `\n\nAccount: ${event.accountId}` : '';
          const pauseMsg = timeStr !== null && minutesRemaining !== null
            ? autoResume
              ? `⏸ **Usage paused**${accountLine}\n\nResets at ${timeStr} (in ~${minutesRemaining} min).\n\nI'll auto-resume when the limit resets — no need to retype.`
              : `⏸ **Usage paused**${accountLine}\n\nResets at ${timeStr} (in ~${minutesRemaining} min).\n\nWait for the limit to reset, then send again — or abort and retry later.`
            : autoResume
              ? `⏸ **Usage paused**${accountLine}\n\nNo reset time available. I'll resume automatically if you log in with a different Claude account — or abort and retry later.`
              : `⏸ **Usage paused**${accountLine}\n\nNo reset time available. Wait for the limit to reset, then send again — or abort and retry later.`;
          await sendOrEdit(pauseMsg, true);

          if (pausedUntil !== null && autoResume) {
            lastCountdownBucket = minutesRemaining !== null ? Math.floor(minutesRemaining / 5) : -1;
            countdownInterval = setInterval(() => {
              if (pausedUntil === null || editInFlight) return;
              const remaining = Math.max(0, Math.ceil((pausedUntil.getTime() - Date.now()) / 60_000));
              const bucket = Math.floor(remaining / 5);
              if (bucket !== lastCountdownBucket) {
                lastCountdownBucket = bucket;
                const ts = pausedUntil.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
                const msg = `⏸ **Usage paused**\n\nResets at ${ts} (in ~${remaining} min).\n\nI'll auto-resume when the limit resets — no need to retype.`;
                editInFlight = true;
                void sendOrEdit(msg, true).finally(() => { editInFlight = false; });
              }
            }, PAUSE_COUNTDOWN_INTERVAL_MS);
          }
          continue;
        }

        if (event.type === 'resumed') {
          // Clear countdown timer and show a "Resumed" edit.
          if (countdownInterval !== null) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          pausedUntil = null;
          const resumeMsg = event.hotSwapped && event.accountId
            ? `▶ **Resumed on ${event.accountId}**`
            : '▶ **Resumed**';
          await sendOrEdit(resumeMsg, true);
          continue;
        }

        if (event.type === 'done') {
          if (countdownInterval !== null) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          if (cleanFinal && answerText.trim()) {
            // Deliver the answer as a fresh, noise-free message, then remove the
            // live preview so the conversation ends on a single clean reply.
            await deliverClean(answerText);
            if (sentMessage) {
              await ctx.telegram.deleteMessage?.(chatId, sentMessage.message_id).catch(() => {});
              // Null the preview ref so the post-loop overflow block (which would
              // otherwise re-send the noisy `accumulated` buffer) is skipped.
              sentMessage = null;
            }
          } else if (accumulated.trim()) {
            await sendOrEdit(accumulated, true);
          }
          // Record the completed turn into the shared session store (Telegram
          // → CLI resume). answerText is the noise-free assistant answer.
          if (options.onComplete) {
            try {
              await options.onComplete(answerText, event.metadata);
            } catch (e) {
              logger?.('streamResponse onComplete (turn recording) failed:', e);
            }
          }
          break;
        }
        if (event.type === 'error') {
          if (countdownInterval !== null) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          throw event.error;
        }
      }
      }); // end runWithSink

      // Send overflow chunks BEFORE closing the generator so the session's
      // currentState stays 'streaming' while Telegram messages are in flight.
      // Moving this inside the try block (before the finally) prevents the race
      // where a new user message sees state='idle' and bypasses the queue while
      // overflow chunks are still being delivered.
      if (accumulated && sentMessage) {
        const chunks = splitLongMessage(markdownToTelegramHtml(accumulated));
        if (chunks.length > 1) {
          for (let i = 1; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (chunk) await ctx.reply(chunk, { parse_mode: 'HTML' });
          }
        }
      }
    } finally {
      // Always close the async generator — on both the happy path and the error
      // path — so the session's currentState resets to 'idle' only after all
      // Telegram messages are sent. Without this, a throw at event.type ===
      // 'error' skips iter.return() and leaves the session permanently "busy".
      await Promise.resolve(iter.return?.(undefined)).catch(() => {});
    }
  } catch (error) {
    logger?.('Streaming error:', error);
    throw error;
  }
}
