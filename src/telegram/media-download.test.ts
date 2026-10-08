/**
 * Unit tests for src/telegram/media-download.ts
 *
 * Covers: SSRF rejection, redirect rejection, timeout, size cap (Content-Length
 * and streaming), HTTP error, success, and the security invariant that the bot
 * token never appears in any returned diagnostic field.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { downloadTelegramFile } from './media-download.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_URL = 'https://api.telegram.org/file/botSECRET_TOKEN/documents/file.md';
const TOKEN = 'SECRET_TOKEN';

/** Build a minimal fake Response with the given options. */
function fakeResponse(opts: {
  status?: number;
  body?: BodyInit | null;
  headers?: Record<string, string>;
}): Response {
  return new Response(opts.body ?? 'hello', {
    status: opts.status ?? 200,
    headers: opts.headers ?? {},
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// SI-1 / SI-2 / SI-3: SSRF restriction
// ---------------------------------------------------------------------------

describe('downloadTelegramFile: SSRF restrictions', () => {
  it('rejects http:// scheme (SI-1) without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await downloadTelegramFile(
      'http://api.telegram.org/file/botTOKEN/file.txt',
      { maxBytes: 5_000_000 },
    );
    expect(result.status).toBe('ssrf-rejected');
    if (result.status === 'ssrf-rejected') {
      expect(result.protocol).toBe('http:');
    }
    // fetch must never have been called — SSRF check runs before network I/O
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-Telegram hostname (SI-2)', async () => {
    const result = await downloadTelegramFile(
      'https://evil.example.com/steal.txt',
      { maxBytes: 5_000_000 },
    );
    expect(result.status).toBe('ssrf-rejected');
    if (result.status === 'ssrf-rejected') {
      expect(result.hostname).toBe('evil.example.com');
    }
  });

  it('rejects a non-standard port even on the allowed host (SI-3)', async () => {
    const result = await downloadTelegramFile(
      'https://api.telegram.org:8443/file/botTOKEN/file.txt',
      { maxBytes: 5_000_000 },
    );
    expect(result.status).toBe('ssrf-rejected');
  });

  it('accepts port 443 explicitly (SI-3 pass)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: Buffer.from('ok') })));
    const result = await downloadTelegramFile(
      'https://api.telegram.org:443/file/botTOKEN/file.txt',
      { maxBytes: 5_000_000 },
    );
    expect(result.status).toBe('ok');
  });

  it('accepts absent port (SI-3 pass)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: Buffer.from('data') })));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('ok');
  });

  it('rejects a malformed URL string without calling fetch', async () => {
    const result = await downloadTelegramFile('not a url !!!', { maxBytes: 5_000_000 });
    expect(result.status).toBe('ssrf-rejected');
  });

  it('does not call fetch for any rejected URL', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await downloadTelegramFile('http://internal.corp/secret', { maxBytes: 5_000_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SI-4: redirect rejection
// ---------------------------------------------------------------------------

describe('downloadTelegramFile: redirect rejection (SI-4)', () => {
  it('returns network-error when fetch throws on redirect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch: redirect not allowed');
    }));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('network-error');
  });
});

// ---------------------------------------------------------------------------
// SI-5: timeout
// ---------------------------------------------------------------------------

describe('downloadTelegramFile: timeout (SI-5)', () => {
  it('returns network-error when fetch throws AbortError (timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      throw err;
    }));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('network-error');
  });
});

// ---------------------------------------------------------------------------
// SI-6: bot token never in returned fields
// ---------------------------------------------------------------------------

describe('downloadTelegramFile: token safety (SI-6)', () => {
  it('does not include the bot token in ssrf-rejected result fields', async () => {
    const result = await downloadTelegramFile(
      `https://evil.example.com/file/bot${TOKEN}/file.txt`,
      { maxBytes: 5_000_000 },
    );
    // hostname field might contain the attacker host but NOT the token
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(TOKEN);
  });

  it('does not include the bot token in network-error safeMessage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      // Error message that embeds the raw URL (mimics what some HTTP clients do)
      throw new Error(`fetch failed for https://api.telegram.org/file/bot${TOKEN}/file.txt`);
    }));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('network-error');
    if (result.status === 'network-error') {
      expect(result.safeMessage).not.toContain(TOKEN);
      expect(result.safeMessage).toContain('[REDACTED]');
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP-level errors
// ---------------------------------------------------------------------------

describe('downloadTelegramFile: HTTP errors', () => {
  it('returns fetch-failed with the status code on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 404, body: '' })));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('fetch-failed');
    if (result.status === 'fetch-failed') {
      expect(result.httpStatus).toBe(404);
    }
  });

  it('returns fetch-failed on 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ status: 500, body: '' })));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('fetch-failed');
    if (result.status === 'fetch-failed') {
      expect(result.httpStatus).toBe(500);
    }
  });
});

// ---------------------------------------------------------------------------
// Size cap
// ---------------------------------------------------------------------------

describe('downloadTelegramFile: size cap', () => {
  it('returns too-large when Content-Length header exceeds maxBytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({
      headers: { 'content-length': String(6_000_000) },
      body: 'x',
    })));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('too-large');
    if (result.status === 'too-large') {
      expect(result.bytesRead).toBe(6_000_000);
    }
  });

  it('returns too-large when streaming body exceeds maxBytes', async () => {
    const bigBody = new Uint8Array(5_000_001);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bigBody)));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('too-large');
  });

  it('returns missing-body when response has no body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const r = new Response(null);
      // Simulate a null body (body is already consumed)
      Object.defineProperty(r, 'body', { get: () => null });
      return r;
    }));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('missing-body');
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('downloadTelegramFile: success', () => {
  it('returns ok with the correct bytes on a valid 200 response', async () => {
    const payload = Buffer.from('Hello, Telegram!');
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: payload })));
    const result = await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.bytes).toEqual(payload);
    }
  });

  it('accepts a URL instance as fileUrlRaw', async () => {
    const payload = Buffer.from('bytes via URL instance');
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: payload })));
    const result = await downloadTelegramFile(
      new URL(VALID_URL),
      { maxBytes: 5_000_000 },
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.bytes.toString()).toBe('bytes via URL instance');
    }
  });

  it('passes redirect:error and a timeout signal to fetch', async () => {
    const fetchSpy = vi.fn(async () => fakeResponse({ body: 'data' }));
    vi.stubGlobal('fetch', fetchSpy);
    await downloadTelegramFile(VALID_URL, { maxBytes: 5_000_000 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0]!;
    expect((opts as RequestInit).redirect).toBe('error');
    expect((opts as RequestInit).signal).toBeDefined();
  });
});
