/**
 * Telegram bot implementation using Telegraf
 * @module telegram/bot
 */

import { Telegraf, Context } from 'telegraf';
import { SessionManager, SessionManagerOptions } from './session-manager.js';
import { formatError, formatModelSwitch } from './formatter.js';
import { handleStart } from './handlers/start.js';
import { handleHelp } from './handlers/help.js';
import { handleClear, handleCompact, handleCwd, handleModelSwitch, handleName, MODEL_ALIASES_HINT } from './handlers/commands.js';
import type { AgentModelInput } from '../agent/types.js';
import { handleFarmCallback } from './handlers/farm-callbacks.js';
import { MessageHandler } from './handlers/message.js';
import { createAllowlistMiddleware } from './allowlist.js';
import { FARM_CALLBACK_PREFIX } from './farm-callback-data.js';
import { makeTelegramElicitationHandler } from './elicitation-handler.js';
import {
  createTelegramElicitationHandler,
  composeTelegramElicitation,
} from './elicitation-telegram.js';
import { elicitationRouter } from '../agent/elicitation-router.js';
import { SessionWatchManager, resolveWatchTarget, listWatchableSessions } from './watch.js';
import { splitLongMessage } from './formatter.js';

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
    this.bot = new Telegraf(options.botToken);
    this.sessionManager = new SessionManager(options);
    this.messageHandler = new MessageHandler(
      this.bot,
      this.sessionManager,
      this.registeredCommandChats,
      this.log.bind(this)
    );
    this.watchManager = new SessionWatchManager(this.log.bind(this));

    this.setupHandlers();
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
    this.bot.command('help', (ctx) => handleHelp(ctx, this.sessionManager));
    this.bot.command('clear', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.reply(formatError('Could not identify chat'));
        return;
      }
      const session = await this.sessionManager.getSession(chatId);
      if (session.state !== 'idle') {
        this.messageHandler.enqueueClear(chatId, ctx);
        await ctx.reply('Clear queued.');
      } else {
        await handleClear(ctx, this.sessionManager, this.registeredCommandChats, this.log.bind(this));
      }
    });
    this.bot.command('compact', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.reply(formatError('Could not identify chat'));
        return;
      }
      const session = await this.sessionManager.getSession(chatId);
      if (session.state !== 'idle') {
        this.messageHandler.enqueueCompact(chatId, ctx);
        await ctx.reply('Compact queued.');
      } else {
        try {
          await handleCompact(ctx, this.sessionManager, this.log.bind(this));
        } finally {
          this.messageHandler.drainQueue(chatId).catch(err => this.log('Drain error:', err));
        }
      }
    });
    this.bot.command('model', (ctx) =>
      handleModelSwitch(ctx, this.sessionManager, this.log.bind(this))
    );
    // `/cd` is the primary; `/cwd` is an alias matching the gather-investigation
    // user-facing label. Both route to the same handler.
    this.bot.command(['cd', 'cwd'], (ctx) =>
      handleCwd(ctx, this.sessionManager, this.log.bind(this))
    );
    this.bot.command('name', (ctx) =>
      handleName(ctx, this.sessionManager, this.log.bind(this))
    );
    // /watch <session> — live-tail another surface's session ledger into
    // this chat. /watch with no arg lists watchable sessions. The ledger is
    // written by every top-level AgentSession (CLI REPL, daemon, one-shot),
    // so this is the CLI→Telegram half of cross-surface continuity.
    this.bot.command('watch', async (ctx) => {
      const chatId = ctx.chat?.id;
      if (!chatId) {
        await ctx.reply(formatError('Could not identify chat'));
        return;
      }
      const text = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') ?? '';
      const arg = text.split(/\s+/).slice(1).join(' ').trim();
      try {
        if (!arg) {
          await ctx.reply(await listWatchableSessions());
          return;
        }
        const sessionId = await resolveWatchTarget(arg);
        if (!sessionId) {
          await ctx.reply(
            `No session ledger found for "${arg}". Use /watch with no argument to list watchable sessions.`,
          );
          return;
        }
        const send = async (msg: string): Promise<void> => {
          for (const part of splitLongMessage(msg)) {
            await ctx.telegram.sendMessage(chatId, part);
          }
        };
        this.watchManager.start(chatId, sessionId, send);
        await ctx.reply(`📡 Watching ${sessionId} — new activity will stream here. /unwatch to stop.`);
      } catch (error) {
        this.log('Watch error:', error);
        await ctx.reply(formatError(error as Error));
      }
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

    this.bot.on('text', (ctx) => this.messageHandler.handle(ctx));

    // Photo updates carry `message.photo[]` not `message.text` — they require
    // their own listener since Telegraf's filter is exact (a photo update never
    // matches the 'text' filter even if the user added a caption).
    this.bot.on('photo', (ctx) => this.messageHandler.handlePhoto(ctx));
    // Note: documents, voice notes, video, and stickers remain unhandled.
    // They can be added with the same pattern (download → build content blocks → processOne).

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
      const chatId = ctx.chat?.id;
      if (!chatId || !alias) return;

      // Validate alias is a known short alias (prevents arbitrary string injection)
      if (!(MODEL_ALIASES_HINT as readonly string[]).includes(alias)) return;

      try {
        await this.sessionManager.switchModel(chatId, alias);
        const confirmText = formatModelSwitch(alias);
        await ctx.editMessageText(confirmText).catch(() => ctx.reply(confirmText));
      } catch (err) {
        this.log('Model action error:', err);
      }
    });

    this.bot.catch((err, ctx) => {
      this.log('Bot error:', err);
      ctx.reply(formatError('An unexpected error occurred. Please try again.'))
        .catch(e => this.log('Failed to send error message:', e));
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
    }

    this.log('Starting bot...');
    await this.bot.launch();

    // Register commands with Telegram so they appear in the UI
    this.log('Registering bot commands...');
    await this.bot.telegram.setMyCommands([
      { command: 'start', description: 'Show welcome and command list' },
      { command: 'help', description: 'Show this command list' },
      { command: 'clear', description: 'Clear conversation history' },
      { command: 'compact', description: 'Compact conversation history' },
      { command: 'model', description: 'Switch Claude model (opus/sonnet/haiku)' },
      { command: 'cd', description: 'Show or change session working directory' },
      { command: 'name', description: 'Show or set the session name' },
      { command: 'watch', description: 'Live-tail a CLI session from this chat' },
      { command: 'unwatch', description: 'Stop watching a session' },
    ]);

    this.running = true;
    this.log('Bot started successfully');

    // Graceful shutdown handlers
    const shutdown = async (signal: string) => {
      this.log(`Received ${signal}, shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
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

    this.log('Uninstalling elicitation handler...');
    elicitationRouter.uninstall();

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

  async handleHelp(ctx: Context): Promise<void> {
    return handleHelp(ctx, this.sessionManager);
  }

  async handleClear(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.reply(formatError('Could not identify chat'));
      return;
    }
    const session = await this.sessionManager.getSession(chatId);
    if (session.state !== 'idle') {
      this.messageHandler.enqueueClear(chatId, ctx);
      await ctx.reply('Clear queued.');
    } else {
      return handleClear(ctx, this.sessionManager, this.registeredCommandChats, this.log.bind(this));
    }
  }

  async handleMessage(ctx: Context): Promise<void> {
    return this.messageHandler.handle(ctx);
  }

  async handlePhoto(ctx: Context): Promise<void> {
    return this.messageHandler.handlePhoto(ctx);
  }

  async handleModelSwitch(ctx: Context): Promise<void> {
    return handleModelSwitch(ctx, this.sessionManager, this.log.bind(this));
  }

  /**
   * Log message if verbose mode is enabled
   */
  private log(...args: unknown[]): void {
    if (this.options.verbose) {
      console.log('[TelegramBot]', ...args);
    }
  }
}

/** Inline regex escape (avoids pulling in lodash for one call site). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
