/**
 * Unit tests for the search backends (src/web/search.ts).
 *
 * Strategy: inject `fetchFn` so no real Exa API call is made. Cover the
 * Exa request shape (POST + x-api-key + JSON body), result mapping (highlights
 * → description), HTTP error surfacing, the no-key resolution error, and
 * markdown formatting.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createExaSearchBackend,
  resolveSearchBackend,
  formatSearchResults,
} from './search.js';

function exaOk(results: Array<{ title?: string | null; url?: string; highlights?: string[] }>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async (): Promise<unknown> => ({ results }),
    text: async (): Promise<string> => JSON.stringify({ results }),
  } as unknown as Response;
}

function exaErr(status: number, body = ''): Response {
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

interface ExaRequestBody {
  query?: string;
  type?: string;
  numResults?: number;
  contents?: { highlights?: unknown };
}

describe('createExaSearchBackend — request shape', () => {
  it('POSTs to the Exa endpoint with the api key, query, numResults, type, and highlights', async () => {
    let seenUrl = '';
    let seenMethod: string | undefined;
    let seenKey: string | null = null;
    let seenBody: ExaRequestBody = {};
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = init?.method;
      seenKey = new Headers(init?.headers).get('x-api-key');
      seenBody = JSON.parse(String(init?.body)) as ExaRequestBody;
      return exaOk([{ title: 'T', url: 'https://e.com', highlights: ['D'] }]);
    });

    const backend = createExaSearchBackend({ apiKey: 'exa-secret', fetchFn: fetchFn as unknown as typeof fetch });
    await backend.search('hello world', { limit: 5, timeoutMs: 5000, signal: signal() });

    expect(seenUrl).toBe('https://api.exa.ai/search');
    expect(seenMethod).toBe('POST');
    expect(seenKey).toBe('exa-secret');
    expect(seenBody.query).toBe('hello world');
    expect(seenBody.numResults).toBe(5);
    expect(seenBody.type).toBe('auto');
    expect(seenBody.contents?.highlights).toBeTruthy();
    expect(backend.name).toBe('exa');
  });

  it('clamps numResults to the Exa max of 10', async () => {
    let seenBody: ExaRequestBody = {};
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as ExaRequestBody;
      return exaOk([]);
    });
    const backend = createExaSearchBackend({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await backend.search('q', { limit: 100, timeoutMs: 5000, signal: signal() });
    expect(seenBody.numResults).toBe(10);
  });
});

describe('createExaSearchBackend — result mapping', () => {
  it('maps highlights[0] to description and falls back for a null title', async () => {
    const fetchFn = vi.fn(async () =>
      exaOk([
        { title: 'First hit', url: 'https://a.com', highlights: ['snippet A', 'snippet A2'] },
        { title: null, url: 'https://b.com', highlights: [] },
      ]),
    );
    const backend = createExaSearchBackend({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    const results = await backend.search('q', { limit: 10, timeoutMs: 5000, signal: signal() });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: 'First hit', url: 'https://a.com', description: 'snippet A' });
    expect(results[1]).toEqual({ title: '(untitled)', url: 'https://b.com', description: '' });
  });

  it('drops results with no URL and applies the limit', async () => {
    const fetchFn = vi.fn(async () =>
      exaOk([
        { title: 'has url', url: 'https://a.com', highlights: [] },
        { title: 'no url', highlights: ['orphan'] },
      ]),
    );
    const backend = createExaSearchBackend({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    const results = await backend.search('q', { limit: 10, timeoutMs: 5000, signal: signal() });
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://a.com');
  });

  it('surfaces an HTTP error with status and body snippet', async () => {
    const fetchFn = vi.fn(async () => exaErr(422, 'quota exceeded'));
    const backend = createExaSearchBackend({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    await expect(
      backend.search('q', { limit: 10, timeoutMs: 5000, signal: signal() }),
    ).rejects.toThrow(/Exa Search HTTP 422.*quota exceeded/);
  });

  it('sanitizes control characters from HTTP error bodies before throwing', async () => {
    const fetchFn = vi.fn(async () => exaErr(500, 'bad\x1b[31mred\x1b[0m\nbody\x07'));
    const backend = createExaSearchBackend({ apiKey: 'k', fetchFn: fetchFn as unknown as typeof fetch });

    let message = '';
    try {
      await backend.search('q', { limit: 10, timeoutMs: 5000, signal: signal() });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain('Exa Search HTTP 500 Error: badred body');
    expect(message).not.toContain('\x1b');
    expect(message).not.toContain('\n');
    expect(message).not.toContain('\x07');
  });
});

describe('resolveSearchBackend', () => {
  it('returns an Exa backend when a key is present', () => {
    const resolved = resolveSearchBackend({ exaApiKey: 'k' });
    expect('error' in resolved).toBe(false);
    expect((resolved as { name: string }).name).toBe('exa');
  });

  it('returns an actionable error when no key is configured', () => {
    const resolved = resolveSearchBackend({ exaApiKey: undefined });
    expect('error' in resolved).toBe(true);
    expect((resolved as { error: string }).error).toMatch(/EXA_API_KEY/);
  });

  it('treats a blank key as unconfigured', () => {
    const resolved = resolveSearchBackend({ exaApiKey: '   ' });
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
