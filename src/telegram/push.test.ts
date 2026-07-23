/**
 * Tests for Telegram outbound push primitive.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { push, pushIfConfigured, pushMarkdown } from './push';

// loadTelegramConfig reads afk.config.json; mock it so these tests are hermetic
// (notify routing is then driven purely by the env vars set per-test). The pure
// resolver is exhaustively covered in notify-routing.test.ts.
vi.mock('../cli/config.js', () => ({ loadTelegramConfig: vi.fn(() => ({})) }));

function makeFetchOk(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

function makeFetchError(status: number, description: string): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ ok: false, description }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('push', () => {
  test('POSTs to sendMessage with chat_id and text', async () => {
    const fetchImpl = makeFetchOk();
    const result = await push({
      token: 'TEST_TOKEN',
      chatId: 12345,
      text: 'hello',
      fetchImpl,
      apiBase: 'https://example.test',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://example.test/botTEST_TOKEN/sendMessage');
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ chat_id: 12345, text: 'hello' });
  });

  test('includes reply_markup when provided', async () => {
    const fetchImpl = makeFetchOk();
    const replyMarkup = {
      inline_keyboard: [
        [{ text: '✅ Open PR', callback_data: 'afk:f:p:slug' }],
      ],
    };
    await push({
      token: 't',
      chatId: '1',
      text: 'hi',
      replyMarkup,
      fetchImpl,
    });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.reply_markup).toEqual(replyMarkup);
  });

  test('omits reply_markup when absent (preserves plain-text shape)', async () => {
    const fetchImpl = makeFetchOk();
    await push({ token: 't', chatId: '1', text: 'hi', fetchImpl });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.reply_markup).toBeUndefined();
  });

  test('includes parse_mode when provided', async () => {
    const fetchImpl = makeFetchOk();
    await push({
      token: 't',
      chatId: '1',
      text: '*hi*',
      parseMode: 'MarkdownV2',
      fetchImpl,
    });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.parse_mode).toBe('MarkdownV2');
  });

  test('truncates text over 4096 chars', async () => {
    const fetchImpl = makeFetchOk();
    await push({
      token: 't',
      chatId: '1',
      text: 'x'.repeat(5000),
      fetchImpl,
    });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.text.length).toBe(4096);
  });

  test('returns ok:false on non-2xx with Telegram description', async () => {
    const fetchImpl = makeFetchError(400, 'chat not found');
    const result = await push({
      token: 't',
      chatId: '1',
      text: 'hi',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.errorMessage).toBe('chat not found');
  });

  test('returns ok:false on fetch throw without raising', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const result = await push({
      token: 't',
      chatId: '1',
      text: 'hi',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.errorMessage).toBe('network down');
  });

  test('throws on missing token', async () => {
    await expect(
      push({ token: '', chatId: '1', text: 'hi', fetchImpl: makeFetchOk() }),
    ).rejects.toThrow(/token/);
  });

  test('throws on missing chatId', async () => {
    await expect(
      push({ token: 't', chatId: '', text: 'hi', fetchImpl: makeFetchOk() }),
    ).rejects.toThrow(/chatId/);
  });

  test('throws when chatId is numeric 0', async () => {
    await expect(
      push({ token: 't', chatId: 0, text: 'hi', fetchImpl: makeFetchOk() }),
    ).rejects.toThrow(/chatId/);
  });

  test('returns ok:false with HTTP status fallback when Telegram error body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('Bad Gateway', {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    })) as unknown as typeof fetch;
    const result = await push({
      token: 't',
      chatId: '1',
      text: 'hi',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.errorMessage).toBe('HTTP 502');
  });
});

describe('pushMarkdown', () => {
  test('renders markdown to HTML and sends with parse_mode HTML', async () => {
    const fetchImpl = makeFetchOk();
    const result = await pushMarkdown({
      token: 't',
      chatId: '1',
      text: '**bold** and `code`',
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toBe('<b>bold</b> and <code>code</code>');
  });

  test('falls back to plain text when Telegram rejects the HTML', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({ ok: false, description: "Bad Request: can't parse entities: unexpected tag" }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await pushMarkdown({ token: 't', chatId: '1', text: '**weird** content', fetchImpl });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const first = JSON.parse(calls[0][1].body);
    const second = JSON.parse(calls[1][1].body);
    expect(first.parse_mode).toBe('HTML');
    // Fallback resends the original raw markdown with no parse_mode.
    expect(second.parse_mode).toBeUndefined();
    expect(second.text).toBe('**weird** content');
  });

  test('does NOT fall back on non-parse failures (e.g. 403 blocked)', async () => {
    const fetchImpl = makeFetchError(403, 'Forbidden: bot was blocked by the user');
    const result = await pushMarkdown({ token: 't', chatId: '1', text: '**x**', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    // No duplicate send — only the HTML attempt was made.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('re-splits rendered HTML so escaping-expanded content is never truncated past 4096', async () => {
    const fetchImpl = makeFetchOk();
    // 3000 '<' chars escape to 3000 '&lt;' = 12000 chars of HTML — ~3x Telegram's
    // 4096 limit. Without the inner re-split, push() truncates to 4096 and the
    // remaining ~8000 chars are silently dropped.
    const raw = '<'.repeat(3000);
    const result = await pushMarkdown({ token: 't', chatId: '1', text: raw, fetchImpl });

    expect(result.ok).toBe(true);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Sent as multiple messages rather than one truncated blob.
    expect(calls.length).toBeGreaterThan(1);
    let reassembled = '';
    for (const call of calls) {
      const body = JSON.parse(call[1].body);
      expect(body.parse_mode).toBe('HTML');
      expect(body.text.length).toBeLessThanOrEqual(4096);
      reassembled += body.text;
    }
    // Full payload delivered across the chunks — no silent truncation.
    expect(reassembled).toBe('&lt;'.repeat(3000));
  });
});

describe('pushIfConfigured', () => {
  const NOTIFY_KEYS = [
    'TELEGRAM_BOT_TOKEN',
    'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
    'AFK_TELEGRAM_NOTIFY_MODE',
    'AFK_TELEGRAM_PRIMARY_CHAT_ID',
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of NOTIFY_KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of NOTIFY_KEYS) {
      if (original[k] !== undefined) process.env[k] = original[k];
      else delete process.env[k];
    }
  });

  test('returns null when token unset', async () => {
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '1';
    const fetchImpl = makeFetchOk();
    const result = await pushIfConfigured('hi', { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('returns null when allowlist unset', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    const fetchImpl = makeFetchOk();
    const result = await pushIfConfigured('hi', { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('returns null when allowlist is empty junk', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = 'abc,,xyz';
    const fetchImpl = makeFetchOk();
    const result = await pushIfConfigured('hi', { fetchImpl });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('pushes to a single chat when configured', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '42';
    const fetchImpl = makeFetchOk();
    const result = await pushIfConfigured('hi', { fetchImpl });
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('defaults to the primary (DM) chat for a multi-chat allowlist — no fan-out', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222,333';
    const fetchImpl = makeFetchOk();
    const result = await pushIfConfigured('hi', { fetchImpl });
    expect(result).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body).chat_id).toBe(111);
  });

  test('fans out to multiple chat IDs in broadcast mode', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222,333';
    process.env['AFK_TELEGRAM_NOTIFY_MODE'] = 'broadcast';
    const fetchImpl = makeFetchOk();
    const result = await pushIfConfigured('hi', { fetchImpl });
    expect(result).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('splits long text into Telegram-safe chunks', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '42';
    const fetchImpl = makeFetchOk();
    const text = 'x'.repeat(9000);

    const result = await pushIfConfigured(text, { fetchImpl });

    expect(result).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const sent = calls.map((c) => JSON.parse(c[1].body).text as string);
    expect(sent.every((chunk) => chunk.length <= 4096)).toBe(true);
    expect(sent.join('')).toBe(text);
  });

  test('renders markdown to HTML per chunk when markdown:true', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '42';
    const fetchImpl = makeFetchOk();

    await pushIfConfigured('**hello** `world`', { markdown: true, fetchImpl });

    const body = JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toBe('<b>hello</b> <code>world</code>');
  });

  test('forwards reply_markup to every chat when provided', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222';
    process.env['AFK_TELEGRAM_NOTIFY_MODE'] = 'broadcast';
    const fetchImpl = makeFetchOk();
    const replyMarkup = {
      inline_keyboard: [[{ text: 'OK', callback_data: 'afk:f:x:slug' }]],
    };
    await pushIfConfigured('hi', { fetchImpl, replyMarkup });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      const body = JSON.parse(c[1].body);
      expect(body.reply_markup).toEqual(replyMarkup);
    }
  });

  test('attaches reply_markup only to the first chunk per chat', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222';
    process.env['AFK_TELEGRAM_NOTIFY_MODE'] = 'broadcast';
    const fetchImpl = makeFetchOk();
    const replyMarkup = {
      inline_keyboard: [[{ text: 'Open', callback_data: 'afk:f:x:slug' }]],
    };

    await pushIfConfigured('x'.repeat(5000), { fetchImpl, replyMarkup });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(4);
    for (let i = 0; i < calls.length; i++) {
      const body = JSON.parse(calls[i][1].body);
      if (i === 0 || i === 2) {
        expect(body.reply_markup).toEqual(replyMarkup);
      } else {
        expect(body.reply_markup).toBeUndefined();
      }
    }
  });

  test('target override routes to the explicit chat, ignoring notify config', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    // Broadcast would normally fan out to all three; target overrides that.
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222,333';
    process.env['AFK_TELEGRAM_NOTIFY_MODE'] = 'broadcast';
    const fetchImpl = makeFetchOk();
    const result = await pushIfConfigured('hi', { fetchImpl, target: -100999 });
    expect(result).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body).chat_id).toBe(-100999);
  });

  test('target override accepts an array of chat ids', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111';
    const fetchImpl = makeFetchOk();
    const result = await pushIfConfigured('hi', { fetchImpl, target: [222, 333] });
    expect(result).toHaveLength(2);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => JSON.parse(c[1].body).chat_id)).toEqual([222, 333]);
  });

  test('empty/invalid target falls back to default notify routing', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111';
    const fetchImpl = makeFetchOk();
    // 0 is filtered out → override empty → fall back to primary (111).
    const result = await pushIfConfigured('hi', { fetchImpl, target: 0 });
    expect(result).toHaveLength(1);
    expect(JSON.parse((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body).chat_id).toBe(111);
  });

  test('omitted target preserves default routing (byte-identical to legacy)', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222,333';
    process.env['AFK_TELEGRAM_NOTIFY_MODE'] = 'broadcast';
    const fetchImpl = makeFetchOk();
    const result = await pushIfConfigured('hi', { fetchImpl });
    expect(result).toHaveLength(3);
  });
});
