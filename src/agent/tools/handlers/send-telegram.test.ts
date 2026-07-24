import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSendTelegramHandler } from './send-telegram.js';
import type { PushOptions, PushResult } from '../../../telegram/push.js';
import { loadTelegramConfig } from '../../../cli/config.js';

// loadTelegramConfig reads afk.config.json; mock it so target resolution is
// driven purely by the env vars the harness sets (hermetic). The pure resolver
// is exhaustively covered in src/telegram/notify-routing.test.ts. The mock is
// per-test-overridable so we can inject telegram.chatAliases for alias tests.
vi.mock('../../../cli/config.js', () => ({ loadTelegramConfig: vi.fn(() => ({})) }));

const mockLoadTelegramConfig = vi.mocked(loadTelegramConfig);

type PushFn = (options: PushOptions) => Promise<PushResult>;

const OK_RESULT: PushResult = { ok: true, status: 200 };

function setOrDelete(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function makeHarness(opts: {
  token?: string;
  allowed?: string;
  /** Sets AFK_TELEGRAM_NOTIFY_MODE — `broadcast` restores the legacy fan-out. */
  mode?: string;
  /** Injected telegram.chatAliases (name → chat id) for alias-resolution tests. */
  aliases?: Record<string, number>;
  pushFn?: PushFn;
} = {}) {
  setOrDelete('TELEGRAM_BOT_TOKEN', opts.token);
  setOrDelete('AFK_TELEGRAM_ALLOWED_CHAT_IDS', opts.allowed);
  setOrDelete('AFK_TELEGRAM_NOTIFY_MODE', opts.mode);

  mockLoadTelegramConfig.mockReturnValue(
    opts.aliases !== undefined ? { chatAliases: opts.aliases } : {},
  );

  const pushFn = vi.fn<PushFn>(opts.pushFn ?? (async () => OK_RESULT));
  const handler = createSendTelegramHandler(pushFn);
  return { handler, pushFn };
}

describe('send_telegram handler', () => {
  const ENV_KEYS = [
    'TELEGRAM_BOT_TOKEN',
    'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
    'AFK_TELEGRAM_NOTIFY_MODE',
    'AFK_TELEGRAM_PRIMARY_CHAT_ID',
  ] as const;
  const orig: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      orig[k] = process.env[k];
      delete process.env[k];
    }
    mockLoadTelegramConfig.mockReturnValue({});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) setOrDelete(k, orig[k]);
    vi.clearAllMocks();
  });

  const signal = new AbortController().signal;

  describe('input validation', () => {
    it('rejects non-object input', async () => {
      const { handler } = makeHarness({ token: 't', allowed: '123' });
      const r = await handler('hello' as unknown, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/expected an object/);
    });

    it('rejects missing message', async () => {
      const { handler } = makeHarness({ token: 't', allowed: '123' });
      const r = await handler({}, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/message must be a string/);
    });

    it('rejects non-string message', async () => {
      const { handler } = makeHarness({ token: 't', allowed: '123' });
      const r = await handler({ message: 42 }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/message must be a string/);
    });

    it('rejects empty message', async () => {
      const { handler } = makeHarness({ token: 't', allowed: '123' });
      const r = await handler({ message: '' }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/non-empty/);
    });

    it('rejects message over 4096 chars', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '123' });
      const r = await handler({ message: 'x'.repeat(4097) }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/4096-character limit/);
      expect(pushFn).not.toHaveBeenCalled();
    });

    it('accepts message at exactly 4096 chars', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '123' });
      const r = await handler({ message: 'x'.repeat(4096) }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledOnce();
    });
  });

  describe('configuration errors', () => {
    it('errors when bot token is unset', async () => {
      const { handler, pushFn } = makeHarness({ allowed: '123' });
      const r = await handler({ message: 'hi' }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/TELEGRAM_BOT_TOKEN is not set/);
      expect(pushFn).not.toHaveBeenCalled();
    });

    it('errors when allowlist is unset', async () => {
      const { handler, pushFn } = makeHarness({ token: 't' });
      const r = await handler({ message: 'hi' }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/AFK_TELEGRAM_ALLOWED_CHAT_IDS is empty/);
      expect(pushFn).not.toHaveBeenCalled();
    });

    it('errors when allowlist contains only non-numeric junk', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: 'abc,,xyz' });
      const r = await handler({ message: 'hi' }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/AFK_TELEGRAM_ALLOWED_CHAT_IDS is empty/);
      expect(pushFn).not.toHaveBeenCalled();
    });
  });

  describe('happy paths', () => {
    it('sends to a single chat ID', async () => {
      const { handler, pushFn } = makeHarness({ token: 'token-xyz', allowed: '12345' });
      const r = await handler({ message: 'hello operator' }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledOnce();
      expect(pushFn).toHaveBeenCalledWith({ token: 'token-xyz', chatId: 12345, text: 'hello operator' });
      expect(r.content).toMatch(/Sent Telegram message to chat 12345/);
    });

    it('defaults to the primary (DM) chat for a multi-chat allowlist — no fan-out', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '111, 222 ,333' });
      const r = await handler({ message: 'ping' }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledOnce();
      expect(pushFn).toHaveBeenCalledWith({ token: 't', chatId: 111, text: 'ping' });
      expect(r.content).toMatch(/Sent Telegram message to chat 111/);
    });

    it('fans out to multiple chat IDs in broadcast mode', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '111, 222 ,333', mode: 'broadcast' });
      const r = await handler({ message: 'ping' }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledTimes(3);
      expect(pushFn).toHaveBeenNthCalledWith(1, { token: 't', chatId: 111, text: 'ping' });
      expect(pushFn).toHaveBeenNthCalledWith(2, { token: 't', chatId: 222, text: 'ping' });
      expect(pushFn).toHaveBeenNthCalledWith(3, { token: 't', chatId: 333, text: 'ping' });
      expect(r.content).toMatch(/Sent Telegram message to 3 chats/);
    });

    it('supports negative chat IDs (group/channel)', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '-100123' });
      const r = await handler({ message: 'group ping' }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledOnce();
      expect(pushFn).toHaveBeenCalledWith({ token: 't', chatId: -100123, text: 'group ping' });
    });
  });

  describe('per-call chat targeting', () => {
    it('rejects a chat that is neither number nor string', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '111' });
      const r = await handler({ message: 'hi', chat: { id: 1 } }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/chat must be a number/);
      expect(pushFn).not.toHaveBeenCalled();
    });

    it('sends to an explicit numeric chat id when allowlisted', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '111,222,333' });
      const r = await handler({ message: 'to 222', chat: 222 }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledOnce();
      expect(pushFn).toHaveBeenCalledWith({ token: 't', chatId: 222, text: 'to 222' });
      expect(r.content).toMatch(/Sent Telegram message to chat 222/);
    });

    it('accepts a numeric STRING chat id', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '111,-100999' });
      const r = await handler({ message: 'to group', chat: '-100999' }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledWith({ token: 't', chatId: -100999, text: 'to group' });
    });

    it('resolves a chat ALIAS from telegram.chatAliases', async () => {
      const { handler, pushFn } = makeHarness({
        token: 't',
        allowed: '111,-1001234567890',
        aliases: { ops: -1001234567890 },
      });
      const r = await handler({ message: 'alert ops', chat: 'ops' }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledOnce();
      expect(pushFn).toHaveBeenCalledWith({ token: 't', chatId: -1001234567890, text: 'alert ops' });
    });

    it('errors on an unresolvable alias and lists the available names', async () => {
      const { handler, pushFn } = makeHarness({
        token: 't',
        allowed: '111',
        aliases: { ops: -100200, family: 999 },
      });
      const r = await handler({ message: 'x', chat: 'nope' }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/Unknown chat alias "nope"/);
      expect(r.content).toMatch(/ops/);
      expect(r.content).toMatch(/family/);
      expect(pushFn).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED: rejects a numeric chat NOT in the allowlist', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '111,222' });
      const r = await handler({ message: 'x', chat: 999 }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/chat 999 is not in the allowlist/);
      expect(r.content).toMatch(/111, 222/);
      expect(pushFn).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED: rejects an alias that resolves to a non-allowlisted chat', async () => {
      const { handler, pushFn } = makeHarness({
        token: 't',
        allowed: '111',
        aliases: { rogue: -100500 },
      });
      const r = await handler({ message: 'x', chat: 'rogue' }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/chat -100500 is not in the allowlist/);
      expect(pushFn).not.toHaveBeenCalled();
    });

    it('does NOT re-gate default routing: omitted chat behaves identically to legacy', async () => {
      // Broadcast (custom-style fan-out) is allowlist-independent by design; the
      // fail-closed gate only applies to an EXPLICIT chat target.
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '111,222,333', mode: 'broadcast' });
      const r = await handler({ message: 'ping' }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledTimes(3);
    });

    it('explicit chat overrides broadcast mode (single send, not fan-out)', async () => {
      const { handler, pushFn } = makeHarness({ token: 't', allowed: '111,222,333', mode: 'broadcast' });
      const r = await handler({ message: 'just 222', chat: 222 }, signal);
      expect(r.isError).toBeUndefined();
      expect(pushFn).toHaveBeenCalledOnce();
      expect(pushFn).toHaveBeenCalledWith({ token: 't', chatId: 222, text: 'just 222' });
    });
  });

  describe('failure handling', () => {
    it('returns error when the only target fails', async () => {
      const { handler } = makeHarness({
        token: 't',
        allowed: '999',
        pushFn: async () => ({ ok: false, status: 400, errorMessage: 'chat not found' }),
      });
      const r = await handler({ message: 'hi' }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/Failed to send Telegram message to any chat/);
      expect(r.content).toMatch(/chat 999: chat not found/);
    });

    it('returns partial-success (no isError) when some targets succeed', async () => {
      const calls: number[] = [];
      const { handler } = makeHarness({
        token: 't',
        allowed: '111,222',
        mode: 'broadcast',
        pushFn: async (opts) => {
          calls.push(opts.chatId as number);
          if (opts.chatId === 222) return { ok: false, status: 403, errorMessage: 'blocked' };
          return OK_RESULT;
        },
      });
      const r = await handler({ message: 'hi' }, signal);
      expect(r.isError).toBeUndefined();
      expect(calls).toEqual([111, 222]);
      expect(r.content).toMatch(/Sent Telegram message to 1\/2 chat\(s\)/);
      expect(r.content).toMatch(/chat 222: blocked/);
    });

    it('errors when all targets fail', async () => {
      const { handler } = makeHarness({
        token: 't',
        allowed: '111,222',
        mode: 'broadcast',
        pushFn: async () => ({ ok: false, status: 0, errorMessage: 'network down' }),
      });
      const r = await handler({ message: 'hi' }, signal);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/Failed to send Telegram message to any chat/);
      expect(r.content).toMatch(/chat 111: network down/);
      expect(r.content).toMatch(/chat 222: network down/);
    });
  });
});
