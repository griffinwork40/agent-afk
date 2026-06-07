/**
 * Tests for Telegram outbound push primitive.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { push, pushIfConfigured } from './push';

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

describe('pushIfConfigured', () => {
  const originalToken = process.env['TELEGRAM_BOT_TOKEN'];
  const originalAllow = process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'];

  beforeEach(() => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'];
  });

  afterEach(() => {
    if (originalToken !== undefined) process.env['TELEGRAM_BOT_TOKEN'] = originalToken;
    else delete process.env['TELEGRAM_BOT_TOKEN'];
    if (originalAllow !== undefined) process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = originalAllow;
    else delete process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'];
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

  test('fans out to multiple chat IDs', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222,333';
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

  test('forwards reply_markup to every chat when provided', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222';
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
});
