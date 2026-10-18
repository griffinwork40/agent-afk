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
});
