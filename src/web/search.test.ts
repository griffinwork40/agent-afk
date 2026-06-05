/**
 * Unit tests for the search backends (src/web/search.ts).
 *
 * Strategy: inject `fetchFn` so no real Brave API call is made. Cover the
 * Brave request shape, result mapping/markup-stripping, HTTP error surfacing,
 * the no-key resolution error, and markdown formatting.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createBraveSearchBackend,
  resolveSearchBackend,
  formatSearchResults,
} from './search.js';

function braveOk(results: Array<{ title?: string; url?: string; description?: string }>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async (): Promise<unknown> => ({ web: { results } }),
    text: async (): Promise<string> => JSON.stringify({ web: { results } }),
  } as unknown as Response;
}

function braveErr(status: number, body = ''): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: new Headers(),
    json: async (): Promise<unknown> => ({}),
    text: async (): Promise<string> => body,
  } as unknown as Response;
}

const signal = (): AbortSignal => new AbortController().signal;

describe('createBraveSearchBackend — request shape', () => {
  it('hits the Brave endpoint with the query, count, and subscription token', async () => {
    let seenUrl = '';
    let seenToken: string | null = null;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      const headers = new Headers(init?.headers);
      seenToken = headers.get('x-subscription-token');
      return braveOk([{ title: 'T', url: 'https://e.com', description: 'D' }]);
    });

    const backend = createBraveSearchBackend({ apiKey: 'brave-secret', fetchFn: fetchFn as unknown as typeof fetch });
    await backend.search('hello world', { limit: 5, timeoutMs: 5000, signal: signal() });

    expect(seenUrl).toContain('api.search.brave.com/res/v1/web/search');
    expect(seenUrl).toContain('q=hello+world');
    expect(seenUrl).toContain('count=5');
    expect(seenToken).toBe('brave-secret');
    expect(backend.name).toBe('brave');
  });

  it('clamps count to Brave max of 20', async () => {
    let seenUrl = '';
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      seenUrl = String(input);
      return braveOk([]);
    });
    const backend = createBraveSearchBackend({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await backend.search('q', { limit: 100, timeoutMs: 5000, signal: signal() });
    expect(seenUrl).toContain('count=20');
  });
});

describe('createBraveSearchBackend — result mapping', () => {
  it('maps results and strips highlight markup + entities from snippets', async () => {
    const fetchFn = vi.fn(async () =>
      braveOk([
        { title: 'First <strong>hit</strong>', url: 'https://a.com', description: 'A &amp; B <strong>x</strong>' },
        { title: 'Second', url: 'https://b.com', description: 'plain' },
      ]),
    );
    const backend = createBraveSearchBackend({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    const results = await backend.search('q', { limit: 10, timeoutMs: 5000, signal: signal() });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: 'First hit', url: 'https://a.com', description: 'A & B x' });
    expect(results[1]?.title).toBe('Second');
  });

  it('drops results with no URL and applies the limit', async () => {
    const fetchFn = vi.fn(async () =>
      braveOk([
        { title: 'has url', url: 'https://a.com', description: '' },
        { title: 'no url', description: 'orphan' },
      ]),
    );
    const backend = createBraveSearchBackend({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    const results = await backend.search('q', { limit: 10, timeoutMs: 5000, signal: signal() });
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://a.com');
  });

  it('surfaces an HTTP error with status and body snippet', async () => {
    const fetchFn = vi.fn(async () => braveErr(422, 'quota exceeded'));
    const backend = createBraveSearchBackend({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await expect(
      backend.search('q', { limit: 10, timeoutMs: 5000, signal: signal() }),
    ).rejects.toThrow(/Brave Search HTTP 422.*quota exceeded/);
  });
});

describe('resolveSearchBackend', () => {
  it('returns a Brave backend when a key is present', () => {
    const resolved = resolveSearchBackend({ braveApiKey: 'k' });
    expect('error' in resolved).toBe(false);
    expect((resolved as { name: string }).name).toBe('brave');
  });

  it('returns an actionable error when no key is configured', () => {
    const resolved = resolveSearchBackend({ braveApiKey: undefined });
    expect('error' in resolved).toBe(true);
    expect((resolved as { error: string }).error).toMatch(/BRAVE_SEARCH_API_KEY/);
  });

  it('treats a blank key as unconfigured', () => {
    const resolved = resolveSearchBackend({ braveApiKey: '   ' });
    expect('error' in resolved).toBe(true);
  });
});

describe('formatSearchResults', () => {
  it('renders ranked results as markdown', () => {
    const md = formatSearchResults('cats', [
      { title: 'Cat facts', url: 'https://cats.com', description: 'All about cats' },
    ]);
    expect(md).toContain('# Search results for "cats"');
    expect(md).toContain('## 1. Cat facts');
    expect(md).toContain('https://cats.com');
    expect(md).toContain('All about cats');
  });

  it('renders a no-results placeholder', () => {
    const md = formatSearchResults('void', []);
    expect(md).toContain('(no results)');
  });
});
