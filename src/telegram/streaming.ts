/**
 * Streaming response handler for Telegram
 * Consumes session output stream and sends token/chunk-by-chunk updates to Telegram.
 * @module telegram/streaming
 */

import type { Context } from 'telegraf';
import { TelegramError } from 'telegraf';
import type { Message } from 'telegraf/types';
import { splitLongMessage, markdownToTelegramHtml } from './formatter.js';
import { StreamTimeoutError } from './stream-timeout-error.js';
import type { IAgentSession, OutputEvent, SubagentProgressMeta, ResponseMetadata } from '../agent/types.js';
import { runWithSink } from '../agent/_lib/skill-sink-channel.js';
import { env } from '../config/env.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import {
  formatTelegramActivity,
  formatTelegramAgentLabel,
  humanizeToolActivity,
  renderSubagentFooter,
  MAX_SUBAGENT_PREVIEW_LINES,
} from './streaming.activity.js';
import {
  floodRetryAfterMs,
  realSleep,
  replyWithFloodRetry as replyWithFloodRetryImpl,
} from './streaming.retry.js';
import {
  computeLivePreview,
  MAX_PROGRESS_ENTRIES,
} from './streaming.preview.js';
import type { ProgressEntry } from './streaming.preview.js';
import { computeFinalBody } from './streaming.body.js';

// Re-export so existing consumers (tests, other modules) keep importing from
// this module unchanged — the extraction is invisible to callers.
export { formatTelegramActivity, formatTelegramAgentLabel, renderSubagentFooter };
// Retry helpers — moved to streaming.retry.ts; re-exported for backward compat.
export { replyWithFloodRetry } from './streaming.retry.js';
// Preview helpers — moved to streaming.preview.ts; re-exported for backward compat.
export { renderProgressRegion, renderInterleavedPreview } from './streaming.preview.js';
export type { ProgressEntry } from './streaming.preview.js';

/** Minimum interval (ms) between Telegram edit requests to avoid rate limits */
const EDIT_THROTTLE_MS = 300;

/** Max wait for first stream event (e.g. SDK/API cold start) */
const FIRST_EVENT_TIMEOUT_MS = 90_000;
/**
 * Max wait between subsequent events. The window is re-armed whenever sub-agent
 * progress arrives via the sink (see `lastActivityAt`), so deep sub-agent
 * fan-out — which is silent on the PARENT stream while children run — no longer
 * trips a false timeout. 180s of TOTAL silence (no parent event AND no
 * sub-agent activity) is treated as a genuinely stuck turn.
 */
const NEXT_EVENT_TIMEOUT_MS = 180_000;

/**
 * Ceiling on how long the inactivity watchdog stays SUSPENDED for in-flight
 * foreground tool calls (see `inFlightTools`). A long foreground tool — a
 * nested `afk chat` via bash, a multi-minute build/test — is silent on the
 * parent stream between its `tool_use_detail` (start) and `tool_result` (end),
 * so counting that silence as a stuck stream is wrong. The bash tool self-caps
 * at 600s (src/agent/tools/handlers/bash.ts), so no single foreground tool call
 * can legitimately exceed this; a tool still in flight past the ceiling is
 * genuinely wedged and the watchdog is allowed to fire.
 */
const MAX_TOOL_INFLIGHT_MS = 660_000;
/** While suspended for an in-flight tool, re-check the ceiling at this cadence. */
const TOOL_INFLIGHT_RECHECK_MS = 15_000;

/**
 * Tool-progress (`◦`) lines stay HIDDEN until the turn has been working this
 * long. Most turns finish faster than this and now render no progress noise at
 * all — the live preview goes straight from `Thinking…` to the answer.
 *
 * Withheld lines are still recorded (see `progressEntries`); when the gate opens
 * the rolling region renders the most recent ones, so nothing is lost — it is a
 * render delay, not a drop. Overridable per call via `options.progressDelayMs`
 * (tests pass 0 to assert rendering deterministically).
 */
const PROGRESS_START_DELAY_MS = 5_000;

// StreamTimeoutError lives in its own module so the message handler's
// `instanceof` check survives `vi.mock('./streaming.js')` in tests (see
// stream-timeout-error.ts). Imported above for local use (the watchdog throws
// it); re-exported here so callers/tests that import it from the streaming
// module keep working.
export { StreamTimeoutError };

/**
 * Shown as a fresh message when Telegram refuses part of a multi-message reply
 * (flood-control that outlived our retries, or another transport failure) so the
 * dropped tail is VISIBLE instead of silently lost — the long-reply cutoff bug.
 */
const DELIVERY_TRUNCATED_NOTICE =
  '⚠️ Telegram dropped part of this reply (rate limit) — ask me to resend it.';

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
  // Inactivity watchdog state. `timedOut` is set ONLY when the watchdog fires,
  // so the finally can abort the still-running provider turn (and the handler
  // can show an honest timeout). `lastActivityAt` is bumped by every parent
  // event AND by sub-agent sink activity, so the re-armed timeout does not
  // false-fire during deep fan-out.
  let timedOut = false;
  // Set true once a terminal `done`/`error` event is processed for this turn.
  // Gates the finally-block interrupt(): any exit WITHOUT a terminal event
  // (watchdog timeout, a Telegram render exception, an early break) leaves the
  // long-lived shared provider iterator generating with no consumer, so the
  // user's NEXT message drains the stale buffer — the "send a '.' to recover
  // the lost result" bug.
  let sawTerminalEvent = false;
  let lastActivityAt = Date.now();
  // In-flight FOREGROUND tool tracking for the watchdog. A parent
  // `tool_use_detail` chunk adds its toolUseId; the matching `tool_result`
  // removes it. While non-empty, a tool is legitimately executing (silent on
  // the parent stream) so the watchdog SUSPENDS instead of firing — bounded by
  // MAX_TOOL_INFLIGHT_MS from `toolInFlightSince`. A Set keyed by toolUseId
  // makes a repeated tool_use_detail (e.g. from a stream_retry) idempotent.
  const inFlightTools = new Set<string>();
  let toolInFlightSince: number | null = null;
  // Bounded sub-agent progress region (see renderSubagentFooter): a rolling
  // counter + the last few lines, instead of an unbounded per-tool-call append.
  let subagentSteps = 0;
  const recentSubagentSteps: string[] = [];

  // Invariant: `accumulated` is NEVER mutated to carry `◦` progress lines — they
  // live only in `progressEntries` and are composed in at render time. This is
  // load-bearing, not stylistic. An earlier design rewrote a region INSIDE
  // `accumulated` at an offset; because a following content chunk froze that
  // region in place, every later progress event started a new one, so the
  // MAX_PROGRESS_LINES bound held only within a run of CONSECUTIVE progress
  // events and a stream alternating content with tool rounds (what the
  // anthropic-direct and openai-compatible loops actually emit) grew without
  // limit anyway. Trimming over the ENTRY LIST keeps the bound global.
  //
  // The live preview interleaves those entries chronologically
  // (computeLivePreview); `finalBody` deliberately keeps the legacy
  // trailing footer, because finalBody IS delivered to the user on a
  // progress-only or non-terminal-exit turn (see the `done` handler and the
  // post-loop overflow block) and that delivered output is held byte-stable.
  // Interleaving is therefore a PREVIEW-only concern by construction.
  const progressDelayMs = options.progressDelayMs ?? PROGRESS_START_DELAY_MS;
  const turnStartedAt = Date.now();
  let progressEntries: ProgressEntry[] = [];
  // Total tool rounds seen this turn (never trimmed) — drives the activity receipt.
  let progressRounds = 0;
  // Latency gate: closed until the turn has run progressDelayMs, so short turns
  // render no `◦` churn at all. Withheld lines stay in `progressEntries`.
  let progressGateOpen = progressDelayMs <= 0;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  // Set once a terminal event or the finally-block runs, so a timer callback
  // that loses the race can't edit a finished turn's message.
  let turnEnded = false;
  const clearProgressTimer = (): void => {
    if (progressTimer !== null) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
  };

  // Helper: build a live-preview string from current turn state.
  // Delegates to `computeLivePreview` (streaming.preview.ts) with explicit args
  // instead of closing over mutable outer variables, keeping the call site
  // readable and the helper independently testable.
  const livePreview = (): string =>
    computeLivePreview({
      accumulated,
      progressEntries,
      progressGateOpen,
      subagentSteps,
      recentSubagentSteps,
    });

  // Helper: build the final delivery body from current turn state.
  // Delegates to `computeFinalBody` (streaming.body.ts) with explicit args.
  const finalBody = (): string => computeFinalBody({ accumulated, progressEntries });

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
        if (e instanceof TelegramError && e.code === 400 && /can't parse entities/i.test(e.description ?? '')) {
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
      if (e instanceof TelegramError && e.code === 400 && /can't parse entities/i.test(e.description ?? '')) {
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
      } else {
        // Retry Telegram flood-control (429) once so in-turn edits survive
        // the rapid edit bursts subagent tool calls produce. Without this,
        // the preview message freezes and the user sees no further updates.
        const waitMs = floodRetryAfterMs(e);
        if (waitMs !== null) {
          const preSleepEdit = lastEditAt;
          await realSleep(waitMs);
          // If a newer edit landed while we slept (e.g. from a concurrent
          // fire-and-forget subagentSink call), our pre-sleep content is
          // stale — replaying it would revert the preview to an older state.
          if (lastEditAt !== preSleepEdit) {
            // Stale retry — a newer edit already updated the message; skip.
          } else {
            try {
              await ctx.telegram.editMessageText(
                ctx.chat?.id, sentMessage.message_id, undefined,
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
  };

  // Deliver `text` as one or more fresh messages (used for cleanFinal). Mirrors
  // sendOrEdit's HTML-then-plaintext fallback so a formatter bug can never
  // swallow the final answer, and retries flood-control (429) so a long reply's
  // back-to-back sends aren't dropped mid-way. If Telegram still refuses a chunk
  // (retries exhausted, or another non-recoverable transport error), the chunks
  // already sent stand and a VISIBLE truncation notice is posted — never the old
  // silent `throw` that dropped the tail and showed the user nothing.
  //
  // Returns whether ANY content actually landed. Callers use this to gate
  // deleting the live preview: if the very first chunk fails, `delivered` is
  // still false and the preview must survive so the user is never left with
  // zero visible content (see the `done` and non-terminal-exit call sites).
  const deliverClean = async (text: string): Promise<boolean> => {
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
      const windowMs = pausedUntil !== null
        ? Math.max(NEXT_EVENT_TIMEOUT_MS, pausedUntil.getTime() - Date.now() + PAUSE_SLACK_MS)
        : (receivedAny ? NEXT_EVENT_TIMEOUT_MS : FIRST_EVENT_TIMEOUT_MS);
      return new Promise<IteratorResult<OutputEvent>>((resolve, reject) => {
        // Re-arming watchdog: fire only after `windowMs` of silence measured
        // from the LAST activity. Sub-agent sink events bump `lastActivityAt`,
        // so an active fan-out re-arms the timer instead of tripping a false
        // timeout while the parent stream is legitimately quiet.
        const arm = (): void => {
          const remaining = windowMs - (Date.now() - lastActivityAt);
          if (remaining <= 0) {
            // A foreground tool call in flight (a long bash / nested `afk chat`)
            // is silent on the parent stream but is NOT a stuck turn: suspend
            // the watchdog while any tool runs, bounded by MAX_TOOL_INFLIGHT_MS
            // measured from when the first tool started, so a genuinely wedged
            // tool still eventually trips.
            if (
              inFlightTools.size > 0 &&
              toolInFlightSince !== null &&
              Date.now() - toolInFlightSince < MAX_TOOL_INFLIGHT_MS
            ) {
              timeoutId = setTimeout(arm, TOOL_INFLIGHT_RECHECK_MS);
              return;
            }
            timeoutId = null;
            timedOut = true;
            reject(
              new StreamTimeoutError(
                receivedAny
                  ? 'Response timed out. Try sending a shorter message or try again.'
                  : 'Request timed out. The agent may still be starting (first message can take a minute). Try again in a moment.'
              )
            );
          } else {
            timeoutId = setTimeout(arm, remaining);
          }
        };
        timeoutId = setTimeout(arm, windowMs);
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
      const label = formatTelegramAgentLabel(meta.agentType ?? meta.subagentId);
      // Sub-agent activity keeps the turn alive: bump the watchdog so deep
      // fan-out (silent on the parent stream) does not trip a false timeout.
      lastActivityAt = Date.now();
      if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
        // Bounded: count every step but retain only the most recent few lines,
        // rendered as a compact footer rather than one appended line per call.
        // Never include toolInput: even summarized input commonly contains raw
        // commands and private filesystem paths that are poor mobile UI.
        subagentSteps++;
        recentSubagentSteps.push(`${label} — ${humanizeToolActivity(event.chunk.toolName)}`);
        if (recentSubagentSteps.length > MAX_SUBAGENT_PREVIEW_LINES) recentSubagentSteps.shift();
        void sendOrEdit(livePreview());
      } else if (event.type === 'done') {
        // A child finishing refreshes the footer but must not grow the buffer.
        void sendOrEdit(livePreview());
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
        // A real parent event resets the inactivity window (the watchdog
        // measures silence from lastActivityAt, not from the arm() time).
        lastActivityAt = Date.now();
        if (!receivedAny) {
          receivedAny = true;
          console.log('📡 First stream event received:', event.type);
          logger?.('First stream event received:', event.type);
        }

        // Track in-flight FOREGROUND tool calls so arm() can suspend the
        // watchdog while a long tool (bash / nested afk chat) runs silently
        // between its tool_use_detail (start) and tool_result (end).
        if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
          if (inFlightTools.size === 0) toolInFlightSince = Date.now();
          inFlightTools.add(event.chunk.toolUseId);
        } else if (event.type === 'chunk' && event.chunk.type === 'tool_result') {
          inFlightTools.delete(event.chunk.toolUseId);
          if (inFlightTools.size === 0) toolInFlightSince = null;
        }

        if (event.type === 'chunk' && event.chunk.type === 'content') {
          if (!inContentRun) {
            contentRunStartAccumulated = accumulated.length;
            contentRunStartAnswer = answerText.length;
            inContentRun = true;
          }
          accumulated += event.chunk.content;
          answerText += event.chunk.content;
          await sendOrEdit(livePreview());
        }
        if (event.type === 'stream_retry') {
          // Mid-stream overload re-drive: discard the current round's partial
          // text (re-streamed from scratch after the backoff). The final
          // `message` event overwrites `accumulated` anyway — this just stops
          // the live preview from showing the text twice during the retry.
          accumulated = accumulated.slice(0, contentRunStartAccumulated);
          answerText = answerText.slice(0, contentRunStartAnswer);
          inContentRun = false;
          // The `◦` region is a separate footer, so a content rollback leaves it
          // untouched: those tool rounds really did happen and stay on screen.
          await sendOrEdit(livePreview(), true);
        }
        if (event.type === 'rate_limit') {
          // Provider is throttled (Claude 429/529) — show a visible status so the
          // user knows the turn is alive, and bump lastActivityAt so the watchdog
          // does not fire a false timeout during multi-minute backoffs.
          //
          // Invariant: display the EFFECTIVE backoff, not the raw retry-after
          // header. The Anthropic SDK discards retry-after >= 60s and uses its
          // own ~8s default (SDK_HONORED_RETRY_AFTER_CEILING_MS = 60_000,
          // SDK_MAX_DEFAULT_BACKOFF_MS = 8_000 in first-byte-timeout.ts). A raw
          // retry-after: 3600 would tell the user "~3600s" while the SDK
          // actually retries in seconds.
          const SDK_RETRY_AFTER_CEILING_MS = 60_000;
          const SDK_FALLBACK_BACKOFF_MS = 8_000;
          const effectiveMs = event.retryAfterMs !== undefined
            ? (event.retryAfterMs < SDK_RETRY_AFTER_CEILING_MS
              ? event.retryAfterMs
              : SDK_FALLBACK_BACKOFF_MS)
            : null;
          const secs = effectiveMs !== null ? Math.ceil(effectiveMs / 1_000) : null;
          const statusLine = secs !== null
            ? `⏸ Rate limited · retrying in ~${secs}s…`
            : '⏸ Rate limited · retrying…';
          await sendOrEdit(livePreview() + `\n\n${statusLine}`, true);
          continue;
        }
        if (event.type === 'chunk' && event.chunk.type === 'tool_diff') {
          // intentional no-op: diff is CLI-only; Telegram has no terminal palette
        }
        if (event.type === 'message' && event.message.role === 'assistant') {
          accumulated = event.message.content;
          answerText = event.message.content;
          inContentRun = false;
          // Ordering constraint: re-base BEFORE rendering. This assignment
          // replaced the buffer wholesale, so every offset recorded against the
          // OLD buffer now indexes unrelated text. Both providers emit this
          // message once per turn carrying only the final round's text, so an
          // early offset is usually still IN RANGE of the replacement — the
          // monotonic clamp inside renderInterleavedPreview never fires and the
          // label splices mid-word. Re-base to the new length so the preview
          // degrades to footer placement, which is what the interleave contract
          // promises for an offset that no longer means anything.
          //
          // Copy, never mutate: entries are readonly and `finalBody()` maps the
          // same list for its byte-stable legacy footer, so `label` must survive
          // untouched — only `at` moves.
          progressEntries = progressEntries.map((e) => ({ ...e, at: accumulated.length }));
          await sendOrEdit(livePreview());
        }
        // Lane D — progress summaries appear in the response as dim lines
        // prefixed with `◦`. These are debounced by the EDIT_THROTTLE_MS
        // above since they go through sendOrEdit on the same accumulated
        // buffer, so rapid progress bursts won't spam the Telegram API.
        if (event.type === 'progress') {
          // Invariant: this assignment is NOT cosmetic and must stay
          // unconditional — it is the stream_retry round boundary. A new content
          // run after this point re-snapshots contentRunStart*, so a later
          // retry rolls back only the new round. Skipping it (e.g. by early
          // -returning when progress rendering is gated off below) leaves the
          // snapshot at an older offset and a later stream_retry truncates MORE
          // of `answerText` than the retry produced — silently deleting
          // already-delivered answer text. Gate the RENDER, never this line.
          inContentRun = false;
          progressRounds++;
          const { description, lastToolName } = event.progress;
          // Telegram is a compact chat surface, not a terminal. Prefer a short
          // activity category for generic progress and intentionally omit the
          // summary, which routinely contains commands, URLs, and local paths.
          // formatTelegramActivity keeps the field-scoped hardening these
          // model-controlled fields require (sanitizeLabel on both description
          // and tool name) because markdownToTelegramHtml does not strip
          // ANSI/C1/control bytes — same contract as the CLI banner
          // (tool-lane-format-sanitize.ts).
          const line = `◦ ${formatTelegramActivity(description, lastToolName)}`;
          // Record first, render second: a line withheld by the latency gate is
          // still retained, so when the gate opens — by a later event OR by the
          // timer armed below — the bounded region shows the most recent rounds.
          // The list is global and capped, so the bound holds across a stream
          // that interleaves content with tool rounds, not just within one run.
          // Repeated tool categories add no information to a rolling mobile
          // preview: count every round for the receipt, but render duplicates once.
          //
          // Ordering constraint (externally governed by the provider's event
          // order): `at` must be sampled from `accumulated` BEFORE any later
          // content chunk of the NEXT round is appended. A `progress` event is
          // emitted only after a round's text deltas are complete — the
          // anthropic-direct loop yields it after `turnResult` is resolved, the
          // openai-compatible loop after `runIteration` returns — so sampling
          // here lands exactly on the boundary between two rounds of narration.
          // Deferring the sample would place the line inside the following round's
          // prose.
          if (progressEntries[progressEntries.length - 1]?.label !== line) {
            progressEntries.push({ label: line, at: accumulated.length });
          }
          if (progressEntries.length > MAX_PROGRESS_ENTRIES) {
            progressEntries = progressEntries.slice(-MAX_PROGRESS_ENTRIES);
          }
          if (!progressGateOpen && Date.now() - turnStartedAt >= progressDelayMs) {
            progressGateOpen = true;
          }
          if (progressGateOpen) {
            clearProgressTimer();
            await sendOrEdit(livePreview());
          } else if (progressTimer === null) {
            // Invariant: the gate must be able to open with NO further stream
            // event. Checking it only on the next `progress` event means one tool
            // that runs silently past the delay leaves the user on `Thinking…`
            // for its entire duration. Arm a one-shot timer for the remaining
            // wait; it is cleared on every terminal path and in the finally.
            progressTimer = setTimeout(() => {
              progressTimer = null;
              if (turnEnded) return;
              progressGateOpen = true;
              // A render already in flight computed its text before the gate
              // opened; skip rather than racing it — the next event or the final
              // delivery (finalBody, ungated) still surfaces the region.
              if (editInFlight) return;
              editInFlight = true;
              void sendOrEdit(livePreview(), true).finally(() => { editInFlight = false; });
            }, Math.max(0, progressDelayMs - (Date.now() - turnStartedAt)));
          }
        }
        // Lane D — post-turn prompt suggestion appended to the message.
        // Skip when the suggestion duplicates the already-rendered response:
        // anthropic-direct's loop yields the assistant's short final text
        // (≤200 chars) as a suggestion for surfaces that want to surface it
        // (the CLI drops these). Telegram has already rendered that exact
        // text via chunk/message events, so appending `\n\n💡 <same text>`
        // would produce a visible duplicate prefixed with 💡. Only append
        // true follow-up hints whose payload differs from the response.
        // Compare against `answerText`, not `accumulated`: the gate's purpose is
        // "don't echo text already rendered as the ANSWER", and `accumulated`
        // also carries the `◦` progress region — whose presence would make the
        // comparison spuriously unequal and append a duplicate 💡 line to the
        // answer on exactly the tool-heavy turns that produce progress.
        if (event.type === 'suggestion' && event.suggestion.trim() !== answerText.trim()) {
          accumulated += `\n\n💡 ${event.suggestion}`;
          answerText += `\n\n💡 ${event.suggestion}`;
          await sendOrEdit(livePreview());
        }
        // Display-only harness notice (issue #970). Appended inline as a
        // distinct italic info line so the operator sees truncations and
        // refusals without the text blending with model output. The `ℹ`
        // prefix makes the provenance clear. Not funnelled through answerText
        // (that carries genuine model output only) — accumulated is the write
        // target so `livePreview()` includes it in the sent message.
        if (event.type === 'notice') {
          const noticeText = `\n\n_ℹ ${event.text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')}_`;
          accumulated += noticeText;
          await sendOrEdit(livePreview());
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
          sawTerminalEvent = true;
          turnEnded = true;
          clearProgressTimer();
          if (countdownInterval !== null) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          if (cleanFinal && answerText.trim()) {
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
              answerText + renderActivityReceipt(progressRounds, Date.now() - turnStartedAt),
            );
            if (delivered && sentMessage) {
              await ctx.telegram.deleteMessage?.(chatId, sentMessage.message_id).catch(() => {});
              // Null the preview ref so the post-loop overflow block (which would
              // otherwise re-send the noisy `accumulated` buffer) is skipped.
              sentMessage = null;
            }
          } else if (finalBody().trim()) {
            // Invariant: a turn must never end on the bare `Thinking…` placeholder.
            // finalBody() is `accumulated` PLUS the ungated progress region, so a
            // progress-only turn whose lines the gate withheld still delivers them
            // (`accumulated` alone is empty there). Covers the plain non-cleanFinal
            // path and the cleanFinal-with-no-answer path in one branch.
            await sendOrEdit(finalBody(), true);
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
          // The provider already emitted a terminal error and parked itself, so
          // no interrupt() is needed (and would wrongly abort the NEXT turn).
          sawTerminalEvent = true;
          turnEnded = true;
          clearProgressTimer();
          if (countdownInterval !== null) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          throw event.error;
        }
      }
      }); // end runWithSink

      // Invariant: finalize BEFORE closing the generator so the session's
      // currentState stays 'streaming' while Telegram messages are in flight —
      // running this inside the try (before the finally) prevents the race where a
      // new user message sees state='idle' and bypasses the queue mid-delivery.
      //
      // The in-place preview is edited under EDIT_THROTTLE_MS and Telegram edit
      // flood-control, so it can freeze mid-stream and show LESS than what actually
      // streamed. A `done` event already handled delivery above: when `cleanFinal` had
      // non-empty `answerText`, `deliverClean` ran and (on success) nulled `sentMessage`;
      // otherwise (plain non-cleanFinal, OR a cleanFinal turn with empty `answerText`)
      // `sendOrEdit(accumulated)` edited only chunk[0] into the preview and chunks[1..]
      // remain to send. Any OTHER exit — `sawTerminalEvent` false:
      // the provider closed the stream without a terminal event, or an early break —
      // previously stranded the user on that frozen, partial preview (the long-reply
      // "cut off mid-sentence" bug). Re-deliver everything as fresh message(s) so
      // nothing that streamed is lost to a stale preview, then remove the preview.

      // Snapshot the preview ref. `sentMessage` is assigned only inside the
      // `sendOrEdit` closure (invisible to linear CFA), so post-loop TS narrows it to
      // literal `null` — which would type `preview` as `never` in the branch below.
      // The `as` re-anchors it to its true DECLARED type (a sound no-op cast), and the
      // `const` keeps the narrowing across the awaits below.
      const preview = sentMessage as Message.TextMessage | null;
      if (preview && !sawTerminalEvent) {
        // finalBody() (not bare `accumulated`) so a gated progress-only turn that
        // ends by graceful iterator close — no done/error event — still delivers
        // its recorded `◦` region instead of stranding the user on `Thinking…`.
        const full = cleanFinal && answerText.trim() ? answerText : finalBody();
        if (full.trim()) {
          // Only delete the preview if delivery actually produced content — a
          // failed first chunk must leave the frozen preview in place rather
          // than removing it and showing the user nothing.
          const delivered = await deliverClean(full);
          if (delivered) {
            await ctx.telegram.deleteMessage?.(chatId, preview.message_id).catch(() => {});
            sentMessage = null;
          }
        }
      } else if (!(cleanFinal && answerText.trim()) && finalBody() && preview) {
        // Overflow send: `done` fired (`sawTerminalEvent` true, so the branch above is
        // skipped) and the `done` handler used `sendOrEdit`, which only ever renders
        // chunk[0] into the preview — send the remaining chunks[1..] here.
        //
        // The gate is the exact negation of the `done` handler's own
        // `cleanFinal && answerText.trim()` guard: it fires for every case where that
        // handler took its `sendOrEdit` branch instead of `deliverClean` — the plain
        // non-cleanFinal path, AND a cleanFinal turn whose `answerText` is empty (e.g. a
        // progress-only turn that produced no final assistant text, only accumulated `◦`
        // status lines). A bare `!cleanFinal` gate (the original #623 fix) wrongly excluded
        // that second case too, silently truncating a long progress-only cleanFinal turn to
        // chunk[0] — flagged independently by this repo's own review pipeline and Codex
        // (PR #626 review). It still correctly excludes a FAILED deliverClean (first chunk
        // fails past retries): that case has `cleanFinal && answerText.trim()` true
        // regardless of delivery outcome, so `!(...)` is false and this branch is skipped —
        // preserving the original #623 fix (no contradictory resend after the truncation
        // notice `deliverClean` already posted).
        // Must split the SAME text the `done` handler flushed (finalBody, which
        // includes the progress region) or chunks[1..] would not line up with the
        // chunk[0] already rendered into the preview.
        const chunks = splitLongMessage(markdownToTelegramHtml(finalBody()));
        if (chunks.length > 1) {
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
      }
    } finally {
      // Park the still-running provider turn on ANY exit that did NOT reach a
      // terminal done/error event: a genuine inactivity timeout (the watchdog
      // abandoned our consumer but did not abort the turn), a Telegram render
      // exception, or an early break. Without this the provider keeps streaming
      // into the long-lived shared providerIterator with no consumer, and the
      // NEXT message drains those buffered events — the "turn cut off, send a
      // '.' to recover the lost result" bug. Previously this was gated on
      // `timedOut` alone, which left every NON-timeout early-exit path leaking.
      // interrupt() is the same turn-scoped abort the REPL uses for ESC; it
      // leaves providerIterator parked cleanly at the next-prompt boundary, and
      // is a no-op once the turn completed cleanly. Must run BEFORE iter.return(),
      // which flips currentState to 'idle' and would make interrupt() an
      // early-return no-op.
      if (timedOut || !sawTerminalEvent) {
        await Promise.resolve(session.interrupt?.()).catch(() => {});
      }
      // Stop the usage-limit countdown timer on EVERY exit path (incl. a throw):
      // it was previously cleared only on the done/error event branches, so a
      // timeout-throw while paused leaked an interval that kept editing a dead
      // message forever (and pinned editInFlight=true).
      if (countdownInterval !== null) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      // Ordering: set turnEnded BEFORE clearing, so a timer callback already
      // queued on the event loop sees the flag and declines to edit a dead turn.
      turnEnded = true;
      clearProgressTimer();
      editInFlight = false;
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


