/**
 * Tests that `defaultClientFactory` (exercised via `resolveClientFactory`)
 * passes `maxRetries: 0` to the OpenAI SDK constructor so AFK's own retry
 * loop (retry.ts MAX_CONNECTION_RETRIES / MAX_STREAM_RETRIES) is the single,
 * traced retry authority — issue #2422.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveClientFactory, __setOpenAIClientFactory, ledgerAccountForBaseUrl } from './client.js';

/** Capture constructor args from `new OpenAI(opts)`. */
vi.mock('openai', () => {
  const MockOpenAI = vi.fn(function (this: Record<string, unknown>, opts: Record<string, unknown>) {
    Object.assign(this, opts);
  });
  return { default: MockOpenAI };
});

afterEach(() => {
  __setOpenAIClientFactory(null);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ledgerAccountForBaseUrl — #2872
// ---------------------------------------------------------------------------

describe('ledgerAccountForBaseUrl — distinct keys for unparseable baseURLs (#2872)', () => {
  it('returns the hostname for a parseable URL', () => {
    expect(ledgerAccountForBaseUrl('https://api.openai.com/v1')).toBe('api.openai.com');
    expect(ledgerAccountForBaseUrl('http://my-proxy.example.com:8080/api')).toBe('my-proxy.example.com');
  });

  it('returns api.openai.com when baseURL is undefined', () => {
    expect(ledgerAccountForBaseUrl(undefined)).toBe('api.openai.com');
  });

  it('two different malformed baseURLs produce different keys', () => {
    const a = ledgerAccountForBaseUrl('not-a-url-alpha');
    const b = ledgerAccountForBaseUrl('not-a-url-beta');
    expect(a).not.toBe(b);
    // Both must start with 'custom-' prefix
    expect(a).toMatch(/^custom-[0-9a-f]{12}$/);
    expect(b).toMatch(/^custom-[0-9a-f]{12}$/);
  });

  it('the same malformed baseURL is stable across calls', () => {
    const url = 'garbage://endpoint?token=secret';
    expect(ledgerAccountForBaseUrl(url)).toBe(ledgerAccountForBaseUrl(url));
  });

  it('never exposes the raw URL in the key (hashed, not embedded)', () => {
    const sensitive = 'not-a-url-with-secret-token-12345';
    const key = ledgerAccountForBaseUrl(sensitive);
    expect(key).not.toContain(sensitive);
    expect(key).not.toContain('secret');
    expect(key).toMatch(/^custom-[0-9a-f]{12}$/);
  });
});

describe('defaultClientFactory — maxRetries: 0 (#2422)', () => {
  it('passes maxRetries: 0 so SDK retries do not stack under AFK retry loops', async () => {
    const OpenAI = (await import('openai')).default;
    const factory = resolveClientFactory();
    factory({ apiKey: 'sk-test-1234' });

    expect(OpenAI).toHaveBeenCalledOnce();
    const [opts] = (OpenAI as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((opts as Record<string, unknown>).maxRetries).toBe(0);
  });

  it('still passes apiKey, baseURL, defaultHeaders, and fetch through', async () => {
    const OpenAI = (await import('openai')).default;
    const fakeFetch = vi.fn();
    const factory = resolveClientFactory();
    factory({
      apiKey: 'sk-test-5678',
      baseURL: 'http://localhost:9000',
      defaultHeaders: { 'x-custom': 'yes' },
      fetch: fakeFetch,
    });

    const [opts] = (OpenAI as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((opts as Record<string, unknown>).apiKey).toBe('sk-test-5678');
    expect((opts as Record<string, unknown>).baseURL).toBe('http://localhost:9000');
    expect((opts as Record<string, unknown>).defaultHeaders).toEqual({ 'x-custom': 'yes' });
    expect((opts as Record<string, unknown>).fetch).toBe(fakeFetch);
    expect((opts as Record<string, unknown>).maxRetries).toBe(0);
  });

  it('injected test factory bypasses maxRetries enforcement (injection contract unchanged)', () => {
    const mock = vi.fn(() => ({ type: 'mock' }));
    __setOpenAIClientFactory(mock as unknown as Parameters<typeof __setOpenAIClientFactory>[0]);
    const factory = resolveClientFactory();
    factory({ apiKey: 'sk-test-0000' });
    expect(mock).toHaveBeenCalledOnce();
  });
});
