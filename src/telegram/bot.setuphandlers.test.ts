/**
 * Coverage for setupHandlers() closures in src/telegram/bot.ts (COV-017 cont.)
 *
 * The existing bot.test.ts drives handlers via the public test-facing methods
 * (handleStart, handleClear, …).  Those methods do NOT exercise the arrow-
 * function closures registered inside setupHandlers() — specifically the
 * bot.command / bot.on / bot.action registrations at lines 132-323.
 *
 * This file drives every remaining uncovered closure via inner.handleUpdate()
 * so V8 counts them as executed statements.  All external I/O (Telegram API,
 * filesystem, crypto) is mocked.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Module-level mock so the bot.ts import binding is replaced before any
// TelegramBot is constructed.  vi.spyOn cannot replace a constructor that
// bot.ts already holds a direct reference to via its top-level import.
const mockLedgerRecord = vi.fn();
vi.mock('../agent/session-ledger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../agent/session-ledger.js')>();
  return {
    ...orig,
    SessionLedgerWriter: class {
      constructor(_sid: string) {}
      record(...args: unknown[]) { mockLedgerRecord(...args); }
    },
  };
});
import { TelegramBot } from './bot.js';
import type { Context, Telegraf } from 'telegraf';
import type { AgentConfig } from '../agent/types.js';

// ---------------------------------------------------------------------------
// Bot factory
// ---------------------------------------------------------------------------

function makeBot(allowedChatIds: Set<number> = new Set([12345])): TelegramBot {
  const createSession = vi.fn(async (_cfg: AgentConfig) => ({
    state: 'idle' as const,
    closed: false,
    sendMessage: vi.fn(async () => ({
      role: 'assistant' as const,
      content: '',
      timestamp: new Date(),
    })),
    getOutputStream: async function* () {
      yield { type: 'done' as const };
    },
    abort: vi.fn(),
    close: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
  }));
  return new TelegramBot({
    botToken: 'tok',
    apiKey: 'key',
    dataDir: './test-data',
    verbose: false,
    allowedChatIds,
    createSession,
  });
}

// ---------------------------------------------------------------------------
// Helper: fire a bot command through the real Telegraf middleware chain.
// Returns the mocked callApi spy so callers can assert what was sent.
// ---------------------------------------------------------------------------

async function fireCommand(
  bot: TelegramBot,
  text: string,
  chatId = 12345,
  extra: Record<string, unknown> = {},
): Promise<ReturnType<typeof vi.fn>> {
  const inner = (bot as unknown as { bot: Telegraf<Context> }).bot;
  inner.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'T',
    username: 'bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  const api = vi
    .spyOn(Object.getPrototypeOf(inner.telegram) as object, 'callApi')
    .mockResolvedValue({ message_id: 1 });
  await inner.handleUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      text,
      date: 0,
      chat: { id: chatId, type: 'private', first_name: 'T' },
      from: { id: chatId, is_bot: false, first_name: 'T' },
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
      ...extra,
    },
  });
  return api;
}

// ---------------------------------------------------------------------------
// Helper: fire a callback_query action (for bot.action handlers)
// ---------------------------------------------------------------------------

async function fireAction(
  bot: TelegramBot,
  data: string,
  chatId = 12345,
): Promise<ReturnType<typeof vi.fn>> {
  const inner = (bot as unknown as { bot: Telegraf<Context> }).bot;
  inner.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'T',
    username: 'bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  const api = vi
    .spyOn(Object.getPrototypeOf(inner.telegram) as object, 'callApi')
    .mockResolvedValue({ message_id: 1, ok: true });
  await inner.handleUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: {
      id: 'cq1',
      from: { id: chatId, is_bot: false, first_name: 'T' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: chatId, type: 'private', first_name: 'T' },
        text: 'prev',
      },
    },
  });
  return api;
}

// ---------------------------------------------------------------------------
// Helper: fire a plain text message (bot.on('text') handler)
// ---------------------------------------------------------------------------

async function fireText(
  bot: TelegramBot,
  text: string,
  chatId = 12345,
): Promise<ReturnType<typeof vi.fn>> {
  const inner = (bot as unknown as { bot: Telegraf<Context> }).bot;
  inner.botInfo = {
    id: 1,
    is_bot: true,
    first_name: 'T',
    username: 'bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  const api = vi
    .spyOn(Object.getPrototypeOf(inner.telegram) as object, 'callApi')
    .mockResolvedValue({ message_id: 1 });
  await inner.handleUpdate({
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 2,
      text,
      date: 0,
      chat: { id: chatId, type: 'private', first_name: 'T' },
      from: { id: chatId, is_bot: false, first_name: 'T' },
      // No entities → not a command → triggers bot.on('text')
    },
  });
  return api;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelegramBot — setupHandlers() closure coverage', () => {
  let bot: TelegramBot;

  beforeEach(() => {
    bot = makeBot();
  });

  afterEach(async () => {
    await bot.stop().catch(() => {});
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // /start — closure on line 132
  // -------------------------------------------------------------------------
  describe('/start command closure', () => {
    test('handleStart is called via handleUpdate and bot replies', async () => {
      const api = await fireCommand(bot, '/start');
      expect(api).toHaveBeenCalledWith(
        'sendMessage',
        expect.objectContaining({ chat_id: 12345 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // /help — closure on line 133
  // -------------------------------------------------------------------------
  describe('/help command closure', () => {
    test('handleHelp is called via handleUpdate and bot replies', async () => {
      const api = await fireCommand(bot, '/help');
      expect(api).toHaveBeenCalledWith(
        'sendMessage',
        expect.objectContaining({ chat_id: 12345 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // /clear — closures on lines 134-147 (no-route and idle paths)
  // The no-route path requires a message with no chat — not achievable via
  // handleUpdate (Telegraf always populates ctx.chat from message.chat).
  // We drive the idle path (session.state === 'idle') via handleUpdate and
  // the no-route path via the public handleClear() method.
  // -------------------------------------------------------------------------
  describe('/clear command closure', () => {
    test('idle path: delegates to handleClear handler', async () => {
      const sm = (
        bot as unknown as {
          sessionManager: { getSession: (...a: unknown[]) => unknown };
        }
      ).sessionManager;
      vi.spyOn(sm, 'getSession').mockResolvedValueOnce({ state: 'idle' });
      // handleClear calls clearSessions which replies "cleared"
      const api = await fireCommand(bot, '/clear');
      // We just need the closure to have been entered — any sendMessage call confirms it.
      expect(api).toHaveBeenCalled();
    });

    test('busy path via closure: enqueues clear and replies "Clear queued."', async () => {
      const sm = (
        bot as unknown as {
          sessionManager: { getSession: (...a: unknown[]) => unknown };
        }
      ).sessionManager;
      vi.spyOn(sm, 'getSession').mockResolvedValueOnce({ state: 'streaming' });
      const mh = (
        bot as unknown as {
          messageHandler: { enqueueClear: (...a: unknown[]) => void };
        }
      ).messageHandler;
      const spy = vi.spyOn(mh, 'enqueueClear').mockImplementation(() => {});
      const api = await fireCommand(bot, '/clear');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(api).toHaveBeenCalledWith(
        'sendMessage',
        expect.objectContaining({ text: 'Clear queued.' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // /compact — closures on lines 148-165 (no-route and idle paths)
  // -------------------------------------------------------------------------
  describe('/compact command closure', () => {
    test('idle path: calls handleCompact then drainQueue (compact throws — error path)', async () => {
      const sm = (
        bot as unknown as {
          sessionManager: { getSession: (...a: unknown[]) => unknown };
        }
      ).sessionManager;
      vi.spyOn(sm, 'getSession').mockResolvedValueOnce({ state: 'idle' });
      const mh = (
        bot as unknown as {
          messageHandler: { drainQueue: (...a: unknown[]) => Promise<void> };
        }
      ).messageHandler;
      const drainSpy = vi.spyOn(mh, 'drainQueue').mockResolvedValue(undefined);
      const api = await fireCommand(bot, '/compact');
      // drainQueue is called in the finally block regardless of handleCompact result
      expect(drainSpy).toHaveBeenCalledTimes(1);
      expect(api).toHaveBeenCalled();
    });

    test('idle path: successful compact calls handleCompact and drainQueue', async () => {
      // Mock handleCompact to simulate a successful compaction (no throw).
      // handleCompact owns its own ctx.reply() internally, so we verify the
      // closure wired it correctly by asserting the spy was called.
      const commandsHandler = await import('./handlers/commands.js');
      const compactSpy = vi
        .spyOn(commandsHandler, 'handleCompact')
        .mockResolvedValueOnce(undefined);
      const sm = (
        bot as unknown as {
          sessionManager: { getSession: (...a: unknown[]) => unknown };
        }
      ).sessionManager;
      vi.spyOn(sm, 'getSession').mockResolvedValueOnce({ state: 'idle' });
      const mh = (
        bot as unknown as {
          messageHandler: { drainQueue: (...a: unknown[]) => Promise<void> };
        }
      ).messageHandler;
      const drainSpy = vi.spyOn(mh, 'drainQueue').mockResolvedValue(undefined);
      await fireCommand(bot, '/compact');
      expect(compactSpy).toHaveBeenCalledTimes(1);
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // /sessions — closure on lines 171-173
  // -------------------------------------------------------------------------
  describe('/sessions command closure', () => {
    test('handleSessions is called via handleUpdate', async () => {
      const sessionsHandler = await import('./handlers/sessions.js');
      const spy = vi
        .spyOn(sessionsHandler, 'handleSessions')
        .mockResolvedValue(undefined);
      await fireCommand(bot, '/sessions');
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // /new — closure on lines 174-176
  // -------------------------------------------------------------------------
  describe('/new command closure', () => {
    test('handleNew is called via handleUpdate', async () => {
      const sessionsHandler = await import('./handlers/sessions.js');
      const spy = vi.spyOn(sessionsHandler, 'handleNew').mockResolvedValue(undefined);
      await fireCommand(bot, '/new');
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // /watch — closures on lines 181-190
  // -------------------------------------------------------------------------
  describe('/watch command closure', () => {
    test('calls handleWatchCommand when route is resolved', async () => {
      const watchCmd = await import('./bot.watch-command.js');
      const spy = vi
        .spyOn(watchCmd, 'handleWatchCommand')
        .mockResolvedValue(undefined);
      await fireCommand(bot, '/watch some-session');
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // /unwatch — closures on lines 191-199 (the "stopped" path)
  // -------------------------------------------------------------------------
  describe('/unwatch command closure', () => {
    test('replies with stopped session name when watchManager.stop returns a value', async () => {
      const wm = (
        bot as unknown as {
          watchManager: { stop: (id: number) => string | undefined };
        }
      ).watchManager;
      vi.spyOn(wm, 'stop').mockReturnValue('sess-abc');
      const api = await fireCommand(bot, '/unwatch');
      expect(api).toHaveBeenCalledWith(
        'sendMessage',
        expect.objectContaining({ text: 'Stopped watching sess-abc.' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // /abort — closures on lines 209-234
  // -------------------------------------------------------------------------
  describe('/abort command closure', () => {
    test('replies with guidance when not watching any session', async () => {
      // Drive via the registered closure using no-chat path via public method
      // (no-chat cannot be reached via handleUpdate; use handleClear analog pattern).
      // We test the happy no-chat guard via the watchManager.getWatched early exit.
      const wm = (
        bot as unknown as {
          watchManager: { getWatched: (id: number) => string | undefined };
        }
      ).watchManager;
      vi.spyOn(wm, 'getWatched').mockReturnValue(undefined);
      const api = await fireCommand(bot, '/abort');
      // No session watched — bot replies with guidance text
      expect(api).toHaveBeenCalledWith(
        'sendMessage',
        expect.objectContaining({
          text: expect.stringContaining('Not watching any session'),
        }),
      );
    });

    test('replies "key not found" when readSessionKey returns null', async () => {
      const wm = (
        bot as unknown as {
          watchManager: { getWatched: (id: number) => string | undefined };
        }
      ).watchManager;
      vi.spyOn(wm, 'getWatched').mockReturnValue('sess-123');

      const channel = await import('../agent/afk-channel.js');
      vi.spyOn(channel, 'readSessionKey').mockReturnValue(null);

      const api = await fireCommand(bot, '/abort');
      expect(api).toHaveBeenCalledWith(
        'sendMessage',
        expect.objectContaining({
          text: expect.stringContaining('Session key not found'),
        }),
      );
    });

    test('happy path: signs abort and writes ledger record', async () => {
      const wm = (
        bot as unknown as {
          watchManager: { getWatched: (id: number) => string | undefined };
        }
      ).watchManager;
      vi.spyOn(wm, 'getWatched').mockReturnValue('sess-happy');

      const channel = await import('../agent/afk-channel.js');
      vi.spyOn(channel, 'readSessionKey').mockReturnValue('secret-key');
      vi.spyOn(channel, 'freshChannelId').mockReturnValue('nonce-1');
      vi.spyOn(channel, 'signAbortRequest').mockReturnValue('hmac-sig');

      mockLedgerRecord.mockClear();
      const api = await fireCommand(bot, '/abort');
      expect(mockLedgerRecord).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'abort_request' }),
      );
      expect(api).toHaveBeenCalledWith(
        'sendMessage',
        expect.objectContaining({ text: expect.stringContaining('Abort sent') }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // bot.on('text') → runDetached — line 264
  // The runDetached catch path (lines 253-263) fires when messageHandler.handle
  // rejects; the void-catch logs the sanitized error.
  // -------------------------------------------------------------------------
  describe("bot.on('text') — runDetached closure", () => {
    test('runDetached: handle() rejection is caught and logged (sanitized)', async () => {
      const mh = (
        bot as unknown as {
          messageHandler: { handle: (ctx: Context) => Promise<void> };
        }
      ).messageHandler;
      // Inject a bot-token URL to verify sanitization
      vi.spyOn(mh, 'handle').mockRejectedValueOnce(
        new Error('error at /bot12345:SECRET/path'),
      );
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const verboseBot = makeBot();
      // Make it verbose so the log path is reached
      (verboseBot as unknown as { options: { verbose: boolean } }).options.verbose = true;
      const mh2 = (
        verboseBot as unknown as {
          messageHandler: { handle: (ctx: Context) => Promise<void> };
        }
      ).messageHandler;
      vi.spyOn(mh2, 'handle').mockRejectedValueOnce(
        new Error('url /botTOKEN123/file leaked'),
      );
      await fireText(verboseBot, 'hello from user');
      // give microtasks a tick to settle
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(logSpy).toHaveBeenCalledWith(
        '[TelegramBot]',
        'Detached update handler error:',
        expect.stringContaining('[REDACTED]'),
      );
      await verboseBot.stop().catch(() => {});
    });
  });

  // -------------------------------------------------------------------------
  // bot.on('photo') and bot.on('document') — lines 269-270
  // -------------------------------------------------------------------------
  describe("bot.on('photo') and bot.on('document') closures", () => {
    test('photo update triggers runDetached(messageHandler.handlePhoto)', async () => {
      const inner = (bot as unknown as { bot: Telegraf<Context> }).bot;
      inner.botInfo = {
        id: 1,
        is_bot: true,
        first_name: 'T',
        username: 'bot',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      };
      const mh = (
        bot as unknown as {
          messageHandler: { handlePhoto: (ctx: Context) => Promise<void> };
        }
      ).messageHandler;
      const spy = vi.spyOn(mh, 'handlePhoto').mockResolvedValue(undefined);
      vi
        .spyOn(Object.getPrototypeOf(inner.telegram) as object, 'callApi')
        .mockResolvedValue({ message_id: 1 });

      await inner.handleUpdate({
        update_id: 2,
        message: {
          message_id: 3,
          date: 0,
          chat: { id: 12345, type: 'private', first_name: 'T' },
          from: { id: 12345, is_bot: false, first_name: 'T' },
          photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 100, height: 100 }],
        },
      });
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('document update triggers runDetached(messageHandler.handleDocument)', async () => {
      const inner = (bot as unknown as { bot: Telegraf<Context> }).bot;
      inner.botInfo = {
        id: 1,
        is_bot: true,
        first_name: 'T',
        username: 'bot',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      };
      const mh = (
        bot as unknown as {
          messageHandler: { handleDocument: (ctx: Context) => Promise<void> };
        }
      ).messageHandler;
      const spy = vi.spyOn(mh, 'handleDocument').mockResolvedValue(undefined);
      vi
        .spyOn(Object.getPrototypeOf(inner.telegram) as object, 'callApi')
        .mockResolvedValue({ message_id: 1 });

      await inner.handleUpdate({
        update_id: 3,
        message: {
          message_id: 4,
          date: 0,
          chat: { id: 12345, type: 'private', first_name: 'T' },
          from: { id: 12345, is_bot: false, first_name: 'T' },
          document: {
            file_id: 'f2',
            file_unique_id: 'u2',
            file_name: 'file.txt',
            mime_type: 'text/plain',
          },
        },
      });
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('unsupported media type (voice) triggers reply about unsupported type', async () => {
      const inner = (bot as unknown as { bot: Telegraf<Context> }).bot;
      inner.botInfo = {
        id: 1,
        is_bot: true,
        first_name: 'T',
        username: 'bot',
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      };
      const api = vi
        .spyOn(Object.getPrototypeOf(inner.telegram) as object, 'callApi')
        .mockResolvedValue({ message_id: 1 });

      await inner.handleUpdate({
        update_id: 4,
        message: {
          message_id: 5,
          date: 0,
          chat: { id: 12345, type: 'private', first_name: 'T' },
          from: { id: 12345, is_bot: false, first_name: 'T' },
          voice: { file_id: 'v1', file_unique_id: 'vu1', duration: 3 },
        },
      });
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(api).toHaveBeenCalledWith(
        'sendMessage',
        expect.objectContaining({
          text: expect.stringContaining('Voice transcription is not configured'),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // bot.action(/^afk:m:/) — lines 286-310
  // -------------------------------------------------------------------------
  describe("bot.action(/^afk:m:/) closure", () => {
    test('unknown alias is rejected silently (no reply)', async () => {
      // An alias not in MODEL_ALIASES_HINT returns early without switchModel
      const sm = (
        bot as unknown as {
          sessionManager: { switchModel: (...a: unknown[]) => Promise<void> };
        }
      ).sessionManager;
      const spy = vi.spyOn(sm, 'switchModel').mockResolvedValue(undefined);
      await fireAction(bot, 'afk:m:__invalid__');
      expect(spy).not.toHaveBeenCalled();
    });

    test('valid alias triggers switchModel and edits message', async () => {
      const sm = (
        bot as unknown as {
          sessionManager: { switchModel: (...a: unknown[]) => Promise<void> };
        }
      ).sessionManager;
      const switchSpy = vi.spyOn(sm, 'switchModel').mockResolvedValue(undefined);
      await fireAction(bot, 'afk:m:haiku');
      expect(switchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 12345 }),
        'haiku',
      );
    });

    test('switchModel error is caught and logged (verbose)', async () => {
      const verboseBot = makeBot();
      (verboseBot as unknown as { options: { verbose: boolean } }).options.verbose = true;
      const sm = (
        verboseBot as unknown as {
          sessionManager: { switchModel: (...a: unknown[]) => Promise<void> };
        }
      ).sessionManager;
      vi.spyOn(sm, 'switchModel').mockRejectedValueOnce(new Error('switch err'));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await fireAction(verboseBot, 'afk:m:sonnet');
      expect(logSpy).toHaveBeenCalledWith(
        '[TelegramBot]',
        'Model action error:',
        expect.any(Error),
      );
      logSpy.mockRestore();
      await verboseBot.stop().catch(() => {});
    });

    test('disallowed chat id is rejected silently', async () => {
      // Chat 99999 is not in allowedChatIds
      const sm = (
        bot as unknown as {
          sessionManager: { switchModel: (...a: unknown[]) => Promise<void> };
        }
      ).sessionManager;
      const spy = vi.spyOn(sm, 'switchModel').mockResolvedValue(undefined);
      await fireAction(bot, 'afk:m:haiku', 99999);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // bot.action(/^afk:sw:/) — lines 315-319
  // -------------------------------------------------------------------------
  describe("bot.action(/^afk:sw:/) closure", () => {
    test('handleSwitchCallback is called for allowed chat', async () => {
      const sessionsHandler = await import('./handlers/sessions.js');
      const spy = vi
        .spyOn(sessionsHandler, 'handleSwitchCallback')
        .mockResolvedValue(undefined);
      await fireAction(bot, 'afk:sw:sess-abc');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('disallowed chat id skips handleSwitchCallback', async () => {
      const sessionsHandler = await import('./handlers/sessions.js');
      const spy = vi
        .spyOn(sessionsHandler, 'handleSwitchCallback')
        .mockResolvedValue(undefined);
      await fireAction(bot, 'afk:sw:sess-abc', 99999);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // runAutoSubscribeTick inner loop — line 573 (watchManager.watching guard)
  // -------------------------------------------------------------------------
  describe('runAutoSubscribeTick — inner session loop', () => {
    test('starts a watch for a discovered AFK session not already watched', async () => {
      const presence = await import('../agent/awareness/presence.js');
      vi.spyOn(presence, 'readLivePresenceFiles').mockResolvedValueOnce([
        {
          sessionId: 'sess-new',
          surface: 'cli' as const,
          afk: true,
          pid: 1,
          startedAt: new Date().toISOString(),
        },
      ]);
      const wm = (
        bot as unknown as {
          watchManager: {
            getWatched: (id: number) => string | undefined;
            watching: (id: number) => string | undefined;
            start: (...a: unknown[]) => void;
          };
        }
      ).watchManager;
      vi.spyOn(wm, 'getWatched').mockReturnValue(undefined);
      vi.spyOn(wm, 'watching').mockReturnValue(undefined);
      const startSpy = vi.spyOn(wm, 'start').mockImplementation(() => {});

      await (
        bot as unknown as { runAutoSubscribeTick: () => Promise<void> }
      ).runAutoSubscribeTick();

      expect(startSpy).toHaveBeenCalledWith(
        12345,
        'sess-new',
        expect.any(Function),
        expect.any(Function),
      );
    });

    test('skips start when session is already watched', async () => {
      const presence = await import('../agent/awareness/presence.js');
      vi.spyOn(presence, 'readLivePresenceFiles').mockResolvedValueOnce([
        {
          sessionId: 'sess-existing',
          surface: 'cli' as const,
          afk: true,
          pid: 1,
          startedAt: new Date().toISOString(),
        },
      ]);
      const wm = (
        bot as unknown as {
          watchManager: {
            getWatched: (id: number) => string | undefined;
            watching: (id: number) => string | undefined;
            start: (...a: unknown[]) => void;
          };
        }
      ).watchManager;
      vi.spyOn(wm, 'getWatched').mockReturnValue(undefined);
      // watching() returns the same session → already watching, skip
      vi.spyOn(wm, 'watching').mockReturnValue('sess-existing');
      const startSpy = vi.spyOn(wm, 'start').mockImplementation(() => {});

      await (
        bot as unknown as { runAutoSubscribeTick: () => Promise<void> }
      ).runAutoSubscribeTick();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // onResumptionOffer catch path — line 101
  // -------------------------------------------------------------------------
  describe('onResumptionOffer — catch path', () => {
    test('returns false when sendMessage rejects', async () => {
      const inner = (bot as unknown as { bot: { telegram: { sendMessage: unknown } } }).bot;
      (inner.telegram as { sendMessage: (...a: unknown[]) => Promise<unknown> }).sendMessage =
        vi.fn(async () => {
          throw new Error('network');
        });
      const offer = (
        bot as unknown as {
          sessionManager: {
            options: {
              onResumptionOffer?: (
                r: { chatId: number },
                t: string,
              ) => Promise<boolean>;
            };
          };
        }
      ).sessionManager.options.onResumptionOffer;
      const result = await offer?.({ chatId: 12345 }, 'resume text');
      expect(result).toBe(false);
    });
  });
});
