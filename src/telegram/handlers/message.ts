import { Context } from 'telegraf';
import type { Message } from 'telegraf/types';
import { Telegraf } from 'telegraf';
import { SessionManager } from '../session-manager.js';
import { formatError, formatClear, formatInternalError, formatCompact, formatCompactNoop, formatQueued } from '../formatter.js';
import { isRateLimitError, isNetworkError, isTelegramTransportError } from '../error-utils.js';
import { streamResponse } from '../streaming.js';
// Import StreamTimeoutError from its own module, NOT '../streaming.js': many
// handler tests vi.mock('../streaming.js'), which would make the class resolve
// to undefined and turn `instanceof StreamTimeoutError` into a TypeError.
import { StreamTimeoutError } from '../stream-timeout-error.js';
import { registerChatCommands } from './registration.js';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

type QueueItem =
  | { type: 'message'; ctx: Context; text: string }
  | { type: 'photo'; ctx: Context; content: ContentBlockParam[] }
  | { type: 'clear'; ctx: Context }
  | { type: 'compact'; ctx: Context };

type LogFn = (...args: unknown[]) => void;

/**
 * Inspect magic bytes at the start of a buffer and return the corresponding
 * image MIME type, or null if the signature is not recognised.
 *
 * Checked signatures:
 *   PNG  — 89 50 4E 47 (4 bytes)
 *   GIF  — 47 49 46    (3 bytes, "GIF" prefix covers GIF87a and GIF89a)
 *   WebP — 52 49 46 46 … 57 45 42 50 (RIFF container; "WEBP" at bytes 8–11)
 *   JPEG — FF D8 FF    (SOI + start-of-marker)
 */
function sniffMimeType(bytes: Buffer): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  if (bytes.length < 3) return null;

  // PNG: 89 50 4E 47
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47
  ) return 'image/png';

  // GIF: 47 49 46 ("GIF")
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return 'image/gif';

  // WebP: RIFF container with "WEBP" at bytes 8–11
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 &&  // 'R', 'I'
    bytes[2] === 0x46 && bytes[3] === 0x46 &&  // 'F', 'F'
    bytes[8]  === 0x57 && bytes[9]  === 0x45 && // 'W', 'E'
    bytes[10] === 0x42 && bytes[11] === 0x50    // 'B', 'P'
  ) return 'image/webp';

  // JPEG: FF D8 FF (SOI marker)
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';

  return null;
}

type LimitedReadResult =
  | { status: 'ok'; bytes: Buffer }
  | { status: 'too-large'; bytesRead: number }
  | { status: 'missing-body' };

async function readResponseBytesWithLimit(response: Response, maxBytes: number): Promise<LimitedReadResult> {
  const contentLength = response.headers.get('content-length');
  if (contentLength != null) {
    const expectedBytes = Number(contentLength);
    if (Number.isFinite(expectedBytes) && expectedBytes > maxBytes) {
      return { status: 'too-large', bytesRead: expectedBytes };
    }
  }

  const body = response.body;
  if (!body) return { status: 'missing-body' };

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { status: 'too-large', bytesRead: total };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return { status: 'ok', bytes: Buffer.concat(chunks, total) };
}

/**
 * Message handler with queueing support
 */
export class MessageHandler {
  /** Maximum number of queued items per chat. Prevents memory exhaustion from
   *  photo floods while a session is busy — each photo can carry ~6.7 MB of base64 data. */
  private static readonly MAX_QUEUE_DEPTH = 5;

  private sessionManager: SessionManager;
  private messageQueues = new Map<number, Array<QueueItem>>();
  private registeredCommandChats: Set<number>;
  private log: LogFn;
  private bot: Telegraf;

  /**
   * Active ask_question elicitations waiting for a text reply.
   * Keys are chat IDs; values are resolver functions that consume
   * the next plain-text message from that chat.
   *
   * Answer consumed by active ask_question elicitation — never reaches
   * session message queue.
   */
  public pendingElicitations = new Map<number, (text: string) => void>();

  /**
   * Chat IDs whose active pendingElicitations entry was registered by a
   * ledger-originated (daemon-watch) elicitation rather than a session-local
   * ask_question call.
   *
   * Invariant: the idle-guard in handle() must fire the resolver for these
   * chats even when no AgentSession is active for the chat (the REPL session
   * lives in a different process). Without this bypass, every phone reply to a
   * ledger-originated elicitation is silently dropped because the guard sees
   * no in-flight session and treats the pending entry as stale.
   *
   * Lifecycle: entries are added by makeTelegramElicitationHandler before it
   * installs the resolver (via the ledgerOriginatedElicitation flag passed by
   * the watch loop), and deleted when the resolver fires or is aborted — exactly
   * mirroring the pendingElicitations Map lifecycle.
   */
  public ledgerOriginatedPendingChats = new Set<number>();

  constructor(
    bot: Telegraf,
    sessionManager: SessionManager,
    registeredCommandChats: Set<number>,
    log: LogFn
  ) {
    this.bot = bot;
    this.sessionManager = sessionManager;
    this.registeredCommandChats = registeredCommandChats;
    this.log = log;
  }

  /**
   * Handle photo messages (with optional caption).
   *
   * Telegram sends photo updates with `message.photo[]` and no `message.text`,
   * so the 'text' listener silently drops them. This handler covers that gap.
   *
   * Note: Telegram delivers each photo in a media group (album) as a separate
   * update — multi-photo album support is a known limitation and is not
   * implemented here.
   */
  async handlePhoto(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const msg = ctx.message as Message.PhotoMessage | undefined;
    const photo = msg?.photo;

    if (!chatId || !photo?.length) {
      this.log(`Photo handling: missing chatId or photo array for chat ${chatId ?? '(unknown)'}`);
      return;
    }

    this.log(`📷 Photo from chat ID: ${chatId}`);
    // Ack the photo on receipt (best-effort) — instant feedback even if the
    // image is later rejected (too large / unsupported) or queued.
    await ctx.react?.('👀').catch(() => {});

    // Use the largest available size (Telegram orders photo[] smallest → largest)
    const largest = photo[photo.length - 1];
    if (!largest) {
      this.log(`Photo handling: empty photo array for chat ${chatId}`);
      return;
    }

    // H2: hard cap — Telegram CDN files can be large; bail early to avoid
    // downloading something the Anthropic API will reject anyway.
    const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
    if (largest.file_size != null && largest.file_size > MAX_PHOTO_BYTES) {
      this.log(`Photo handling: oversized file (${largest.file_size} bytes) rejected for chat ${chatId}`);
      await ctx.reply('❌ Image is too large (max 5 MB). Please send a smaller photo.');
      return;
    }

    const caption = msg?.caption;

    try {
      // M3+M6: session lookup and queue-depth check happen before getFileLink /
      // download so that allowlist-burst rejections don't burn Telegram API quota
      // or trigger a full CDN download for a message that will be dropped anyway.
      const session = await this.sessionManager.getSession(chatId);

      // Register dynamic commands for this chat (non-blocking)
      registerChatCommands(this.bot, chatId, session, this.registeredCommandChats, this.log).catch(err =>
        this.log('Failed to register chat commands:', err)
      );

      if (session.state !== 'idle') {
        // Check queue capacity before downloading: if the queue is already full we
        // can reject immediately without spending Telegram API quota on getFileLink.
        const queue = this.messageQueues.get(chatId);
        if ((queue?.length ?? 0) >= MessageHandler.MAX_QUEUE_DEPTH) {
          await ctx.reply('⏳ Queue full. Please wait for your messages to be processed.');
          return;
        }
        // Queue has room — fall through to download so we can build contentBlocks
        // and enqueue the decoded photo for processing after the active turn ends.
      }

      // M1: validate the CDN URL before fetching to guard against SSRF.
      // Check protocol, hostname, and port — hostname-only checks can be bypassed
      // via non-standard ports or non-HTTPS schemes. Pass redirect:'error' so a
      // redirect to an internal address is never silently followed.
      const fileUrlRaw = await ctx.telegram.getFileLink(largest.file_id);
      // M4: coerce to URL — some Telegraf forks return a string instead of URL.
      // If fileUrlRaw is a plain string, fileUrlRaw.protocol is undefined, making
      // the https:-only check vacuously false and silently passing arbitrary URLs.
      const url = fileUrlRaw instanceof URL ? fileUrlRaw : new URL(String(fileUrlRaw));
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'api.telegram.org' ||
        (url.port !== '' && url.port !== '443')
      ) {
        // Do NOT log url.href — it contains the live bot token in the path segment
        // (https://api.telegram.org/file/bot<TOKEN>/<file_path>). Log only safe fields.
        this.log(`Photo handling: unexpected file URL (protocol=${url.protocol} hostname=${url.hostname}) rejected for chat ${chatId}`);
        await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
        return;
      }
      // DNS-rebinding caveat: the hostname check above is lexical — it validates the
      // parsed hostname string before fetch() is called. fetch() re-resolves DNS at
      // connect time, so a rebinding attack could pass this check and still route to
      // an internal address in the window between validation and connection.
      // Accepted risk: (1) Node's fetch enforces TLS and validates the server
      // certificate against 'api.telegram.org', making IP spoofing through TLS
      // impractical; (2) redirect:'error' below prevents any server-side redirect
      // to an internal address after the initial connection is established.
      // M3: 15-second timeout prevents a stalled CDN response from blocking the handler
      const response = await globalThis.fetch(url.href, {
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!response.ok) {
        this.log(`Photo handling: fetch failed with status ${response.status} for chat ${chatId}`);
        await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
        return;
      }
      const readResult = await readResponseBytesWithLimit(response, MAX_PHOTO_BYTES);
      if (readResult.status === 'too-large') {
        this.log(`Photo handling: downloaded file (${readResult.bytesRead} bytes) exceeds limit for chat ${chatId}`);
        await ctx.reply('❌ Image is too large (max 5 MB). Please send a smaller photo.');
        return;
      }
      if (readResult.status === 'missing-body') {
        this.log(`Photo handling: fetch response had no body for chat ${chatId}`);
        await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
        return;
      }
      const bytes = readResult.bytes;
      const base64 = bytes.toString('base64');

      // H1: derive MIME type from the response Content-Type header instead of
      // hardcoding image/jpeg — Telegram can serve PNG, GIF, and WebP as well.
      const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
      type AllowedMime = typeof ALLOWED_MIME[number];
      const rawContentType = response.headers.get('content-type') ?? '';
      // Lowercase before allow-list comparison — HTTP headers are case-insensitive
      // per RFC 7231, so 'Image/JPEG' must match as readily as 'image/jpeg'.
      const detectedMime = (rawContentType.split(';')[0]?.trim() ?? '').toLowerCase();
      let media_type: AllowedMime;
      if ((ALLOWED_MIME as readonly string[]).includes(detectedMime)) {
        media_type = detectedMime as AllowedMime;
      } else {
        // Content-Type absent or unrecognised: sniff magic bytes so we never
        // mislabel PNG/GIF/WebP bytes as image/jpeg and get rejected by Anthropic.
        const sniffed = sniffMimeType(bytes);
        if (sniffed !== null) {
          this.log(`Photo: sniffed ${sniffed} (Content-Type was "${rawContentType}") for chat ${chatId}`);
          media_type = sniffed;
        } else {
          // Completely unrecognised format — reject explicitly rather than sending
          // mislabelled bytes that the Anthropic API will reject server-side.
          this.log(`Photo: unrecognised image format for chat ${chatId} (Content-Type: "${rawContentType}")`);
          await ctx.reply('❌ Unsupported image format. Please send a JPEG, PNG, GIF, or WebP.');
          return;
        }
      }

      // Build content-block array: optional text block + image block
      // H4: use != null so an explicit empty-string caption is preserved
      // M2: prefix with [User caption] so the model can distinguish user text from system context
      // Cap at 1024 code points — Telegram's own limit — to prevent prompt-injection via
      // an arbitrarily long caption constructed by a relay or bot.
      // Use spread-then-slice to count Unicode code points, not UTF-16 code units:
      // emoji and other non-BMP characters span two code units, and slicing at a
      // surrogate-pair boundary with plain .slice() produces malformed text.
      const contentBlocks: ContentBlockParam[] = [];
      if (caption != null) {
        contentBlocks.push({ type: 'text', text: `[User caption]: ${[...caption].slice(0, 1024).join('')}` });
      }
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type, data: base64 },
      });

      if (session.state !== 'idle') {
        const depth = this.enqueuePhoto(chatId, ctx, contentBlocks);
        if (depth !== false) await ctx.reply(formatQueued(depth));
        return;
      }

      await this.processOne(chatId, ctx, contentBlocks);
    } catch (error) {
      // Redact any embedded bot token before logging: getFileLink() returns URLs of the form
      // https://api.telegram.org/file/bot<TOKEN>/<path>, and HTTP client errors frequently
      // embed the request URL in their message string.
      const rawErrStr = error instanceof Error ? error.message : String(error);
      const sanitizedErr = rawErrStr.replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
      this.log('Photo handling error:', sanitizedErr);
      // Note: 'session is busy' is no longer handled here — that race is covered
      // inside processOne's catch so it applies uniformly to all callers.
      if (isTelegramTransportError(error)) {
        // Telegram-side failure fetching the image (e.g. getFileLink 429) — a
        // Telegram limit, not a Claude one. Attribute it honestly.
        await ctx.reply('❌ Couldn\'t reach Telegram to fetch that image. Please try resending.');
      } else if (isRateLimitError(error)) {
        await ctx.reply('⏳ Rate limit reached. Please wait a moment and try again.');
      } else if (isNetworkError(error)) {
        await ctx.reply('❌ Couldn\'t download the image. Please try resending.');
      } else {
        await ctx.reply(formatInternalError());
      }
    }
  }

  /**
   * Handle user text messages
   */
  async handle(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const messageText = (ctx.message as Message.TextMessage).text;

    if (!chatId || !messageText) {
      return;
    }

    this.log(`📬 Message from chat ID: ${chatId}`);

    if (messageText.startsWith('/')) {
      return;
    }

    // Answer consumed by active ask_question elicitation — never reaches
    // session message queue. Intercept BEFORE the session.state check so
    // that elicitation replies are never swallowed by the busy-queue branch.
    //
    // Guard: only route to the elicit resolver when the resolver is live.
    // Two cases are distinguished:
    //
    //   1. Ledger-originated elicitation (daemon watching a REPL session):
    //      the REPL session runs in a separate process, so this chat has NO
    //      in-flight AgentSession. We must fire the resolver regardless of
    //      session state — the ledgerOriginatedPendingChats set tracks these
    //      so we can bypass the session-state check safely.
    //
    //   2. Session-local elicitation (ask_question from this chat's session):
    //      the resolver is live only while the session is non-idle. If the
    //      session was reset (/clear) while an elicitation was in flight, the
    //      abort signal on the old AbortController never fires, leaving a stale
    //      entry that would silently eat the user's next message. Checking the
    //      live session state here catches that case: a freshly-created session
    //      is always 'idle', so we delete the stale entry and fall through to
    //      processOne instead of routing to a dead resolver.
    const elicitResolver = this.pendingElicitations.get(chatId);
    if (elicitResolver) {
      // Case 1: ledger-originated bypass — fire resolver without session check.
      if (this.ledgerOriginatedPendingChats.has(chatId)) {
        this.pendingElicitations.delete(chatId);
        this.ledgerOriginatedPendingChats.delete(chatId);
        elicitResolver(messageText);
        return;
      }
      // Case 2: session-local — fire only when the session is genuinely busy.
      const existingSession = this.sessionManager.getSessionIfExists(chatId);
      if (existingSession && existingSession.state !== 'idle') {
        this.pendingElicitations.delete(chatId);
        elicitResolver(messageText);
        return;
      }
      // Stale entry — session was reset while elicitation was in flight.
      this.log('[message] dropping stale pendingElicitation for chatId', chatId);
      this.pendingElicitations.delete(chatId);
    }

    try {
      // Ack the inbound message immediately (best-effort) so the user gets
      // instant feedback even while a prior turn is still streaming and this
      // message is queued. Mirrors the best-effort typing-indicator pattern.
      await ctx.react?.('👀').catch(() => {});
      const session = await this.sessionManager.getSession(chatId);

      // Register dynamic commands for this chat (non-blocking)
      registerChatCommands(this.bot, chatId, session, this.registeredCommandChats, this.log).catch(err =>
        this.log('Failed to register chat commands:', err)
      );

      if (session.state !== 'idle') {
        const depth = this.enqueueMessage(chatId, ctx, messageText);
        if (depth !== false) await ctx.reply(formatQueued(depth));
        return;
      }

      await this.processOne(chatId, ctx, messageText);
    } catch (error) {
      this.log('Message handling error:', error);
      // Note: 'session is busy' is no longer handled here — that race is covered
      // inside processOne's catch so it applies uniformly to all callers.
      if (isTelegramTransportError(error)) {
        // Telegram-side delivery failure — not a Claude rate limit / network
        // error. Already logged; stay silent rather than misattribute it.
      } else if (isRateLimitError(error)) {
        await ctx.reply('⏳ Rate limit reached. Please wait a moment and try again.');
      } else if (isNetworkError(error)) {
        await ctx.reply('🌐 Network error. Please check your connection and try again.');
      } else {
        await ctx.reply(formatInternalError());
      }
    }
  }

  /**
   * Process clear command when already idle (called from handlers)
   */
  async processClearDirect(chatId: number, ctx: Context): Promise<void> {
    try {
      await this.sessionManager.resetSession(chatId);
      this.registeredCommandChats.delete(chatId);
      await ctx.reply(formatClear());
    } catch (error) {
      this.log('Clear error:', error);
      await ctx.reply(formatError(error as Error));
    }
  }

  /**
   * Process compact command at drain time (session is idle when called).
   * Fires drainQueue after completion so any messages queued during compaction
   * are processed.
   *
   * Mirrors the busy-recovery contract in processOne: drainQueue runs from a
   * `finally` after a turn completes, but a new turn can begin in the window
   * between drain-start and the session.compact() call below (TOCTOU). When that
   * happens compact() returns reason 'session-busy' (it does not throw — see
   * agent-session.ts compact()). Re-enqueue the compact in that case so it
   * actually runs once the session is idle, instead of surfacing the misleading
   * "Nothing to compact (session-busy)" no-op and dropping the request.
   */
  private async processCompactDirect(chatId: number, ctx: Context): Promise<void> {
    // See processOne: when we re-enqueue because the session is busy, the active
    // turn's own finally will drain the item we pushed. Draining here too would
    // shift that item and re-enter immediately → busy-spin cascade.
    let reEnqueued = false;
    try {
      const session = await this.sessionManager.getSession(chatId);
      await ctx.sendChatAction('typing').catch(() => {});
      const result = await session.compact();
      if (result.reason === 'session-busy') {
        // Session became busy between drain-start and our compact() call (TOCTOU).
        // Re-enqueue so the compact isn't silently dropped with a confusing no-op.
        this.enqueueCompact(chatId, ctx);
        reEnqueued = true;
        return;
      }
      if (!result.compacted) {
        await ctx.reply(formatCompactNoop(result.reason ?? 'unknown'));
      } else {
        await ctx.reply(formatCompact({
          before: result.messagesBefore,
          after: result.messagesAfter,
          ...(result.tokensSavedEstimate !== undefined
            ? { tokensSavedEstimate: result.tokensSavedEstimate }
            : {}),
        }));
      }
    } catch (error) {
      this.log('Compact error (queued):', error);
      await ctx.reply(formatError(error as Error));
    } finally {
      // Only drain when we did NOT re-enqueue — the active turn's finally will
      // drain the re-enqueued compact; draining here too causes a cascade.
      if (!reEnqueued) {
        this.drainQueue(chatId).catch(err => this.log('Drain error:', err));
      }
    }
  }

  /**
   * Enqueue a text message for later processing.
   * Returns the 1-based queue depth on success, or false if the queue is full.
   */
  private enqueueMessage(chatId: number, ctx: Context, text: string): number | false {
    let queue = this.messageQueues.get(chatId);
    if (!queue) {
      queue = [];
      this.messageQueues.set(chatId, queue);
    }
    if (queue.length >= MessageHandler.MAX_QUEUE_DEPTH) {
      ctx.reply('⏳ Queue full. Please wait for your messages to be processed.').catch(() => {});
      return false;
    }
    queue.push({ type: 'message', ctx, text });
    return queue.length; // 1-based depth after push
  }

  /**
   * Enqueue a photo message for later processing.
   * Returns the 1-based queue depth on success, or false if the queue is full.
   */
  private enqueuePhoto(chatId: number, ctx: Context, content: ContentBlockParam[]): number | false {
    let queue = this.messageQueues.get(chatId);
    if (!queue) {
      queue = [];
      this.messageQueues.set(chatId, queue);
    }
    if (queue.length >= MessageHandler.MAX_QUEUE_DEPTH) {
      ctx.reply('⏳ Queue full. Please wait for your messages to be processed.').catch(() => {});
      return false;
    }
    queue.push({ type: 'photo', ctx, content });
    return queue.length; // 1-based depth after push
  }

  /**
   * Enqueue a clear command for later processing
   */
  enqueueClear(chatId: number, ctx: Context): void {
    let queue = this.messageQueues.get(chatId);
    if (!queue) {
      queue = [];
      this.messageQueues.set(chatId, queue);
    }
    queue.push({ type: 'clear', ctx });
  }

  /**
   * Enqueue a compact command for later processing
   */
  enqueueCompact(chatId: number, ctx: Context): void {
    let queue = this.messageQueues.get(chatId);
    if (!queue) {
      queue = [];
      this.messageQueues.set(chatId, queue);
    }
    queue.push({ type: 'compact', ctx });
  }

  /**
   * Process one message (text or content blocks): stream response, then drain queue.
   *
   * The busy-recovery path lives here rather than in each caller because the session
   * can transition from idle → busy in the window between the caller's state-check
   * and this method's own getSession call (TOCTOU). Catching it here ensures the
   * item is re-enqueued regardless of which caller triggered processOne.
   */
  private async processOne(chatId: number, ctx: Context, content: string | ContentBlockParam[]): Promise<void> {
    // Guard against a busy-spin cascade: if the catch block re-enqueues the item
    // because the session is busy, we must NOT also drain — the re-enqueued item will
    // be picked up by the active session's own drain cycle. Without this flag, the
    // `return` inside the catch path still executes `finally`, which calls drainQueue,
    // which shifts the item we just pushed and calls processOne again → cascade.
    let reEnqueued = false;
    try {
      const session = await this.sessionManager.getSession(chatId);
      await ctx.sendChatAction('typing').catch(() => {});
      // User text for the stored turn record: joined text blocks (caption) for
      // content-block (photo) messages, the raw string otherwise.
      const userText = typeof content === 'string'
        ? content
        : content.map((b) => (b.type === 'text' ? b.text : '[image]')).join(' ');
      await streamResponse(ctx, session, content, this.log, {
        cleanFinal: true,
        // Record the completed turn into the shared session store so the CLI
        // can `--resume <name>` this Telegram conversation. Best-effort inside.
        onComplete: (assistantText, metadata) => {
          this.sessionManager.recordTelegramTurn(chatId, userText, assistantText, metadata);
        },
      });
    } catch (error) {
      this.log('Message handling error:', error);
      const busyMsg = (error as Error)?.message ?? '';
      if (busyMsg.includes('session is busy')) {
        // Session became busy between the caller's idle-check and our getSession call.
        // Re-enqueue the item so it isn't silently dropped.
        const depth = typeof content === 'string'
          ? this.enqueueMessage(chatId, ctx, content)
          : this.enqueuePhoto(chatId, ctx, content);
        if (depth !== false) await ctx.reply(formatQueued(depth));
        reEnqueued = true;
        return;
      }
      if (error instanceof StreamTimeoutError) {
        // Honest timeout — the message already explains the cause. NOT a network
        // or Claude rate-limit error, so don't misclassify it as one.
        await ctx.reply(`⏱️ ${error.message}`);
      } else if (isTelegramTransportError(error)) {
        // A Telegram-side delivery failure (flood-control 429, transient 5xx) —
        // NOT a Claude problem. Reporting it as a Claude rate limit is the bug.
        // Already logged above; stay silent (a further reply would likely hit
        // the same Telegram limit), and let the queue drain normally.
      } else if (isRateLimitError(error)) {
        await ctx.reply('⏳ Rate limit reached. Please wait a moment and try again.');
      } else if (isNetworkError(error)) {
        await ctx.reply('🌐 Network error. Please check your connection and try again.');
      } else {
        await ctx.reply(formatInternalError());
      }
    } finally {
      // Only drain when we did NOT just re-enqueue — the active session's own finally
      // will drain the item we pushed; calling drain here too causes a cascade.
      if (!reEnqueued) {
        this.drainQueue(chatId).catch(err => this.log('Drain error:', err));
      }
    }
  }

  /**
   * Process the next queued item for this chat, if any.
   * Public so bot.ts can call it directly after /compact completes.
   */
  async drainQueue(chatId: number): Promise<void> {
    const queue = this.messageQueues.get(chatId);
    if (!queue?.length) return;
    const item = queue.shift()!;
    if (item.type === 'message') {
      await this.processOne(chatId, item.ctx, item.text);
    } else if (item.type === 'photo') {
      await this.processOne(chatId, item.ctx, item.content);
    } else if (item.type === 'compact') {
      await this.processCompactDirect(chatId, item.ctx);
    } else {
      await this.processClearDirect(chatId, item.ctx);
    }
  }
}
