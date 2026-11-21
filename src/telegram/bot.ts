/**
 * Telegram bot implementation using Telegraf
 * @module telegram/bot
 */

import { Telegraf, Context } from 'telegraf';
import { SessionManager, SessionManagerOptions } from './session-manager.js';
import { formatError } from './formatter.js';
import { handleStart } from './handlers/start.js';
import { MODEL_ALIASES_HINT } from '../agent/session/model-slots.js';
import { handleSessions, handleNew, handleSwitchCallback } from './handlers/sessions.js';
import { registerDelegatingCommands } from './bot.delegating-commands.js';
import { botCommandDescriptors } from './bot.command-descriptors.js';
import type { AgentModelInput } from '../agent/types.js';
import { handleFarmCallback } from './handlers/farm-callbacks.js';
import { MessageHandler } from './handlers/message.js';
import type { AudioTranscriber } from './audio-transcriber.js';
import { registerAudioHandlers } from './bot.audio-handler.js';
import { createAllowlistMiddleware } from './allowlist.js';
import { FARM_CALLBACK_PREFIX } from './farm-callback-data.js';
import { makeTelegramElicitationHandler } from './elicitation-handler.js';
import {
  createTelegramElicitationHandler,
  composeTelegramElicitation,
} from './elicitation-telegram.js';
import { elicitationRouter } from '../agent/elicitation-router.js';
import { ensurePluginEntrypointsLoaded } from '../agent/tools/skill-bridge.js';
import { SessionWatchManager } from './watch.js';
import { handleWatchCommand } from './bot.watch-command.js';
import { routeFromCtx, sendOptions } from './route.js';
import { escapeRegExp } from '../utils/regexp.js';
import { errorMessage } from '../utils/errors.js';
import { registerReactionHandler, ALLOWED_UPDATE_TYPES } from './bot.reaction-handler.js';
import { palette } from '../cli/palette.js';

/**
 * Bot configuration options
 */
export interface BotOptions extends SessionManagerOptions {
  /** Telegram bot token */
  botToken: string;

  /** Enable verbose logging */
  verbose?: boolean;

  /**
   * Chat IDs permitted to interact with the bot. An empty set rejects
   * every update (fail-closed). Sourced from AFK_TELEGRAM_ALLOWED_CHAT_IDS
   * in the bootstrap.
   */
  allowedChatIds: Set<number>;

  /**
   * Optional audio transcriber for voice/audio messages.  When null or omitted,
   * voice and audio messages receive a refusal reply naming the env var to set.
   * Constructed by entry.ts from the typed env object and injected here so the
   * single env read-point (env.ts) is preserved.
   */
  transcriber?: AudioTranscriber | null;

  /**
   * Chat IDs with the opt-in "tag-only" response policy: in these chats the bot
   * answers a non-command text/photo message only when addressed (a reply to
   * the bot, an @mention, or a text_mention resolving to the bot). Slash-
   * commands are unaffected; chats not in this set behave exactly as before.
   * An empty/omitted set (the default) applies the policy to no chat. Sourced
   * from afk.config.json `telegram.tagOnlyChats` (or the
   * AFK_TELEGRAM_TAG_ONLY_CHAT_IDS env fallback) in the bootstrap.
   */
  tagOnlyChats?: Set<number>;
}

/**
 * Telegram bot for Claude agent interactions
 */
export class TelegramBot {
  private bot: Telegraf;
  private sessionManager: SessionManager;
  private options: BotOptions;
  private running = false;
  private registeredCommandChats = new Set<number>();
  private messageHandler: MessageHandler;
  private watchManager: SessionWatchManager;

  constructor(options: BotOptions) {
    this.options = options;
    // Disable Telegraf's default handlerTimeout (90_000ms). It wraps the ENTIRE
    // update handler — a full agent turn — in a p-timeout, so any turn over 90s
    // total (sub-agents, web_scrape, long bash) rejects to `bot.catch` as a
    // generic "unexpected error" even though the AgentSession keeps running
    // (p-timeout does not abort the underlying promise). src/telegram/streaming.ts
    // is the real timeout authority: an inter-event, tool-in-flight-aware,
    // usage-limit-pause-aware watchdog that throws a handled StreamTimeoutError.
    // p-timeout short-circuits on Infinity, handing it sole timeout control.
    this.bot = new Telegraf(options.botToken, { handlerTimeout: Infinity });
    // Wire resumption-offer delivery into the session manager so wave manifests
    // surface as plain messages when a new chat session is created.
    // Build sessionManager first; messageHandler is constructed on the next line.
    // `onInjectableForRoute` closes over `this.messageHandler` which is
    // assigned synchronously below before any session is ever created (sessions
    // are built lazily on the first incoming Telegram update).
    let messageHandlerRef: MessageHandler | undefined;
    this.sessionManager = new SessionManager({
      ...options,
      onResumptionOffer: (route, text) => {
        return this.bot.telegram.sendMessage(route.chatId, text, sendOptions(route))
          .then(() => true as const)
          .catch(() => false as const);
      },
      // Wire the idle-wake callback: when a background subagent settles on an
      // idle Telegram session, synthesise a new turn immediately rather than
      // waiting for the next user message. Mirrors the REPL's
      // `bgResultNotifier.onInjectable = tryAutoResume` path in bootstrap-infra.ts.
      onInjectableForRoute: (chatId, threadId) => {
        const route = { chatId, ...(threadId !== undefined ? { threadId } : {}) };
        return () => { messageHandlerRef?.wakeIdleSession(route); };
      },
    });
    this.messageHandler = new MessageHandler(
      this.bot,
      this.sessionManager,
      this.registeredCommandChats,
      this.log.bind(this),
      options.tagOnlyChats ?? new Set()
    );
    // Resolve the closure reference now that messageHandler is fully constructed.
    messageHandlerRef = this.messageHandler;
    // Invariant: pass the SOLE Telegraf instance and the MessageHandler so
    // _run can render elicitation records interactively. No second bot
    // instance is created here — this.bot is the single getUpdates poller.
    this.watchManager = new SessionWatchManager(this.log.bind(this), this.bot, this.messageHandler);

    this.setupHandlers();
    // Reaction handler wired after setupHandlers so handler-registration order
    // matches: allowlist middleware → commands → text/photo/document → reactions.
    // Requires 'message_reaction' in allowedUpdates (wired in start()).
    registerReactionHandler(this.bot, this.log.bind(this));
  }

  /**
   * Setup bot command and message handlers
   */
  private setupHandlers(): void {
    // Ingress filter — drop updates from chat IDs outside the allowlist.
    // Installed before any command/text handler so unauthorized traffic
    // never reaches session creation or the agent.
    this.bot.use(createAllowlistMiddleware(this.options.allowedChatIds, this.log.bind(this)));

    this.bot.command('start', (ctx) => handleStart(ctx));
    // Shared-registry commands (/help, /clear, /compact, /model, /name, /cost,
    // /usage, ...) reach MessageHandler via the 'text' listener and run through
    // handlers/slash.ts; only Telegram-only commands are registered here.
    registerDelegatingCommands(this.bot, this.sessionManager, this.log.bind(this));
    // /sessions — list this chat's resumable conversations with tap-to-switch
    // buttons; /new — start a fresh conversation (previous preserved). One
    // active session per chat; switching stages a resume that continues on the
    // next message (see handlers/sessions.ts + SessionManager.switchToSession).
    this.bot.command('sessions', (ctx) =>
      handleSessions(ctx, this.sessionManager, this.log.bind(this))
    );
    this.bot.command('new', (ctx) =>
      handleNew(ctx, this.sessionManager, this.registeredCommandChats, this.log.bind(this))
    );
    // /watch <session> — live-tail another surface's session ledger into
    // this chat. /watch with no arg lists watchable sessions. The ledger is
    // written by every top-level AgentSession (CLI REPL, daemon, one-shot),
    // so this is the CLI→Telegram half of cross-surface continuity.
    this.bot.command('watch', async (ctx) => {
      const route = routeFromCtx(ctx);
      if (!route) {
        await ctx.reply(formatError('Could not identify chat'));
        return;
      }
      // Pin the streamed watch output to the topic /watch was invoked from
      // (General omits message_thread_id → default delivery, byte-identical).
      await handleWatchCommand(ctx, route, this.watchManager, sendOptions(route), this.log.bind(this));
    });
    this.bot.command('unwatch', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.reply(formatError('Could not identify chat'));
        return;
      }
      const stopped = this.watchManager.stop(chatId);
      await ctx.reply(stopped ? `Stopped watching ${stopped}.` : 'Not watching anything.');
    });

    // Invariant: a message update handler MUST NOT await the agent turn.
    // Telegraf's long-poll loop is `for await (updates) await Promise.all(
    // updates.map(handleUpdate))` (telegraf/lib/core/network/polling.js): it does
    // NOT fetch the next getUpdates batch until every handler in the current
    // batch settles. Awaiting the full turn here froze the poller for the turn's
    // entire lifetime, so a mid-turn elicitation (path-approval / ask_question)
    // could never receive the callback_query (button tap) or the text reply that
    // resolves it — the turn blocked on an update the frozen poller refused to
    // fetch, a deadlock broken only when the streaming watchdog timed the turn
    // out (~11 min later). Running the turn DETACHED frees the poller immediately;
    // per-chat ordering + one-turn-at-a-time are still enforced by
    // MessageHandler's queue + session busy-state (message.ts), exactly as they
    // already are for turns dispatched from processOne's finally→drainQueue.
    // handle()/handlePhoto() own their user-facing error handling, so
    // `runDetached`'s .catch is only a last-resort guard against an unhandled
    // rejection (e.g. a reply that throws after the bot is stopped).
    const runDetached = (work: Promise<void>): void => {
      void work.catch((err) => {
        // Redact any embedded bot token before logging — getFileLink() URLs
        // (https://api.telegram.org/file/bot<TOKEN>/<path>) can ride along in
        // an error string, and this last-resort catch would otherwise leak the
        // live token to the log. Same pattern handlePhoto's own catch applies
        // (#603 Item 2). Stringify safely first: `err` may be a non-Error.
        const rawErrStr = errorMessage(err);
        const sanitizedErr = rawErrStr.replace(/\/bot[^/]+\//g, '/bot[REDACTED]/');
        this.log('Detached update handler error:', sanitizedErr);
      });
    };
    this.bot.on('text', (ctx) => runDetached(this.messageHandler.handle(ctx)));

    // Photo updates carry `message.photo[]` not `message.text` — they require
    // their own listener since Telegraf's filter is exact (a photo update never
    // matches the 'text' filter even if the user added a caption).
    this.bot.on('photo', (ctx) => runDetached(this.messageHandler.handlePhoto(ctx)));
    this.bot.on('document', (ctx) => runDetached(this.messageHandler.handleDocument(ctx)));
    // Voice/audio → transcript → text turn (+ video/sticker refusal). See bot.audio-handler.ts.
    registerAudioHandlers(
      this.bot,
      this.options.transcriber ?? null,
      this.messageHandler,
      runDetached,
      this.log.bind(this),
      this.options.tagOnlyChats ?? new Set(),
    );


    // Inline-button callbacks emitted by the farm digest. The allowlist
    // middleware (registered above) already filters callback_query updates
    // by `ctx.chat?.id`, so by the time we get here the chat is trusted.
    // Routing regex is anchored to FARM_CALLBACK_PREFIX so other channels
    // (`afk:*:...`) can register their own action handler without conflict.
    const farmActionRe = new RegExp(`^${escapeRegExp(FARM_CALLBACK_PREFIX)}`);
    this.bot.action(farmActionRe, (ctx) =>
      handleFarmCallback(ctx, { log: this.log.bind(this) }),
    );

    // Inline-keyboard model-switch callbacks from the /model no-arg reply.
    // The alias allowlist check guards against crafted callback data.
    this.bot.action(/^afk:m:/, async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
      if (ctx.chat?.id !== undefined && !this.options.allowedChatIds.has(ctx.chat.id)) return;

      const data =
        typeof ctx.callbackQuery === 'object' && 'data' in ctx.callbackQuery
          ? (ctx.callbackQuery as { data: string }).data
          : '';
      const alias = data.replace('afk:m:', '') as AgentModelInput;
      // routeFromCtx reads the thread id off callbackQuery.message (the §11 fix),
      // so a /model tap inside a topic switches THAT topic's session, not General.
      const route = routeFromCtx(ctx);
      if (!route || !alias) return;

      // Validate alias is a known short alias (prevents arbitrary string injection)
      if (!(MODEL_ALIASES_HINT as readonly string[]).includes(alias)) return;

      try {
        // Same path as typing `/model <alias>`: the shared in-place switch,
        // which keeps the conversation (a teardown here would silently start
        // a new one). The command replies with its own confirmation.
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});
        await this.messageHandler.runSlash(ctx, route, `/model ${alias}`);
      } catch (err) {
        this.log('Model action error:', err);
      }
    });

    // Inline-keyboard session-switch callbacks from the /sessions reply. Prefix
    // afk:sw: is disjoint from afk:m: / afk:e: / afk:pa: / the farm prefix, so
    // taps never cross-route. Allowlist-guarded like the model action.
    this.bot.action(/^afk:sw:/, async (ctx) => {
      await ctx.answerCbQuery().catch(() => {});
      if (ctx.chat?.id !== undefined && !this.options.allowedChatIds.has(ctx.chat.id)) return;
      await handleSwitchCallback(ctx, this.sessionManager, this.log.bind(this));
    });

    this.bot.catch((err, ctx) => {
      this.log('Bot error:', err);
      if (ctx.chat) ctx.reply(formatError('An unexpected error occurred. Please try again.')).catch(e => this.log('Failed to send error message:', e));
    });
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Bot is already running');
    }

    this.log('Loading sessions...');
    await this.sessionManager.loadSessions();

    // Wire elicitation prompts to Telegram. TWO systems share the router:
    //   - ask_question (agent questions) → makeTelegramElicitationHandler
    //     (afk:e: inline buttons + typed replies via messageHandler).
    //   - path-approval + MCP form/url   → createTelegramElicitationHandler
    //     (afk:pa: enum keyboard).
    // They MUST be composed into a SINGLE installed handler: elicitationRouter
    // .install is last-wins, so installing both separately clobbers the first
    // (PR #477 review B1 — the path-approval install was silently overwritten
    // here). composeTelegramElicitation routes by request kind. Each factory
    // still registers its own DISJOINT bot.action prefix (afk:e:<digit>: vs
    // afk:pa:), so taps never cross-route (B2). Both factories run here, before
    // launch(), so their action handlers register ahead of the first update.
    const chatIds = [...this.options.allowedChatIds];
    if (chatIds.length > 0) {
      const primaryChatId = chatIds[0]!;
      const askHandler = makeTelegramElicitationHandler(
        this.messageHandler,
        this.bot,
        primaryChatId,
      );
      const formHandler = createTelegramElicitationHandler(
        this.bot,
        new Set(this.options.allowedChatIds),
        (...args) => this.log('[elicitation]', ...args),
      );
      elicitationRouter.install(composeTelegramElicitation(askHandler, formHandler));
      (await import('./handoff-answer.js')).registerHandoffAnswerHandlers(this.bot); // afk:h:* handoff buttons
    }

    // Import any plugin JS entrypoints (manifest `main`) before launching: each
    // per-chat session assembles its skill manifest synchronously at
    // construction, so a plugin's registerSkill() side-effects must already have
    // run before the first update is handled. Idempotent + non-fatal; no-op
    // without plugins.
    await ensurePluginEntrypointsLoaded();

    this.log('Starting bot...');
    // ALLOWED_UPDATE_TYPES includes everything Telegram delivers by default plus
    // 'message_reaction' (and 'message_reaction_count') which must be requested
    // explicitly; omitting them silences the reaction handler registered above.
    await this.bot.launch({ allowedUpdates: [...ALLOWED_UPDATE_TYPES] });

    // Register commands with Telegram so they appear in the UI
    this.log('Registering bot commands...');
    await this.bot.telegram.setMyCommands(await botCommandDescriptors());

    this.running = true;
    this.log('Bot started successfully');

    // Invariant: SIGINT/SIGTERM handlers are NOT registered here. Signal
    // ownership lives in the process entrypoint (entry.ts) so that resources
    // it created (sharedMemoryStore, statsInterval) are correctly torn down.
    // Adding handlers here would cause a double-shutdown sequence.
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.log('Stopping bot...');
    this.running = false;

    this.log('Uninstalling elicitation handler...'); elicitationRouter.uninstall();

    this.log('Stopping session watches...');
    await this.watchManager.stopAll();

    this.log('Closing sessions...');
    await this.sessionManager.closeAll();

    this.log('Stopping bot polling...');
    try {
      this.bot.stop();
    } catch (error) {
      // Ignore errors if bot wasn't fully started
      this.log('Error stopping bot (may not have been started):', error);
    }

    this.log('Bot stopped');
  }

  /**
   * Get bot statistics
   */
  getStats() {
    return {
      running: this.running,
      activeSessions: this.sessionManager.getSessionCount(),
      totalChats: this.sessionManager.getChatCount(),
    };
  }

  /**
   * Number of sessions currently mid-turn (streaming / processing / compacting).
   * The version-drift watchdog consults this to avoid exiting under an active
   * conversation — see startBot() in src/telegram.ts.
   */
  getBusySessionCount(): number {
    return this.sessionManager.getBusySessionCount();
  }

  /**
   * Test-facing handler methods (delegates to handlers module)
   * These are used by tests to invoke handlers directly without starting the bot
   */

  async handleStart(ctx: Context): Promise<void> {
    return handleStart(ctx);
  }

  async handleMessage(ctx: Context): Promise<void> {
    return this.messageHandler.handle(ctx);
  }

  async handlePhoto(ctx: Context): Promise<void> {
    return this.messageHandler.handlePhoto(ctx);
  }

  async handleDocument(ctx: Context): Promise<void> {
    return this.messageHandler.handleDocument(ctx);
  }

  /**
   * Log message if verbose mode is enabled
   */
  private log(...args: unknown[]): void {
    if (this.options.verbose) {
      console.log(palette.dim('[TelegramBot]'), ...args);
    }
  }
}
