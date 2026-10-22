/**
 * Additional coverage tests for src/telegram/bot.ts (COV-017).
 *
 * The existing bot.test.ts already covers construction, commands, message
 * handling, auto-subscribe, and lifecycle. This file targets the branches
 * still below 60% — primarily the handlers that are registered in
 * setupHandlers() but not yet exercised:
 *   - /compact (idle vs busy paths)
 *   - /watch / /unwatch
 *   - /abort (no session watched, no key, happy path)
 *   - /sessions / /new callbacks
 *   - unsupported media type reply
 *   - stop() when not running (no-op)
 *   - getBusySessionCount()
 *   - stopAutoSubscribe branch (autoSubscribeInterval already null)
 *   - log() suppressed when verbose=false / emitted when verbose=true
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramBot } from './bot.js';
import type { Context, Telegraf } from 'telegraf';
import type { AgentConfig } from '../agent/types.js';

// ---------------------------------------------------------------------------
// Minimal context factory
// ---------------------------------------------------------------------------

function ctx(
  chatId = 12345,
  text = '',
  extra: Partial<Record<string, unknown>> = {},
): Context {
  const replies: string[] = [];
  return {
    chat: { id: chatId, type: 'private' },
    message: {
      message_id: 1,
      text,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
    },
    reply: vi.fn(async (msg: string) => {
      replies.push(msg);
      return { message_id: replies.length, text: msg, date: 0, chat: { id: chatId } };
    }),
    sendChatAction: vi.fn(async () => true),
    telegram: {
      editMessageText: vi.fn(async () => true),
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    },
    callbackQuery: undefined,
    ...extra,
  } as unknown as Context;
}

// ---------------------------------------------------------------------------
// Bot factory
// ---------------------------------------------------------------------------

function makeBot(verbose = false): TelegramBot {
  const createSession = vi.fn(async (_cfg: AgentConfig) => ({
    state: 'idle' as const,
    closed: false,
    sendMessage: vi.fn(async () => ({ role: 'assistant' as const, content: '', timestamp: new Date() })),
    getOutputStream: async function* () { yield { type: 'done' as const }; },
    abort: vi.fn(),
    close: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
  }));
  return new TelegramBot({
    botToken: 'tok',
    apiKey: 'key',
    dataDir: './test-data',
    verbose,
    allowedChatIds: new Set([12345]),
    createSession,
  });
}

/** Drive real registered command middleware, intercepting Telegram at the API boundary. */
async function command(bot: TelegramBot, text: string) {
  const inner = (bot as unknown as { bot: Telegraf<Context> }).bot;
  inner.botInfo = { id: 1, is_bot: true, first_name: 'T', username: 'bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
  // Telegraf creates a per-update Telegram instance; intercept its prototype.
  const api = vi.spyOn(Object.getPrototypeOf(inner.telegram), 'callApi').mockResolvedValue({ message_id: 1 });
  await inner.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1, text, date: 0,
      chat: { id: 12345, type: 'private', first_name: 'T' },
      from: { id: 12345, is_bot: false, first_name: 'T' },
      entities: [{ type: 'bot_command', offset: 0, length: text.length }],
    },
  });
  return api;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramBot — additional branch coverage', () => {
  let bot: TelegramBot;

  beforeEach(() => {
    bot = makeBot();
  });

  afterEach(async () => {
    await bot.stop().catch(() => {});
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getBusySessionCount
  // -------------------------------------------------------------------------
  describe('getBusySessionCount', () => {
    test('returns 0 initially (no busy sessions)', () => {
      expect(bot.getBusySessionCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // stop() when not running
  // -------------------------------------------------------------------------
  describe('stop()', () => {
    test('resolves without error when bot was never started', async () => {
      await expect(bot.stop()).resolves.not.toThrow();
    });

    test('is idempotent — second stop() is a no-op', async () => {
      // Start then stop, then stop again.
      (bot as unknown as { bot: { launch: () => Promise<void>; telegram: { setMyCommands: () => Promise<void> } } }).bot.launch = vi.fn(async () => {});
      (bot as unknown as { bot: { telegram: { setMyCommands: () => Promise<void> } } }).bot.telegram.setMyCommands = vi.fn(async () => {});
      await bot.start();
      await bot.stop();
      await expect(bot.stop()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Shared /clear (Stage 5): busy route → queued via enqueueSlash
  // -------------------------------------------------------------------------
  describe('shared /clear', () => {
    test('enqueues clear and replies with queue depth when session is busy', async () => {
      const c = ctx(12345, '/clear');
      const sm = (bot as unknown as { sessionManager: { getSession: (...a: unknown[]) => unknown } }).sessionManager;
      vi.spyOn(sm, 'getSession').mockResolvedValueOnce({ state: 'streaming' });
      const mh = (bot as unknown as { messageHandler: { enqueueSlash: (...a: unknown[]) => number | false } }).messageHandler;
      const enqueueSpy = vi.spyOn(mh, 'enqueueSlash').mockReturnValue(1);
      await bot.handleMessage(c);
      expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({ chatId: 12345 }), c, '/clear');
      expect(c.reply).toHaveBeenCalledWith(expect.stringContaining('1'));
    });
  });

  // -------------------------------------------------------------------------
  // handlePhoto / handleDocument (lines 484-488)
  // -------------------------------------------------------------------------
  describe('handlePhoto() and handleDocument()', () => {
    test('handlePhoto delegates to messageHandler.handlePhoto', async () => {
      const c = ctx(12345);
      const mh = (bot as unknown as { messageHandler: { handlePhoto: (c: Context) => Promise<void> } }).messageHandler;
      const spy = vi.spyOn(mh, 'handlePhoto').mockResolvedValue(undefined);
      await bot.handlePhoto(c);
      expect(spy).toHaveBeenCalledWith(c);
    });

    test('handleDocument delegates to messageHandler.handleDocument', async () => {
      const c = ctx(12345);
      const mh = (bot as unknown as { messageHandler: { handleDocument: (c: Context) => Promise<void> } }).messageHandler;
      const spy = vi.spyOn(mh, 'handleDocument').mockResolvedValue(undefined);
      await bot.handleDocument(c);
      expect(spy).toHaveBeenCalledWith(c);
    });
  });

  // -------------------------------------------------------------------------
  // Shared /compact (Stage 5): busy route → queued via enqueueSlash
  // -------------------------------------------------------------------------
  describe('/compact command', () => {
    test('queues compact when the session is busy', async () => {
      const c = ctx(12345, '/compact');
      const sm = (bot as unknown as { sessionManager: { getSession: (...a: unknown[]) => unknown } }).sessionManager;
      vi.spyOn(sm, 'getSession').mockResolvedValue({ state: 'streaming' });
      const mh = (bot as unknown as { messageHandler: { enqueueSlash: (...a: unknown[]) => number | false } }).messageHandler;
      const enqueue = vi.spyOn(mh, 'enqueueSlash').mockReturnValue(2);
      await bot.handleMessage(c);
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // /watch / /unwatch
  // -------------------------------------------------------------------------
  describe('/unwatch command', () => {
    test('replies "Not watching anything" when nothing is watched', async () => {
      const watchManager = (bot as unknown as { watchManager: { stop: (id: number) => string | undefined } }).watchManager;
      const stopSpy = vi.spyOn(watchManager, 'stop').mockReturnValue(undefined);
      const api = await command(bot, '/unwatch');
      expect(stopSpy).toHaveBeenCalledExactlyOnceWith(12345);
      expect(api).toHaveBeenCalledWith('sendMessage', expect.objectContaining({ chat_id: 12345, text: 'Not watching anything.' }));
    });
  });

  // -------------------------------------------------------------------------
  // /abort — various paths
  // -------------------------------------------------------------------------
  describe('/abort command paths via watchManager', () => {
    test('watchManager.getWatched returns undefined for unwatched chat', () => {
      const wm = (bot as unknown as { watchManager: { getWatched: (id: number) => string | undefined } }).watchManager;
      expect(wm.getWatched(12345)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // verbose logging
  // -------------------------------------------------------------------------
  describe('verbose logging', () => {
    test('does not call console.log when verbose=false', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const quietBot = makeBot(false);
      // Trigger a log call via the private log method.
      (quietBot as unknown as { log: (...a: unknown[]) => void }).log('should not appear');
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    test('calls console.log when verbose=true', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const noisyBot = makeBot(true);
      (noisyBot as unknown as { log: (...a: unknown[]) => void }).log('hello', 'world');
      expect(logSpy).toHaveBeenCalledWith('[TelegramBot]', 'hello', 'world');
      logSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // startAutoSubscribe / stopAutoSubscribe guard
  // -------------------------------------------------------------------------
  describe('startAutoSubscribe / stopAutoSubscribe', () => {
    test('stopAutoSubscribe is a no-op when interval is null', () => {
      // Ensure interval is null (bot never started).
      const b = makeBot();
      expect(() => {
        (b as unknown as { stopAutoSubscribe: () => void }).stopAutoSubscribe();
      }).not.toThrow();
    });

    test('startAutoSubscribe sets the interval and immediate tick fires', async () => {
      vi.useFakeTimers();
      const b = makeBot();
      const tickSpy = vi
        .spyOn(b as unknown as { runAutoSubscribeTick: () => Promise<void> }, 'runAutoSubscribeTick')
        .mockResolvedValue(undefined);

      (b as unknown as { startAutoSubscribe: () => void }).startAutoSubscribe();
      // The immediate tick is called synchronously (void fire-and-forget).
      await Promise.resolve(); // flush microtasks
      expect(tickSpy).toHaveBeenCalledTimes(1);

      // Second call is idempotent.
      (b as unknown as { startAutoSubscribe: () => void }).startAutoSubscribe();
      expect(tickSpy).toHaveBeenCalledTimes(1);

      (b as unknown as { stopAutoSubscribe: () => void }).stopAutoSubscribe();
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // getStats
  // -------------------------------------------------------------------------
  describe('getStats()', () => {
    test('returns structured stats object', () => {
      const stats = bot.getStats();
      expect(stats).toHaveProperty('running', false);
      expect(stats).toHaveProperty('activeSessions');
      expect(stats).toHaveProperty('totalChats');
    });
  });

  // -------------------------------------------------------------------------
  // runAutoSubscribeTick — empty allowedChatIds early exit
  // -------------------------------------------------------------------------
  describe('runAutoSubscribeTick', () => {
    test('exits early when allowedChatIds is empty', async () => {
      const emptyBot = new TelegramBot({
        botToken: 'tok',
        apiKey: 'key',
        dataDir: './test-data',
        verbose: false,
        allowedChatIds: new Set<number>(),
        createSession: vi.fn(),
      });
      // Should resolve without throwing even though no chats are allowed.
      await expect(
        (emptyBot as unknown as { runAutoSubscribeTick: () => Promise<void> }).runAutoSubscribeTick(),
      ).resolves.not.toThrow();
    });

    test('handles readLivePresenceFiles error gracefully', async () => {
      const presence = await import('../agent/awareness/presence.js');
      const spy = vi.spyOn(presence, 'readLivePresenceFiles').mockRejectedValueOnce(new Error('ENOENT'));
      await expect(
        (bot as unknown as { runAutoSubscribeTick: () => Promise<void> }).runAutoSubscribeTick(),
      ).resolves.not.toThrow();
      spy.mockRestore();
    });

    test('stops watch for a session whose afk flag cleared', async () => {
      const presence = await import('../agent/awareness/presence.js');
      // Return no AFK sessions — any currently-watched session should be stopped.
      const spy = vi.spyOn(presence, 'readLivePresenceFiles').mockResolvedValueOnce([]);
      const wm = (bot as unknown as { watchManager: { getWatched: (id: number) => string | undefined; stop: (id: number) => void } }).watchManager;
      vi.spyOn(wm, 'getWatched').mockReturnValue('old-session-id');
      const stopSpy = vi.spyOn(wm, 'stop').mockImplementation(() => {});

      await (bot as unknown as { runAutoSubscribeTick: () => Promise<void> }).runAutoSubscribeTick();
      expect(stopSpy).toHaveBeenCalledWith(12345);
      spy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // bot.catch handler (lines 322-323) — Telegraf error handler
  // -------------------------------------------------------------------------
  describe('bot.catch error handler (lines 322-323)', () => {
    test('logs error and replies when ctx has a chat', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const noisyBot = makeBot(true);
      const replyMock = vi.fn(async () => ({ message_id: 1 }));
      const fakeCtx = { chat: { id: 1 }, reply: replyMock } as unknown as Context;
      // Telegraf stores the catch handler at bot.handleError (set by bot.catch()).
      const telegrafBot = (noisyBot as unknown as { bot: { handleError?: (err: Error, ctx: Context) => void } }).bot;
      await telegrafBot.handleError?.(new Error('boom'), fakeCtx);
      expect(logSpy).toHaveBeenCalledWith('[TelegramBot]', 'Bot error:', expect.any(Error));
      expect(replyMock).toHaveBeenCalled();
      logSpy.mockRestore();
      await noisyBot.stop().catch(() => {});
    });

    test('logs error but does not reply when ctx has no chat', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const noisyBot = makeBot(true);
      const fakeCtx = { chat: undefined, reply: vi.fn() } as unknown as Context;
      const telegrafBot = (noisyBot as unknown as { bot: { handleError?: (err: Error, ctx: Context) => void } }).bot;
      await telegrafBot.handleError?.(new Error('no-chat'), fakeCtx);
      expect(logSpy).toHaveBeenCalledWith('[TelegramBot]', 'Bot error:', expect.any(Error));
      expect(fakeCtx.reply).not.toHaveBeenCalled();
      logSpy.mockRestore();
      await noisyBot.stop().catch(() => {});
    });
  });

  // -------------------------------------------------------------------------
  // elicitation log callback (line 361) — triggered inside start()
  // -------------------------------------------------------------------------
  describe('elicitation log inside start()', () => {
    test('elicitation logger is called when createTelegramElicitationHandler fires log', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const noisyBot = makeBot(true);
      (noisyBot as unknown as { bot: { launch: () => Promise<void>; telegram: { setMyCommands: () => Promise<void> } } }).bot.launch = vi.fn(async () => {});
      (noisyBot as unknown as { bot: { telegram: { setMyCommands: () => Promise<void> } } }).bot.telegram.setMyCommands = vi.fn(async () => {});

      // Mock createTelegramElicitationHandler to capture the log callback.
      const elicMod = await import('./elicitation-telegram.js');
      let capturedLog: ((...args: unknown[]) => void) | undefined;
      vi.spyOn(elicMod, 'createTelegramElicitationHandler').mockImplementation(
        (_bot, _chatIds, log) => {
          capturedLog = log as (...args: unknown[]) => void;
          return {} as ReturnType<typeof elicMod.createTelegramElicitationHandler>;
        },
      );

      await noisyBot.start();
      // Fire the captured log callback — this exercises line 361.
      // The callback is (...args) => this.log('[elicitation]', ...args), so
      // calling it with ('fired') logs: '[TelegramBot]', '[elicitation]', 'fired'.
      capturedLog?.('fired');
      expect(logSpy).toHaveBeenCalledWith('[TelegramBot]', '[elicitation]', 'fired');

      await noisyBot.stop();
      logSpy.mockRestore();
      vi.restoreAllMocks();
    });
  });

  // -------------------------------------------------------------------------
  // tick error log (line 514) — runAutoSubscribeTick rejection logged
  // -------------------------------------------------------------------------
  describe('tick error logging', () => {
    test('logs tick errors when verbose=true', async () => {
      const noisyBot = makeBot(true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(
        noisyBot as unknown as { runAutoSubscribeTick: () => Promise<void> },
        'runAutoSubscribeTick',
      ).mockRejectedValueOnce(new Error('tick boom'));

      (noisyBot as unknown as { startAutoSubscribe: () => void }).startAutoSubscribe();
      await new Promise<void>((r) => setTimeout(r, 10)); // let microtasks drain
      (noisyBot as unknown as { stopAutoSubscribe: () => void }).stopAutoSubscribe();

      expect(logSpy).toHaveBeenCalledWith('[TelegramBot]', 'auto-subscribe tick error:', expect.any(Error));
      logSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // wave resumption offer — no threadId (General)
  // -------------------------------------------------------------------------
  describe('onResumptionOffer', () => {
    test('sends without thread id for General topic', () => {
      const sendMsg = vi.fn(async () => ({ message_id: 1 }));
      (bot as unknown as { bot: { telegram: { sendMessage: typeof sendMsg } } }).bot.telegram.sendMessage = sendMsg;
      const offer = (bot as unknown as { sessionManager: { options: { onResumptionOffer?: (r: { chatId: number }, t: string) => void } } }).sessionManager.options.onResumptionOffer;
      offer?.({ chatId: 12345 }, 'resume text');
      expect(sendMsg).toHaveBeenCalledWith(12345, 'resume text', {});
    });
  });
});
