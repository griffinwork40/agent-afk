/**
 * Unit tests for src/telegram/audio-transcriber.ts
 *
 * Covers: createTranscriber factory, OpenAIAudioTranscriber happy-path,
 * API errors, network errors, parse errors, empty transcript, and size cap.
 * No real HTTP calls are made — globalThis.fetch is stubbed via vi.stubGlobal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createTranscriber,
  OpenAIAudioTranscriber,
} from './audio-transcriber.js';

const API_URL = 'https://whisper.example.com/v1/audio/transcriptions';
const API_KEY = 'test-key';
const MODEL = 'whisper-1';
const AUDIO_BYTES = Buffer.from('fake-ogg-data');
const FILE_NAME = 'voice.ogg';
const MAX_BYTES = 20 * 1024 * 1024;

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// createTranscriber factory
// ---------------------------------------------------------------------------

describe('createTranscriber', () => {
  it('returns null when AFK_TRANSCRIBE_API_URL is unset', () => {
    expect(createTranscriber({})).toBeNull();
  });

  it('returns null when AFK_TRANSCRIBE_API_URL is empty string', () => {
    expect(createTranscriber({ AFK_TRANSCRIBE_API_URL: '' })).toBeNull();
  });

  it('returns null when AFK_TRANSCRIBE_API_URL is whitespace only', () => {
    expect(createTranscriber({ AFK_TRANSCRIBE_API_URL: '   ' })).toBeNull();
  });

  it('returns an OpenAIAudioTranscriber when URL is set', () => {
    const t = createTranscriber({ AFK_TRANSCRIBE_API_URL: API_URL });
    expect(t).not.toBeNull();
    expect(t).toBeInstanceOf(OpenAIAudioTranscriber);
  });
});

// ---------------------------------------------------------------------------
// OpenAIAudioTranscriber happy path
// ---------------------------------------------------------------------------

describe('OpenAIAudioTranscriber.transcribe', () => {
  function makeTranscriber(key?: string, model = MODEL) {
    return new OpenAIAudioTranscriber(API_URL, key, model);
  }

  function fakeOkResponse(text: string): Response {
    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('returns ok with trimmed transcript on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeOkResponse('  hello world  ')));
    const t = makeTranscriber(API_KEY);
    const result = await t.transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.text).toBe('hello world');
  });

  it('sends Authorization header when apiKey is set', async () => {
    const fetchSpy = vi.fn(async () => fakeOkResponse('hi'));
    vi.stubGlobal('fetch', fetchSpy);
    await makeTranscriber(API_KEY).transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('omits Authorization header when apiKey is undefined', async () => {
    const fetchSpy = vi.fn(async () => fakeOkResponse('hi'));
    vi.stubGlobal('fetch', fetchSpy);
    await makeTranscriber(undefined).transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('returns empty when API returns whitespace-only text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeOkResponse('   ')));
    const result = await makeTranscriber().transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('empty');
  });

  it('returns too-large when bytes exceed maxBytes', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const bigBuffer = Buffer.alloc(MAX_BYTES + 1);
    const result = await makeTranscriber().transcribe(bigBuffer, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('too-large');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns api-error on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 401 })));
    const result = await makeTranscriber().transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('api-error');
    if (result.status === 'api-error') expect(result.httpStatus).toBe(401);
  });

  it('returns network-error when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const result = await makeTranscriber().transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('network-error');
  });

  it('returns parse-error when response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })));
    const result = await makeTranscriber().transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('parse-error');
  });

  it('returns parse-error when JSON has no text field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ segments: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const result = await makeTranscriber().transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('parse-error');
  });

  it('does not include API key in network-error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`connect failed with Bearer ${API_KEY}`);
    }));
    const t = makeTranscriber(API_KEY);
    const result = await t.transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('network-error');
    if (result.status === 'network-error') {
      expect(result.safeMessage).not.toContain(API_KEY);
    }
  });

  it('returns network-error when SSRF guard blocks the host', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const blockedCheck = vi.fn(async () => ({ allowed: false, reason: 'private address 127.0.0.1' }));
    const t = new OpenAIAudioTranscriber(API_URL, API_KEY, MODEL, 60_000, blockedCheck);
    const result = await t.transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('network-error');
    if (result.status === 'network-error') {
      expect(result.safeMessage).toContain('SSRF guard');
      expect(result.safeMessage).toContain('private address 127.0.0.1');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('redacts Bearer tokens when checkEgress throws', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const failingCheck = vi.fn(async () => {
      throw new Error('DNS lookup failed for Bearer sk-secret host');
    });
    const t = new OpenAIAudioTranscriber(API_URL, API_KEY, MODEL, 60_000, failingCheck);
    const result = await t.transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('network-error');
    if (result.status === 'network-error') {
      expect(result.safeMessage).toContain('SSRF egress check failed');
      expect(result.safeMessage).not.toContain('sk-secret');
      expect(result.safeMessage).toContain('Bearer [REDACTED]');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('proceeds normally when SSRF guard allows the host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeOkResponse('hello')));
    const allowedCheck = vi.fn(async () => ({ allowed: true as const }));
    const t = new OpenAIAudioTranscriber(API_URL, API_KEY, MODEL, 60_000, allowedCheck);
    const result = await t.transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(result.status).toBe('ok');
    expect(allowedCheck).toHaveBeenCalledWith(API_URL);
  });
});

// ---------------------------------------------------------------------------
// createTranscriber — URL-scheme guard and timeout parsing
// ---------------------------------------------------------------------------

describe('createTranscriber URL-scheme guard', () => {
  it('throws on ftp:// scheme', () => {
    expect(() => createTranscriber({ AFK_TRANSCRIBE_API_URL: 'ftp://example.com/transcribe' }))
      .toThrow(/must use http or https/);
  });

  it('throws on file:// scheme', () => {
    expect(() => createTranscriber({ AFK_TRANSCRIBE_API_URL: 'file:///etc/passwd' }))
      .toThrow(/must use http or https/);
  });

  it('throws on a custom scheme', () => {
    expect(() => createTranscriber({ AFK_TRANSCRIBE_API_URL: 'custom://host/path' }))
      .toThrow(/must use http or https/);
  });

  it('throws on a malformed URL', () => {
    expect(() => createTranscriber({ AFK_TRANSCRIBE_API_URL: 'not a url' }))
      .toThrow(/not a valid URL/);
  });

  it('accepts http:// scheme', () => {
    expect(createTranscriber({ AFK_TRANSCRIBE_API_URL: 'http://localhost/transcribe' }))
      .not.toBeNull();
  });

  it('accepts https:// scheme', () => {
    expect(createTranscriber({ AFK_TRANSCRIBE_API_URL: API_URL }))
      .not.toBeNull();
  });
});

describe('createTranscriber AFK_TRANSCRIBE_TIMEOUT_MS parsing', () => {
  it('uses the supplied positive integer', () => {
    const t = createTranscriber({
      AFK_TRANSCRIBE_API_URL: API_URL,
      AFK_TRANSCRIBE_TIMEOUT_MS: '30000',
    });
    // Transcriber is created without error; the timeout is internal state.
    expect(t).not.toBeNull();
  });

  it('falls back to 60000 for a non-numeric value (warns)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: 'hi' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const t = createTranscriber({
      AFK_TRANSCRIBE_API_URL: API_URL,
      AFK_TRANSCRIBE_TIMEOUT_MS: 'abc',
    });
    expect(t).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('AFK_TRANSCRIBE_TIMEOUT_MS'));
    await t!.transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    warnSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('falls back to 60000 for a negative value (warns)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: 'hi' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const t = createTranscriber({
      AFK_TRANSCRIBE_API_URL: API_URL,
      AFK_TRANSCRIBE_TIMEOUT_MS: '-1',
    });
    expect(t).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('AFK_TRANSCRIBE_TIMEOUT_MS'));
    await t!.transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    warnSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('falls back to 60000 for zero (warns)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ text: 'hi' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    const t = createTranscriber({
      AFK_TRANSCRIBE_API_URL: API_URL,
      AFK_TRANSCRIBE_TIMEOUT_MS: '0',
    });
    expect(t).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('AFK_TRANSCRIBE_TIMEOUT_MS'));
    await t!.transcribe(AUDIO_BYTES, FILE_NAME, MAX_BYTES);
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    warnSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('does not warn for a valid positive integer', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createTranscriber({
      AFK_TRANSCRIBE_API_URL: API_URL,
      AFK_TRANSCRIBE_TIMEOUT_MS: '15000',
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
