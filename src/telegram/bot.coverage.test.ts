/**
 * Additional coverage tests for src/telegram/bot.ts (COV-017).
 *
 * The existing bot.test.ts already covers construction, commands, message
 * handling, and lifecycle. This file targets the branches
 * still below 60% — primarily the handlers that are registered in
 * setupHandlers() but not yet exercised:
 *   - /compact (idle vs busy paths)
 *   - /watch / /unwatch
 *   - /sessions / /new callbacks
 *   - unsupported media type reply
 *   - stop() when not running (no-op)
 *   - getBusySessionCount()
 *   - a manual /watch survives past the retired 5s presence-scan interval
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
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
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
  // Manual /watch lifetime (automatic presence-driven watch is retired)
  // -------------------------------------------------------------------------
  describe('manual /watch lifetime', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test('a /watch started watch stays active well past 5s and start() schedules no presence scan', async () => {
      vi.useFakeTimers();
      const presence = await import('../agent/awareness/presence.js');
      const presenceSpy = vi.spyOn(presence, 'readLivePresenceFiles').mockResolvedValue([]);
      const watchMod = await import('./watch.js');
      vi.spyOn(watchMod, 'resolveWatchTarget').mockResolvedValue('sess-manual');
      // Replace the ledger tail with a loop that only ends on abort, so the
      // watch is registered exactly as a real one is and is torn down by stop().
      vi.spyOn(
        watchMod.SessionWatchManager.prototype as unknown as { _run: (...a: unknown[]) => Promise<void> },
        '_run',
      ).mockImplementation((...args: unknown[]) => {
        const signal = args[4] as AbortSignal;
        return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      });
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

      (bot as unknown as { bot: { launch: () => Promise<void> } }).bot.launch = vi.fn(async () => {});
      (bot as unknown as { bot: { telegram: { setMyCommands: () => Promise<void> } } }).bot.telegram.setMyCommands = vi.fn(async () => {});
      await bot.start();
      expect(setIntervalSpy.mock.calls.filter((c) => c[1] === 5_000)).toHaveLength(0);

      await command(bot, '/watch sess-manual');
      const wm = (bot as unknown as { watchManager: { watching: (id: number) => string | undefined } }).watchManager;
      expect(wm.watching(12345)).toBe('sess-manual');

      await vi.advanceTimersByTimeAsync(30_000);
      expect(wm.watching(12345)).toBe('sess-manual');
      expect(presenceSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy.mock.calls.filter((c) => c[1] === 5_000)).toHaveLength(0);
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
