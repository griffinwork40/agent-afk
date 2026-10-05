import { Context, Telegraf } from 'telegraf';
import type { Message } from 'telegraf/types';
import { SessionManager } from '../session-manager.js';
import { formatError, formatClear, formatInternalError, formatQueued } from '../formatter.js';
import { isRateLimitError, isNetworkError, isTelegramTransportError, formatRateLimitReply } from '../error-utils.js';
import { streamResponse } from '../streaming.js';
import { withTypingIndicator } from '../typing-indicator.js';
// Import StreamTimeoutError from its own module, NOT '../streaming.js': many
// handler tests `vi.mock` '../streaming.js', which would make the class resolve
// to undefined and turn `instanceof StreamTimeoutError` into a TypeError.
import { StreamTimeoutError } from '../stream-timeout-error.js';
import { registerChatCommands } from './registration.js';
import { errorMessage } from '../../utils/errors.js';
import { type TelegramRoute, routeFromCtx, routeKey } from '../route.js';
import { senderPrefix } from '../sender-attribution.js';
import { replyContextPrefix, type RepliedMessage } from '../reply-context.js';
import { forwardProvenancePrefix } from '../forward-provenance.js';
import type { ContentBlockParam, DocumentBlockParam } from '@anthropic-ai/sdk/resources';
import { handleDocumentMessage } from './document.js';
import { drainBgInjections, prependToContent } from '../bg-injection.js';
import { addressedToBot } from './message.addressed-to-bot.js';
import { reactionMap } from '../reaction-map.js';
import { handlePhotoImpl } from './message.photo-handler.js';
import { processCompactDirectImpl } from './message.compact-handler.js';

export { addressedToBot };

type QueueItem =
  | { type: 'message'; ctx: Context; text: string }
  | { type: 'photo'; ctx: Context; content: ContentBlockParam[] }
  | { type: 'document'; ctx: Context; content: ContentBlockParam[] }
  | { type: 'clear'; ctx: Context }
  | { type: 'compact'; ctx: Context };

type LogFn = (...args: unknown[]) => void;

/**
 * Message handler with queueing support
 */
export class MessageHandler {
  /** Maximum number of queued items per chat. Prevents memory exhaustion from
   *  photo floods while a session is busy -- each photo can carry ~6.7 MB of base64 data. */
  private static readonly MAX_QUEUE_DEPTH = 5;

  private sessionManager: SessionManager;
  /**
   * Per-ROUTE message queues. Keyed by `routeKey(route)` -- General / topics-off
   * normalizes to `String(chatId)` (byte-identical to the pre-topics key), a
   * real topic to `${chatId}:${threadId}`. This is a leak-critical map: a
   * message queued in topic A must never drain into topic B's session.
   */
  private messageQueues = new Map<string, Array<QueueItem>>();
  /** Chats (NOT routes) with dynamic commands registered -- Telegram scopes setMyCommands per chat, not per topic. */
  private registeredCommandChats: Set<number>;
  private log: LogFn;
  private bot: Telegraf;

  /**
   * Invariant: routes with a turn claimed by an in-flight handle()/
   * handlePhoto()/drain call not yet reflected in `session.state`. bot.ts runs
   * 'text'/'photo' detached, so a second same-route update can be dispatched
   * while the first is still between `getSession()` and the point where
   * `currentState` actually flips to 'streaming'.
   *
   * That flip is deferred because `session.sendMessageStream` is a LAZY
   * `async*` generator: its body -- `assertCanSend()` then
   * `currentState = 'streaming'` (agent-session.ts) -- runs only on the
   * consumer's first `iter.next()`, not when the generator is constructed.
   * streaming.ts constructs the generator, awaits the "Thinking..." placeholder
   * (a real Telegram round-trip), and only then pulls the first value -- so the
   * state flip lands well after `getSession()` returns. `session.state` alone
   * misses that window: two updates would both see 'idle' and race out of
   * arrival order (PR #602 review -- Codex P1).
   *
   * Reference-counted (routeKey -> live claim count) rather than a plain Set so
   * the reservation survives the hand-off across `processOne`'s un-awaited
   * `finally -> drainQueue`: the drained turn takes its own +1 synchronously
   * before the outer turn's release drops back to 0, so the slot is never
   * momentarily empty while a detached drain turn is still in flight (#603
   * Item 1). Reserved/released synchronously (no `await` in between) via the
   * claim* helpers below, so only the first arrival wins; `isClaimed` sees any
   * live count. See {@link reserveClaim}/{@link releaseClaim}.
   */
  private claimedChats = new Map<string, number>();

  /**
   * Reserve this route's turn slot (synchronous). Increments the live claim
   * count so overlapping reservations -- handle()'s outer guard plus
   * processOne's own reservation plus a drain re-entry -- compose instead of
   * clobbering a single boolean flag. Must be called with NO `await` between
   * the deciding `isClaimed` read and this call.
   */
  private reserveClaim(key: string): void {
    this.claimedChats.set(key, (this.claimedChats.get(key) ?? 0) + 1);
  }

  /**
   * Release one reservation taken by {@link reserveClaim}. Deletes the entry
   * once the count reaches zero so `isClaimed` reports false again. Balanced:
   * each reserveClaim has exactly one releaseClaim on every code path.
   */
  private releaseClaim(key: string): void {
    const next = (this.claimedChats.get(key) ?? 0) - 1;
    if (next <= 0) this.claimedChats.delete(key);
    else this.claimedChats.set(key, next);
  }

  /** True while any turn holds a slot for this route (see {@link claimedChats}). */
  private isClaimed(key: string): boolean {
    return (this.claimedChats.get(key) ?? 0) > 0;
  }

  /**
   * Active ask_question elicitations waiting for a text reply.
   * Keys are ROUTE keys (`routeKey(route)`); values are resolver functions
   * that consume the next plain-text message from that route.
   *
   * Invariant (leak fix): keying by route -- not by chatId -- is what isolates
   * topics. An elicitation raised in topic A registers under A's routeKey and
   * is resolved ONLY by a message whose route also resolves to A; a message in
   * topic B (or General) resolves to a different key and cannot consume it.
   *
   * Answer consumed by active ask_question elicitation -- never reaches
   * session message queue.
   */
  public pendingElicitations = new Map<string, (text: string) => void>();

  /**
   * Route keys whose active pendingElicitations entry was registered by a
   * ledger-originated (daemon-watch) elicitation rather than a session-local
   * ask_question call.
   *
   * Invariant: the idle-guard in handle() must fire the resolver for these
   * routes even when no AgentSession is active for the route (the REPL session
   * lives in a different process). Without this bypass, every phone reply to a
   * ledger-originated elicitation is silently dropped because the guard sees
   * no in-flight session and treats the pending entry as stale.
   *
   * Lifecycle: entries are added by makeTelegramElicitationHandler before it
   * installs the resolver (via the ledgerOriginatedElicitation flag passed by
   * the watch loop), and deleted when the resolver fires or is aborted -- exactly
   * mirroring the pendingElicitations Map lifecycle.
   */
  public ledgerOriginatedPendingChats = new Set<string>();

  /**
   * Chat IDs under the opt-in "tag-only" response policy. In these chats a
   * non-command text/photo message is answered only when addressed to the bot
   * (see {@link addressedToBot}); everything else is dropped silently (a log
   * line only, no reaction, no reply). Empty set => the policy applies to no
   * chat and every allowlisted chat behaves exactly as before.
   */
  private readonly tagOnlyChats: Set<number>;

  constructor(
    bot: Telegraf,
    sessionManager: SessionManager,
    registeredCommandChats: Set<number>,
    log: LogFn,
    tagOnlyChats: Set<number> = new Set()
  ) {
    this.bot = bot;
    this.sessionManager = sessionManager;
    this.registeredCommandChats = registeredCommandChats;
    this.log = log;
    this.tagOnlyChats = tagOnlyChats;
  }

  /**
   * Handle photo messages (with optional caption). Delegates to
   * handlePhotoImpl (message.photo-handler.ts) to stay within the 350-line
   * file ceiling while keeping the public surface unchanged.
   */
  async handlePhoto(ctx: Context): Promise<void> {
    await handlePhotoImpl(ctx, {
      bot: this.bot,
      sessionManager: this.sessionManager,
      registeredCommandChats: this.registeredCommandChats,
      tagOnlyChats: this.tagOnlyChats,
      log: this.log,
      isClaimed: (key) => this.isClaimed(key),
      reserveClaim: (key) => this.reserveClaim(key),
      releaseClaim: (key) => this.releaseClaim(key),
      enqueuePhoto: (route, ctx2, content) => this.enqueuePhoto(route, ctx2, content),
      processOne: (route, ctx2, content) => this.processOne(route, ctx2, content),
      MAX_QUEUE_DEPTH: MessageHandler.MAX_QUEUE_DEPTH,
      messageQueues: this.messageQueues as Map<string, unknown[]>,
    });
  }

  /** Handle document messages (PDF, text/code files). Mirrors handlePhoto. */
  async handleDocument(ctx: Context): Promise<void> {
    const route = routeFromCtx(ctx);
    if (!route) return;
    const chatId = route.chatId;

    // Tag-only response policy (mirrors handlePhoto): in a configured chat, drop a
    // document that is not addressed to the bot BEFORE any session or CDN work.
    // A document's caption carries the mention entities (caption_entities).
    // Fail-closed if the bot identity is unknown.
    if (this.tagOnlyChats.has(chatId)) {
      const botId = ctx.botInfo?.id;
      if (botId === undefined) {
        this.log(`[tag-only] Dropping document in chat ${chatId}: bot identity unknown (botInfo missing)`);
        return;
      }
      const msg = ctx.message as import('telegraf/types').Message.DocumentMessage | undefined;
      if (!addressedToBot(msg?.caption, msg?.caption_entities, msg?.reply_to_message?.from?.id, botId, ctx.botInfo?.username)) {
        this.log(`[tag-only] Dropping un-addressed document in chat ${chatId}`);
        return;
      }
    }

    const key = routeKey(route);
    let alreadyClaimed = false;
    try {
      alreadyClaimed = this.isClaimed(key);
      if (!alreadyClaimed) this.reserveClaim(key);
      const session = await this.sessionManager.getSession(route);
      registerChatCommands(this.bot, route.chatId, session, this.registeredCommandChats, this.log)
        .catch((err) => this.log('Failed to register chat commands:', err));
      if (session.state !== 'idle' || alreadyClaimed) {
        const q = this.messageQueues.get(key);
        if ((q?.length ?? 0) >= MessageHandler.MAX_QUEUE_DEPTH) {
          await ctx.reply('⏳ Queue full. Please wait for your messages to be processed.');
          return;
        }
      }
      const contentBlocks = await handleDocumentMessage(ctx, this.log);
      if (contentBlocks === null) return;
      if (session.state !== 'idle' || alreadyClaimed) {
        const depth = this.enqueueDocument(route, ctx, contentBlocks);
        if (depth !== false) await ctx.reply(formatQueued(depth));
        return;
      }
      await this.processOne(route, ctx, contentBlocks);
    } catch (err) {
      const raw = errorMessage(err);
      this.log('Document handling error:', raw.replace(/\/bot[^/]+\//g, '/bot[REDACTED]/'));
      await ctx.reply('❌ An error occurred processing your document. Please try again.');
    } finally {
      if (!alreadyClaimed) this.releaseClaim(key);
    }
  }

  /** Handle user text messages */
  async handle(ctx: Context): Promise<void> {
    const route = routeFromCtx(ctx);
    const chatId = route?.chatId;
    const messageText = (ctx.message as Message.TextMessage).text;

    if (!route || !chatId || !messageText) {
      return;
    }
    const key = routeKey(route);

    this.log(`📬 Message from chat ID: ${chatId}`);

    if (messageText.startsWith('/')) {
      return;
    }

    // Prepend a system-trusted sender marker in group/supergroup chats so the
    // model can tell participants apart (the whole group shares one per-chat
    // session). Byte-identical no-op in private chats. Computed AFTER the
    // slash-command check above (commands need the raw leading slash) and used
    // for pending elicitation, enqueue, and processOne paths. The tag-only gate
    // below still uses raw text + entity offsets for addressed-to-bot checks.
    // See sender-attribution.ts.
    const tgMsg = ctx.message as Message.TextMessage;
    const replyCtx = replyContextPrefix({
      replyToMessage: tgMsg.reply_to_message as RepliedMessage | undefined,
      quote: tgMsg.quote,
      botId: ctx.botInfo?.id,
    });
    const fwdPrefix = forwardProvenancePrefix(tgMsg);
    const attributedMessageText = replyCtx + fwdPrefix + senderPrefix(tgMsg.from, ctx.chat?.type) + messageText;
    // Elicitation answers must NOT carry the reply-context marker: answering an
    // ask_question by replying to the bot's own question is the natural gesture, and
    // the resolver needs the literal answer (a "[in reply to ...] 5" breaks number/
    // choice validation). Restores the pre-#688 elicitation value (senderPrefix + text).
    // forward provenance prefix is also excluded intentionally -- a forwarded elicitation answer would confuse the resolver
    const elicitationAnswer = senderPrefix(tgMsg.from, ctx.chat?.type) + messageText;

    // Durable handoff reply-to: route reply to a daemon handoff question to
    // the durable store. Checked BEFORE in-process elicitation (disjoint).
    if (tgMsg.reply_to_message?.message_id !== undefined) {
      const { matchReplyToHandoff } = await import('../handoff-answer.js');
      if (await matchReplyToHandoff(this.bot, chatId, tgMsg.reply_to_message.message_id, messageText)) return;
    }

    // Answer consumed by active ask_question elicitation -- never reaches
    // session message queue. Intercept BEFORE the session.state check so
    // that elicitation replies are never swallowed by the busy-queue branch.
    //
    // Guard: only route to the elicit resolver when the resolver is live.
    // Two cases are distinguished:
    //
    //   1. Ledger-originated elicitation (daemon watching a REPL session):
    //      the REPL session runs in a separate process, so this chat has NO
    //      in-flight AgentSession. We must fire the resolver regardless of
    //      session state -- the ledgerOriginatedPendingChats set tracks these
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
    // Resolve the elicitation by ROUTE key -- this is the topic-isolation seam:
    // a topic-A elicitation registered under A's key is never consumed by a
    // topic-B message (which resolves to a different key).
    const elicitResolver = this.pendingElicitations.get(key);
    if (elicitResolver) {
      // Case 1: ledger-originated bypass -- fire resolver without session check.
      if (this.ledgerOriginatedPendingChats.has(key)) {
        this.pendingElicitations.delete(key);
        this.ledgerOriginatedPendingChats.delete(key);
        elicitResolver(elicitationAnswer);
        return;
      }
      // Case 2: session-local -- fire only when the session is genuinely busy.
      const existingSession = this.sessionManager.getSessionIfExists(route);
      if (existingSession && existingSession.state !== 'idle') {
        this.pendingElicitations.delete(key);
        elicitResolver(elicitationAnswer);
        return;
      }
      // Stale entry -- session was reset while elicitation was in flight.
      this.log('[message] dropping stale pendingElicitation for route', key);
      this.pendingElicitations.delete(key);
    }

    // Tag-only response policy: in a configured chat, ignore any non-command
    // message that is not addressed to the bot. Runs AFTER the slash-command
    // early-return (commands are always honored) and AFTER the
    // pending-elicitation interception above (a live elicitation answer is
    // consumed there and returns before reaching this gate, so it is never
    // dropped regardless of tag-only status) -- but BEFORE the
    // ack/react/processOne path, so an un-addressed message produces NO
    // reaction and NO reply -- just a log line. Fail-closed if the bot
    // identity is unknown (botInfo is populated by Telegraf via getMe() on
    // launch and present on every ctx).
    if (this.tagOnlyChats.has(chatId)) {
      const botId = ctx.botInfo?.id;
      if (botId === undefined) {
        this.log(`[tag-only] Dropping message in chat ${chatId}: bot identity unknown (botInfo missing)`);
        return;
      }
      const msg = ctx.message as Message.TextMessage;
      if (!addressedToBot(msg.text, msg.entities, msg.reply_to_message?.from?.id, botId, ctx.botInfo?.username)) {
        this.log(`[tag-only] Dropping un-addressed message in chat ${chatId}`);
        return;
      }
    }

    let alreadyClaimed = false;
    try {
      // Ack the inbound message immediately (best-effort) so the user gets
      // instant feedback even while a prior turn is still streaming and this
      // message is queued. Mirrors the best-effort typing-indicator pattern.
      await ctx.react?.('👀').catch(() => {});

      // Invariant: reserve this chat's turn slot SYNCHRONOUSLY (no `await`
      // between the check and the reserve) before the async `session.state`
      // check below. See the `claimedChats` field doc for the exact race this
      // closes. `ctx.react` above is side-effect-free w.r.t. session state, so
      // reserving after it (rather than at function entry) is equivalent and
      // keeps the reaction-ack behavior unchanged for a losing call. Only
      // reserve when not already claimed so a losing concurrent call doesn't
      // inflate a count it never releases; processOne takes its own
      // reservation for the turn it runs (drain-path coverage,
      // #603 Item 1).
      alreadyClaimed = this.isClaimed(routeKey(route));
      if (!alreadyClaimed) this.reserveClaim(routeKey(route));

      const session = await this.sessionManager.getSession(route);

      // Register dynamic commands for this chat (non-blocking). Chat-scoped.
      registerChatCommands(this.bot, chatId, session, this.registeredCommandChats, this.log).catch(err =>
        this.log('Failed to register chat commands:', err)
      );

      const content = attributedMessageText;

      if (session.state !== 'idle' || alreadyClaimed) {
        const depth = this.enqueueMessage(route, ctx, content);
        if (depth !== false) await ctx.reply(formatQueued(depth));
        return;
      }

      await this.processOne(route, ctx, content);
    } catch (error) {
      this.log('Message handling error:', error);
      // Note: 'session is busy' is no longer handled here -- that race is covered
      // inside processOne's catch so it applies uniformly to all callers.
      if (isTelegramTransportError(error)) {
        // Telegram-side delivery failure -- not a Claude rate limit / network
        // error. Already logged; stay silent rather than misattribute it.
      } else if (isRateLimitError(error)) {
        await ctx.reply(formatRateLimitReply(error));
      } else if (isNetworkError(error)) {
        await ctx.reply('🌐 Network error. Please check your connection and try again.');
      } else {
        await ctx.reply(formatInternalError());
      }
    } finally {
      // Only the call that actually reserved the slot releases it -- a losing
      // (already-claimed) call never owned it and must not clear the winner's
      // still-in-flight claim out from under it. processOne holds its own
      // reservation for the turn it runs, so this release never drops the slot
      // while a turn (first or drained) is still streaming.
      if (!alreadyClaimed) this.releaseClaim(routeKey(route));
    }
  }

  /**
   * Process clear command when already idle (called from handlers).
   * Resets the session for THIS route only; the chat's other topics are
   * untouched. Command re-registration is chat-scoped (registeredCommandChats
   * keyed by chatId).
   */
  async processClearDirect(route: TelegramRoute, ctx: Context): Promise<void> {
    // Reserve a slot so any handle() arriving while clear is in flight sees the
    // chat as claimed and enqueues instead of double-entering. Mirrors the
    // reserveClaim/releaseClaim pattern in processOne. Paired 1:1 with the
    // releaseClaim in the finally.
    this.reserveClaim(routeKey(route));
    try {
      await this.sessionManager.resetSession(route);
      this.registeredCommandChats.delete(route.chatId);
      await ctx.reply(formatClear());
    } catch (error) {
      this.log('Clear error:', error);
      await ctx.reply(formatError(error as Error));
    } finally {
      // No drainQueue here: processClearDirect is itself called FROM drainQueue,
      // so re-draining would cascade back into drain and re-enter immediately.
      this.releaseClaim(routeKey(route));
    }
  }

  /**
   * Process compact command at drain time (session is idle when called).
   * Delegates to processCompactDirectImpl (message.compact-handler.ts) to stay
   * within the 350-line file ceiling while keeping the public surface unchanged.
   */
  private async processCompactDirect(route: TelegramRoute, ctx: Context): Promise<void> {
    await processCompactDirectImpl(route, ctx, {
      sessionManager: this.sessionManager,
      log: this.log,
      reserveClaim: (key) => this.reserveClaim(key),
      releaseClaim: (key) => this.releaseClaim(key),
      enqueueCompact: (r, c) => this.enqueueCompact(r, c),
      drainQueue: (r) => this.drainQueue(r),
    });
  }

  /** The queue for a route, creating it on first use. Keyed by routeKey. */
  private queueFor(route: TelegramRoute): Array<QueueItem> {
    const key = routeKey(route);
    let queue = this.messageQueues.get(key);
    if (!queue) {
      queue = [];
      this.messageQueues.set(key, queue);
    }
    return queue;
  }

  /**
   * Enqueue a text message for later processing.
   * Returns the 1-based queue depth on success, or false if the queue is full.
   */
  private enqueueMessage(route: TelegramRoute, ctx: Context, text: string): number | false {
    const queue = this.queueFor(route);
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
  private enqueuePhoto(route: TelegramRoute, ctx: Context, content: ContentBlockParam[]): number | false {
    const queue = this.queueFor(route);
    if (queue.length >= MessageHandler.MAX_QUEUE_DEPTH) {
      ctx.reply('⏳ Queue full. Please wait for your messages to be processed.').catch(() => {});
      return false;
    }
    queue.push({ type: 'photo', ctx, content });
    return queue.length; // 1-based depth after push
  }

  /** Enqueue a document message for later processing. Returns 1-based depth or false if full. */
  private enqueueDocument(route: TelegramRoute, ctx: Context, content: ContentBlockParam[]): number | false {
    const queue = this.queueFor(route);
    if (queue.length >= MessageHandler.MAX_QUEUE_DEPTH) {
      ctx.reply('⏳ Queue full. Please wait for your messages to be processed.').catch(() => {});
      return false;
    }
    queue.push({ type: 'document', ctx, content });
    return queue.length;
  }

  /**
   * Enqueue a clear command for later processing.
   * Respects MAX_QUEUE_DEPTH -- a /clear command issued while the queue is
   * full is dropped and the caller is notified rather than forcing the map
   * to grow without bound.
   */
  enqueueClear(route: TelegramRoute, ctx: Context): void {
    const queue = this.queueFor(route);
    if (queue.length >= MessageHandler.MAX_QUEUE_DEPTH) {
      ctx.reply('⏳ Queue full. Please wait for your messages to be processed.').catch(() => {});
      return;
    }
    queue.push({ type: 'clear', ctx });
  }

  /**
   * Enqueue a compact command for later processing.
   * Respects MAX_QUEUE_DEPTH -- a /compact command issued while the queue is
   * full is dropped and the caller is notified rather than forcing the map
   * to grow without bound.
   */
  enqueueCompact(route: TelegramRoute, ctx: Context): void {
    const queue = this.queueFor(route);
    if (queue.length >= MessageHandler.MAX_QUEUE_DEPTH) {
      ctx.reply('⏳ Queue full. Please wait for your messages to be processed.').catch(() => {});
      return;
    }
    queue.push({ type: 'compact', ctx });
  }

  /**
   * Process one message (text or content blocks): stream response, then drain queue.
   *
   * The busy-recovery path lives here rather than in each caller because the session
   * can transition from idle -> busy in the window between the caller's state-check
   * and this method's own getSession call (TOCTOU). Catching it here ensures the
   * item is re-enqueued regardless of which caller triggered processOne.
   *
   * Invariant: processOne reserves a `claimedChats` slot SYNCHRONOUSLY at entry
   * (below) and releases it only AFTER firing `drainQueue` in its finally. This
   * is what makes drain-dispatched turns get the same one-turn-at-a-time slot as
   * first turns (#603 Item 1): drainQueue is fired un-awaited from the finally,
   * so the drained turn's own processOne reservation must be taken (its
   * synchronous entry runs during the fire) BEFORE this turn's release drops the
   * count -- otherwise the slot would be momentarily empty between the outer
   * turn's release and the drained turn flipping `session.state`, and a fresh
   * handle() landing in that gap would double-enter. Reference counting (see the
   * claimedChats field doc) composes this turn's reservation with the outer
   * handle()/handlePhoto() guard and any drain re-entry.
   */
  private async processOne(route: TelegramRoute, ctx: Context, content: string | ContentBlockParam[]): Promise<void> {
    // Reserve this turn's slot synchronously, before the first `await` below, so
    // the slot is held continuously from dispatch through the finally's drain
    // hand-off. Paired 1:1 with the releaseClaim in the finally.
    this.reserveClaim(routeKey(route));
    // Guard against a busy-spin cascade: if the catch block re-enqueues the item
    // because the session is busy, we must NOT also drain -- the re-enqueued item will
    // be picked up by the active session's own drain cycle. Without this flag, the
    // `return` inside the catch path still executes `finally`, which calls drainQueue,
    // which shifts the item we just pushed and calls processOne again -> cascade.
    let reEnqueued = false;
    try {
      const session = await this.sessionManager.getSession(route);
      // User text for the stored turn record: joined text blocks (caption) for
      // content-block (photo) messages, the raw string otherwise.
      const userText = typeof content === 'string'
        ? content
        : content.map((b) => {
            if (b.type === 'text') return b.text;
            if (b.type === 'document') return `[document: ${(b as DocumentBlockParam).title ?? 'file'}]`;
            return '[image]';
          }).join(' ');
      // Keep the "typing..." indicator alive for the whole (often multi-minute)
      // streamed turn; a one-shot chat action would expire after ~5s.
      await withTypingIndicator(ctx, () =>
        streamResponse(ctx, session, prependToContent(drainBgInjections(routeKey(route)), content), this.log, {
          cleanFinal: true,
          // Record the completed turn into the shared session store so the CLI
          // can `--resume <name>` this Telegram conversation. Best-effort inside.
          onComplete: (assistantText, metadata) => {
            this.sessionManager.recordTelegramTurn(route, userText, assistantText, metadata);
          },
          // Map bot message ids -> session id for thumbs-reaction feedback.
          onBotMessage: (cid, mid) => { const sid = this.sessionManager.getSessionId(route); if (sid) reactionMap.set(cid, mid, sid); },
        }),
      );
    } catch (error) {
      this.log('Message handling error:', error);
      const busyMsg = (error as Error)?.message ?? '';
      if (busyMsg.includes('session is busy')) {
        // Session became busy between the caller's idle-check and our getSession call.
        // Re-enqueue the item so it isn't silently dropped.
        const depth = typeof content === 'string'
          ? this.enqueueMessage(route, ctx, content)
          : content.some((b) => b.type === 'document')
            ? this.enqueueDocument(route, ctx, content)
            : this.enqueuePhoto(route, ctx, content);
        if (depth !== false) await ctx.reply(formatQueued(depth));
        reEnqueued = true;
        return;
      }
      if (error instanceof StreamTimeoutError) {
        // Honest timeout -- the message already explains the cause. NOT a network
        // or Claude rate-limit error, so don't misclassify it as one.
        await ctx.reply(`⏱️ ${error.message}`);
      } else if (isTelegramTransportError(error)) {
        // A Telegram-side delivery failure (flood-control 429, transient 5xx) --
        // NOT a Claude problem. Reporting it as a Claude rate limit is the bug.
        // Already logged above; stay silent (a further reply would likely hit
        // the same Telegram limit), and let the queue drain normally.
      } else if (isRateLimitError(error)) {
        await ctx.reply(formatRateLimitReply(error));
      } else if (isNetworkError(error)) {
        await ctx.reply('🌐 Network error. Please check your connection and try again.');
      } else {
        await ctx.reply(formatInternalError());
      }
    } finally {
      // Order matters (#603 Item 1): fire drainQueue FIRST, then release. The
      // fire is un-awaited, so it runs the drained turn's own processOne up to
      // its first `await` -- including that turn's synchronous reserveClaim --
      // before releaseClaim below drops this turn's count. Reference counting
      // means the slot stays held (count > 0) across the hand-off, so a fresh
      // handle() arriving while the drained turn is still starting sees the
      // chat as claimed and enqueues instead of double-entering.
      //
      // Only drain when we did NOT just re-enqueue -- the active session's own
      // finally will drain the item we pushed; calling drain here too causes a
      // cascade.
      if (!reEnqueued) {
        this.drainQueue(route).catch(err => this.log('Drain error:', err));
      }
      this.releaseClaim(routeKey(route));
    }
  }

  /**
   * Process the next queued item for this route, if any.
   * Public so bot.ts can call it directly after /compact completes.
   */
  async drainQueue(route: TelegramRoute): Promise<void> {
    const key = routeKey(route);
    const queue = this.messageQueues.get(key);
    if (!queue?.length) return;
    const item = queue.shift()!;
    // Prune the map entry once the queue is empty so messageQueues does not
    // accumulate permanent entries for every route that has ever sent a message.
    if (queue.length === 0) this.messageQueues.delete(key);
    if (item.type === 'message') await this.processOne(route, item.ctx, item.text);
    else if (item.type === 'photo' || item.type === 'document') await this.processOne(route, item.ctx, item.content);
    else if (item.type === 'compact') await this.processCompactDirect(route, item.ctx);
    else await this.processClearDirect(route, item.ctx);
  }
}
