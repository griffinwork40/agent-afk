import { describe, expect, it, vi } from 'vitest';
import { createWebScrapeHandler } from './web-scrape.js';
import type { RenderFn } from '../../../web/types.js';

type FetchFn = typeof fetch;

interface MockResponseInit {
  status?: number;
  statusText?: string;
  body?: string;
  contentType?: string;
}

function makeResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const headers: Record<string, string> = {};
  if (init.contentType !== undefined) headers['content-type'] = init.contentType;
  return new Response(init.body ?? '', {
    status,
    statusText: init.statusText ?? 'OK',
    headers,
  });
}

function makeFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): FetchFn {
  return vi.fn(async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init ?? {});
  }) as unknown as FetchFn;
}

const signal = (): AbortSignal => new AbortController().signal;

/** A content-rich, server-rendered article that survives Readability. */
function richArticleHtml(marker = 'main article content'): string {
  const paras = Array.from(
    { length: 6 },
    (_, i) =>
      `<p>Paragraph ${i + 1}: ${marker}. Padding prose so Readability selects ` +
      `this container as the primary article region of the document.</p>`,
  ).join('');
  return `<!DOCTYPE html><html><head><title>The Article</title></head><body>` +
    `<nav>Home About</nav><article><h1>The Article</h1>${paras}</article>` +
    `<footer>Copyright</footer></body></html>`;
}

/** An Exa Search JSON response object. */
function exaResponse(results: Array<{ title?: string | null; url?: string; highlights?: string[] }>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async (): Promise<unknown> => ({ results }),
    text: async (): Promise<string> => JSON.stringify({ results }),
  } as unknown as Response;
}

describe('web_scrape handler — input validation', () => {
  const handler = createWebScrapeHandler({
    fetchFn: makeFetch(() => makeResponse({ body: 'unused' })),
    env: {},
  });

  it('rejects non-object input', async () => {
    const r = await handler('not-an-object' as unknown, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/expected an object/);
  });

  it('rejects unknown mode', async () => {
    const r = await handler({ mode: 'pdf', url: 'https://example.com' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/mode must be one of/);
  });

  it('rejects markdown mode with no url', async () => {
    const r = await handler({ mode: 'markdown' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/markdown mode requires a non-empty "url"/);
  });

  it('rejects search mode with no query', async () => {
    const r = await handler({ mode: 'search' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/search mode requires a non-empty "query"/);
  });

  it('rejects invalid URL', async () => {
    const r = await handler({ mode: 'raw', url: 'not a url' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not a valid absolute URL/);
  });

  it('rejects non-http(s) protocol', async () => {
    const r = await handler({ mode: 'raw', url: 'file:///etc/passwd' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/protocol "file:" not supported/);
  });

  it('rejects ftp://', async () => {
    const r = await handler({ mode: 'raw', url: 'ftp://example.com/x' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/protocol "ftp:" not supported/);
  });

  it('rejects non-positive timeout_ms', async () => {
    const r = await handler({ url: 'https://example.com', timeout_ms: 0 }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/timeout_ms must be a positive finite number/);
  });

  it('rejects non-positive max_bytes', async () => {
    const r = await handler({ url: 'https://example.com', max_bytes: -1 }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/max_bytes must be a positive finite number/);
  });
});

describe('web_scrape handler — markdown mode (fetch-first)', () => {
  it('fetches the URL, extracts main content, and returns markdown — no render', async () => {
    const renderFn = vi.fn<RenderFn>(async () => ({ html: '', finalUrl: '', httpStatus: 200 }));
    const fetchFn = makeFetch(() => makeResponse({ contentType: 'text/html', body: richArticleHtml() }));
    const handler = createWebScrapeHandler({ fetchFn, env: {}, renderFn });

    const r = await handler({ url: 'https://example.com/article' }, signal());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('main article content');
    // Chrome is stripped by Readability.
    expect(r.content).not.toContain('Copyright');
    // Rich fetch content means no escalation to the browser.
    expect(renderFn).not.toHaveBeenCalled();
  });

  it('requires no API key for markdown mode', async () => {
    const fetchFn = makeFetch(() => makeResponse({ contentType: 'text/html', body: richArticleHtml() }));
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ url: 'https://example.com/article' }, signal());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('main article content');
  });

  it('escalates to the render fallback when the fetched page is a thin JS shell', async () => {
    const shell = '<!DOCTYPE html><html><head><title>App</title></head><body><div id="root">Loading…</div></body></html>';
    const fetchFn = makeFetch(() => makeResponse({ contentType: 'text/html', body: shell }));
    const renderFn = vi.fn<RenderFn>(async () => ({
      html: richArticleHtml('rendered after JS'),
      finalUrl: 'https://example.com/app',
      httpStatus: 200,
    }));
    const handler = createWebScrapeHandler({ fetchFn, env: {}, renderFn });

    const r = await handler({ url: 'https://example.com/app' }, signal());
    expect(r.isError).toBeUndefined();
    expect(renderFn).toHaveBeenCalledOnce();
    expect(r.content).toContain('rendered after JS');
  });

  it('returns isError when no readable content can be extracted', async () => {
    const empty = '<!DOCTYPE html><html><head></head><body></body></html>';
    const fetchFn = makeFetch(() => makeResponse({ contentType: 'text/html', body: empty }));
    // Render also yields nothing.
    const renderFn = vi.fn<RenderFn>(async () => ({ html: empty, finalUrl: 'https://e.com', httpStatus: 200 }));
    const handler = createWebScrapeHandler({ fetchFn, env: {}, renderFn });

    const r = await handler({ url: 'https://example.com/empty' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no readable content/i);
  });

  it('adds a Playwright install hint when fetch fails and render is unavailable', async () => {
    const fetchFn = makeFetch(() => {
      throw new Error('ENOTFOUND');
    });
    const renderFn = vi.fn<RenderFn>(async () => {
      throw new Error('Cannot find package playwright');
    });
    const handler = createWebScrapeHandler({ fetchFn, env: {}, renderFn });

    const r = await handler({ url: 'https://example.com/x' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/playwright install chromium/);
  });
});

describe('web_scrape handler — raw mode', () => {
  it('hits the URL directly with a GET and no Authorization header', async () => {
    let seenUrl = '';
    let seenInit: RequestInit = {};
    const fetchFn = makeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return makeResponse({ body: '{"ok":true}' });
    });
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ mode: 'raw', url: 'https://api.example.com/v1/x' }, signal());
    expect(r.isError).toBeUndefined();
    expect(seenUrl).toBe('https://api.example.com/v1/x');
    expect(seenInit.method).toBe('GET');
    const headers = (seenInit.headers as Record<string, string>) ?? {};
    expect(headers['Authorization']).toBeUndefined();
    expect(r.content).toBe('{"ok":true}');
  });

  it('returns isError on non-2xx response', async () => {
    const fetchFn = makeFetch(() => makeResponse({ status: 404, statusText: 'Not Found', body: '' }));
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ mode: 'raw', url: 'https://example.com/missing' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/HTTP 404 Not Found/);
  });

  it('returns isError on network failure', async () => {
    const fetchFn = makeFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ mode: 'raw', url: 'https://example.com' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/network error: ECONNREFUSED/);
  });
});

describe('web_scrape handler — search mode (Exa)', () => {
  it('queries Exa with the api key and formats ranked results', async () => {
    let seenUrl = '';
    let seenKey: string | null = null;
    let seenBody: { query?: string } = {};
    const fetchFn = vi.fn(async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
      seenUrl = String(input);
      seenKey = new Headers(init?.headers).get('x-api-key');
      seenBody = JSON.parse(String(init?.body)) as { query?: string };
      return exaResponse([
        { title: 'Result 1', highlights: ['desc 1'], url: 'https://r1.example' },
        { title: 'Result 2', highlights: ['desc 2'], url: 'https://r2.example' },
      ]);
    }) as unknown as FetchFn;
    const handler = createWebScrapeHandler({ fetchFn, env: { EXA_API_KEY: 'exa-secret' } });

    const r = await handler({ mode: 'search', query: 'playwright scraping' }, signal());
    expect(r.isError).toBeUndefined();
    expect(seenUrl).toContain('api.exa.ai/search');
    expect(seenBody.query).toBe('playwright scraping');
    expect(seenKey).toBe('exa-secret');
    expect(r.content).toMatch(/# Search results for "playwright scraping"/);
    expect(r.content).toMatch(/## 1\. Result 1/);
    expect(r.content).toMatch(/https:\/\/r1\.example/);
    expect(r.content).toMatch(/## 2\. Result 2/);
  });

  it('returns a clear error (and makes no request) when EXA_API_KEY is unset', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ body: '' })) as unknown as FetchFn;
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ mode: 'search', query: 'whatever' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/EXA_API_KEY/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('surfaces an Exa HTTP error', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 422,
      statusText: 'Unprocessable',
      headers: new Headers(),
      text: async (): Promise<string> => 'quota exceeded',
      json: async (): Promise<unknown> => ({}),
    } as unknown as Response)) as unknown as FetchFn;
    const handler = createWebScrapeHandler({ fetchFn, env: { EXA_API_KEY: 'k' } });
    const r = await handler({ mode: 'search', query: 'q' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/search error \(exa\)/);
    expect(r.content).toMatch(/422/);
  });

  it('handles an empty result set without throwing', async () => {
    const fetchFn = vi.fn(async () => exaResponse([])) as unknown as FetchFn;
    const handler = createWebScrapeHandler({ fetchFn, env: { EXA_API_KEY: 'k' } });
    const r = await handler({ mode: 'search', query: 'no hits' }, signal());
    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(/no results/);
  });
});

describe('web_scrape handler — truncation', () => {
  // The shared headAndTail primitive emits `… [N bytes truncated: …] …` and
  // keeps BOTH ends, so truncation is asserted via the marker + the fact that
  // the head is preserved (not a trailing-only slice).
  const TRUNC_MARKER = /… \[\d+ bytes truncated: showing first \d+ \+ last \d+ of \d+\] …/;

  it('truncates body exceeding max_bytes to head+tail with a marker and truncated:true (raw mode)', async () => {
    const big = 'x'.repeat(5000);
    const fetchFn = makeFetch(() => makeResponse({ body: big }));
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    // 500 > the marker's ~160-byte reserve, so head AND tail are non-empty and
    // head-preservation is observable (a cap below the reserve degenerates to
    // marker-only, which is a headAndTail edge case, not what we assert here).
    const r = await handler({ mode: 'raw', url: 'https://example.com', max_bytes: 500 }, signal());
    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(TRUNC_MARKER);
    expect(r.truncated).toBe(true);
    // Output is bounded by max_bytes (marker reserve makes it slightly under).
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(500);
    // Head is preserved (starts with the original leading bytes) — head+tail,
    // not a tail-only slice.
    expect(r.content.startsWith('x')).toBe(true);
  });

  it('does NOT truncate body smaller than max_bytes (no marker, no truncated flag)', async () => {
    const small = 'hello world';
    const fetchFn = makeFetch(() => makeResponse({ body: small }));
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ mode: 'raw', url: 'https://example.com', max_bytes: 1000 }, signal());
    expect(r.content).toBe(small);
    expect(r.truncated).toBeUndefined();
  });

  it('handles multi-byte UTF-8 cleanly (no garbage at the cut points)', async () => {
    const body = '🎉'.repeat(200); // 800 bytes; cut at 200 keeps head+tail of whole emoji
    const fetchFn = makeFetch(() => makeResponse({ body }));
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ mode: 'raw', url: 'https://example.com', max_bytes: 200 }, signal());
    // Head begins on a code-point boundary and the tail ends on one — no U+FFFD.
    expect(r.content.startsWith('🎉')).toBe(true);
    expect(r.content.endsWith('🎉')).toBe(true);
    expect(r.content).not.toContain('\uFFFD');
    expect(r.content).toMatch(TRUNC_MARKER);
    expect(r.truncated).toBe(true);
  });

  it('truncates a body larger than the DEFAULT max_bytes to <= default with a marker and truncated:true', async () => {
    // No explicit max_bytes → the 100KB default applies. A 150KB body must be
    // reduced below the default so a default web_scrape can never overflow a
    // (sub)agent context window (issue #661).
    const big = 'y'.repeat(150_000);
    const fetchFn = makeFetch(() => makeResponse({ body: big }));
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ mode: 'raw', url: 'https://example.com' }, signal());
    expect(r.isError).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.content).toMatch(TRUNC_MARKER);
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(100_000);
  });

  it('clamps an explicit max_bytes above the 1MB ceiling down to 1MB', async () => {
    // Request 5MB (above the 1MB hard ceiling). A ~2MB body must therefore be
    // truncated to <= 1MB rather than passed through — this is the exact class
    // of caller-raised cap that let a 4MB body crash a child before #661.
    const twoMb = 'z'.repeat(2_000_000);
    const fetchFn = makeFetch(() => makeResponse({ body: twoMb }));
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ mode: 'raw', url: 'https://example.com', max_bytes: 5_000_000 }, signal());
    expect(r.isError).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.content).toMatch(TRUNC_MARKER);
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(1_000_000);
  });
});

describe('web_scrape handler — cancellation', () => {
  it('aborts the fetch when the parent signal aborts (raw mode)', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchFn = makeFetch((_url, init) => {
      receivedSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal!.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const ac = new AbortController();
    const pending = handler({ mode: 'raw', url: 'https://example.com' }, ac.signal);
    await new Promise((r) => setImmediate(r));
    ac.abort(new Error('user cancelled'));
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/aborted: user cancelled/);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('reports timeout when the request exceeds timeout_ms (raw mode)', async () => {
    const fetchFn = makeFetch((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const r = await handler({ mode: 'raw', url: 'https://example.com', timeout_ms: 20 }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/timeout after 20ms/);
  });

  it('returns immediately if signal is already aborted at call time, without calling fetch', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ body: 'should not be called' })) as unknown as FetchFn;
    const handler = createWebScrapeHandler({ fetchFn, env: {} });
    const ac = new AbortController();
    ac.abort(new Error('pre-cancelled'));
    const r = await handler({ url: 'https://example.com' }, ac.signal);
    expect(r.isError).toBe(true);
    expect(r.content).toBe('web_scrape aborted: pre-cancelled');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('web_scrape handler — runtime guard', () => {
  it('errors when fetch is not a function (e.g. pre-Node-18 runtime)', async () => {
    const handler = createWebScrapeHandler({
      fetchFn: {} as unknown as FetchFn,
      env: {},
    });
    const r = await handler({ url: 'https://example.com' }, signal());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/global fetch\(\) is not present/);
  });
});
