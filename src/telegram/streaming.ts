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
import { sanitizeLabel } from '../cli/commands/interactive/tool-lane-format-sanitize.js';

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

/** Max sub-agent progress lines retained in the bounded live-preview footer. */
const MAX_SUBAGENT_PREVIEW_LINES = 4;

// StreamTimeoutError lives in its own module so the message handler's
// `instanceof` check survives `vi.mock('./streaming.js')` in tests (see
// stream-timeout-error.ts). Imported above for local use (the watchdog throws
// it); re-exported here so callers/tests that import it from the streaming
// module keep working.
export { StreamTimeoutError };

/** Max flood-control (429) retries per outbound message before giving up. */
const MAX_FLOOD_RETRIES = 2;
/** Upper bound on how long we honor a single Telegram `retry_after`. */
const MAX_RETRY_AFTER_MS = 30_000;
/** Fallback backoff when a 429 carries no `retry_after`. */
const DEFAULT_FLOOD_BACKOFF_MS = 1_000;

/** Real wall-clock sleep; injectable in tests via `replyWithFloodRetry` opts. */
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Shown as a fresh message when Telegram refuses part of a multi-message reply
 * (flood-control that outlived our retries, or another transport failure) so the
 * dropped tail is VISIBLE instead of silently lost — the long-reply cutoff bug.
 */
const DELIVERY_TRUNCATED_NOTICE =
  '⚠️ Telegram dropped part of this reply (rate limit) — ask me to resend it.';

/**
 * Telegram flood-control (429) retry-after in ms, or `null` when `e` is not a
 * 429. Prefers the structured `parameters.retry_after`, falls back to parsing
 * the "retry after N" description, then to a small default — always capped.
 */
function floodRetryAfterMs(e: unknown): number | null {
  if (!(e instanceof TelegramError) || e.code !== 429) return null;
  const fromParams = e.parameters?.retry_after;
  const fromText = Number(/retry after (\d+)/i.exec(e.description ?? '')?.[1]);
  const secs =
    typeof fromParams === 'number' && fromParams > 0
      ? fromParams
      : Number.isFinite(fromText) && fromText > 0
        ? fromText
        : 0;
  return Math.min(secs > 0 ? secs * 1_000 : DEFAULT_FLOOD_BACKOFF_MS, MAX_RETRY_AFTER_MS);
}

/**
 * Send one message via `reply`, retrying on Telegram flood-control (429) up to
 * `maxRetries` times and honoring the server's `retry_after`. A long reply fans
 * out into several back-to-back sends; without this a single 429 aborted the
 * whole delivery and the tail was dropped silently. Non-429 errors (including the
 * 400 "can't parse entities" the caller handles specially) propagate immediately.
 * Exported for unit tests; `sleep` is injectable so tests never wait real seconds.
 */
export async function replyWithFloodRetry(
  reply: (text: string, extra?: { parse_mode?: 'HTML' }) => Promise<unknown>,
  text: string,
  extra?: { parse_mode?: 'HTML' },
  opts: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const maxRetries = opts.maxRetries ?? MAX_FLOOD_RETRIES;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      await reply(text, extra);
      return;
    } catch (e) {
      const waitMs = floodRetryAfterMs(e);
      if (waitMs === null || attempt >= maxRetries) throw e;
      await sleep(waitMs);
    }
  }
}

/**
 * Render a compact, BOUNDED footer summarizing sub-agent tool activity for the
 * live preview. Returns '' when there is no activity. Pure + exported for unit
 * tests. `recent` is the rolling tail (most recent last); only the last
 * MAX_SUBAGENT_PREVIEW_LINES are shown regardless of how many are passed.
 *
 * Replaces the old behavior where the sink appended one line to the message
 * buffer per child tool call (unbounded) — a fan-out produced dozens of lines
 * and a Telegram edit per line, which also tripped Telegram's flood-control 429.
 */
export function renderSubagentFooter(steps: number, recent: readonly string[]): string {
  if (steps <= 0) return '';
  const shown = recent.slice(-MAX_SUBAGENT_PREVIEW_LINES);
  const head = `◦ sub-agents working — ${steps} ${steps === 1 ? 'step' : 'steps'}`;
  return shown.length > 0 ? `\n${head}\n  ${shown.join('\n  ')}` : `\n${head}`;
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
      }
      // All other errors (rate limit, unchanged content, etc.) are silently ignored
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
            await replyWithFloodRetry(reply, htmlChunk, { parse_mode: 'HTML' });
            delivered = true;
          }
        }
      } catch (e) {
        if (e instanceof TelegramError && e.code === 400 && /can't parse entities/i.test(e.description ?? '')) {
          // Malformed HTML from the formatter — resend the raw chunk plain.
          try {
            await replyWithFloodRetry(reply, chunk);
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

  // Live preview = answer/content buffer + bounded sub-agent footer. Used for
  // every in-turn edit so sub-agent progress stays visible without the buffer
  // growing one line per child tool call.
  const livePreview = (): string =>
    accumulated + renderSubagentFooter(subagentSteps, recentSubagentSteps);

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
      const label = meta.agentType ?? meta.subagentId;
      // Sub-agent activity keeps the turn alive: bump the watchdog so deep
      // fan-out (silent on the parent stream) does not trip a false timeout.
      lastActivityAt = Date.now();
      if (event.type === 'chunk' && event.chunk.type === 'tool_use_detail') {
        // toolInput is redacted at its source (summarizeToolInput) before it
        // reaches this network-egress sink, so no secret-scrub is needed here.
        const toolArgs = event.chunk.toolInput.length > 60
          ? event.chunk.toolInput.slice(0, 57) + '...'
          : event.chunk.toolInput;
        // Bounded: count every step but retain only the most recent few lines,
        // rendered as a compact footer rather than one appended line per call.
        subagentSteps++;
        recentSubagentSteps.push(`${label}: ${event.chunk.toolName} ${toolArgs}`);
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
          await sendOrEdit(livePreview(), true);
        }
        if (event.type === 'chunk' && event.chunk.type === 'tool_diff') {
          // intentional no-op: diff is CLI-only; Telegram has no terminal palette
        }
        if (event.type === 'message' && event.message.role === 'assistant') {
          accumulated = event.message.content;
          answerText = event.message.content;
          inContentRun = false;
          await sendOrEdit(livePreview());
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
          // These fields are model-controlled (path/command/URL text from
          // summarizeToolInput) and markdownToTelegramHtml does not strip
          // ANSI/C1/control bytes, so scrub them here to match the CLI
          // banner's field-scoped hardening (tool-lane-format-sanitize.ts).
          const safeDescription = sanitizeLabel(description);
          const safeToolName = lastToolName ? sanitizeLabel(lastToolName) : lastToolName;
          const safeSummary = summary ? sanitizeLabel(summary) : summary;
          const line = safeToolName
            ? `\n◦ ${safeDescription} (${safeToolName})`
            : `\n◦ ${safeDescription}`;
          accumulated += line;
          if (safeSummary) accumulated += `\n  ${safeSummary}`;
          await sendOrEdit(livePreview());
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
            const delivered = await deliverClean(answerText);
            if (delivered && sentMessage) {
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
          // The provider already emitted a terminal error and parked itself, so
          // no interrupt() is needed (and would wrongly abort the NEXT turn).
          sawTerminalEvent = true;
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
      // streamed. A `done` event already handled delivery above: on the cleanFinal
      // path deliverClean ran and (on success) nulled `sentMessage`; on the legacy
      // non-cleanFinal path `sendOrEdit(accumulated)` edited chunk[0] into the preview
      // and only chunks[1..] remain to send. Any OTHER exit — `sawTerminalEvent` false:
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
        const full = cleanFinal && answerText.trim() ? answerText : accumulated;
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
      } else if (!cleanFinal && accumulated && preview) {
        // Legacy non-cleanFinal overflow: `done` fired (`sawTerminalEvent` true, so the
        // branch above is skipped) and `sendOrEdit` left only chunk[0] in the preview —
        // send the remaining chunks[1..] here. Gated on `!cleanFinal`: on the cleanFinal
        // path a FAILED deliverClean (first chunk fails past retries) posts the truncation
        // notice and leaves `sentMessage` set, which would otherwise re-fire this branch and
        // re-send chunks[1..] of the noisy `accumulated` buffer — directly contradicting the
        // "dropped, ask me to resend" notice just posted (issue #623). cleanFinal owns its own
        // delivery + notice entirely, so it must never fall through to this legacy path.
        const chunks = splitLongMessage(markdownToTelegramHtml(accumulated));
        if (chunks.length > 1) {
          const reply = (t: string, extra?: { parse_mode?: 'HTML' }): Promise<unknown> => ctx.reply(t, extra);
          try {
            for (let i = 1; i < chunks.length; i++) {
              const chunk = chunks[i];
              if (chunk) await replyWithFloodRetry(reply, chunk, { parse_mode: 'HTML' });
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
