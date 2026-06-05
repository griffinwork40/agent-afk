/**
 * Unit tests for the fetch-first scraper (src/web/scrape.ts).
 *
 * Strategy: inject `fetchFn` and `renderFn` so neither a real network nor a
 * real browser is touched. The behaviors under test are the escalation
 * decision (thin fetch → render), graceful degradation (render fails but we
 * keep thin fetch content), content-type handling, and abort propagation.
 */

import { describe, it, expect, vi } from 'vitest';
import { scrapeToMarkdown } from './scrape.js';
import type { RenderFn } from './types.js';

/** A content-rich, server-rendered article (extracted text well over thin). */
function richHtml(marker = 'rich fetched body'): string {
  const paras = Array.from(
    { length: 6 },
    (_, i) =>
      `<p>Paragraph ${i + 1}: ${marker}. This sentence pads the article so the ` +
      `Readability heuristic selects it as the main content region of the page.</p>`,
  ).join('');
  return `<!DOCTYPE html><html><head><title>Article</title></head><body><article>
    <h1>Article</h1>${paras}</article></body></html>`;
}

/** A JS-gated shell — almost no server-rendered text. */
const SHELL_HTML = '<!DOCTYPE html><html><head><title>App</title></head><body><div id="root">Loading…</div></body></html>';

function makeResponse(opts: {
  status?: number;
  contentType?: string;
  body?: string;
  url?: string;
}): Response {
  const status = opts.status ?? 200;
  const headers = new Headers();
  if (opts.contentType !== undefined) headers.set('content-type', opts.contentType);
  return {
    ok: status >= 200 && status < 300,
    status,
    url: opts.url ?? '',
    headers,
    text: async (): Promise<string> => opts.body ?? '',
  } as unknown as Response;
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe('scrapeToMarkdown — fetch-first happy path', () => {
  it('uses the fetch result and does NOT render when content is rich', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: richHtml() }));
    const renderFn = vi.fn<RenderFn>(async () => ({ html: '', finalUrl: '', httpStatus: 200 }));

    const out = await scrapeToMarkdown('https://example.com/a', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
    });

    expect(out.usedRender).toBe(false);
    expect(out.markdown).toContain('rich fetched body');
    expect(out.title).toBe('Article');
    expect(renderFn).not.toHaveBeenCalled();
  });
});

describe('scrapeToMarkdown — render escalation', () => {
  it('escalates to render when the fetched page is a thin JS shell', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: SHELL_HTML }));
    const renderFn = vi.fn<RenderFn>(async () => ({
      html: richHtml('rendered after JS'),
      finalUrl: 'https://example.com/a',
      httpStatus: 200,
    }));

    const out = await scrapeToMarkdown('https://example.com/a', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
    });

    expect(renderFn).toHaveBeenCalledOnce();
    expect(out.usedRender).toBe(true);
    expect(out.markdown).toContain('rendered after JS');
  });

  it('escalates to render when the plain fetch throws a network error', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const renderFn = vi.fn<RenderFn>(async () => ({
      html: richHtml('rendered fallback'),
      finalUrl: 'https://example.com/a',
      httpStatus: 200,
    }));

    const out = await scrapeToMarkdown('https://example.com/a', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
    });

    expect(renderFn).toHaveBeenCalledOnce();
    expect(out.usedRender).toBe(true);
    expect(out.markdown).toContain('rendered fallback');
  });
});

describe('scrapeToMarkdown — graceful degradation', () => {
  it('returns the thin fetch content when render fails', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: SHELL_HTML }));
    const renderFn = vi.fn<RenderFn>(async () => {
      throw new Error('Cannot find package playwright');
    });

    const out = await scrapeToMarkdown('https://example.com/a', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
    });

    expect(out.usedRender).toBe(false);
    expect(out.markdown).toContain('Loading');
  });

  it('throws when both fetch and render fail (no content at all)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    const renderFn = vi.fn<RenderFn>(async () => {
      throw new Error('Cannot find package playwright');
    });

    await expect(
      scrapeToMarkdown('https://example.com/a', {
        fetchFn: fetchFn as unknown as typeof fetch,
        renderFn,
        timeoutMs: 5000,
        signal: freshSignal(),
      }),
    ).rejects.toThrow(/could not retrieve/i);
  });
});

describe('scrapeToMarkdown — content-type handling', () => {
  it('returns non-HTML text (JSON) verbatim without rendering', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ contentType: 'application/json', body: '{"hello":"world"}' }),
    );
    const renderFn = vi.fn<RenderFn>(async () => ({ html: '', finalUrl: '', httpStatus: 200 }));

    const out = await scrapeToMarkdown('https://api.example.com/x', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
    });

    expect(out.markdown).toBe('{"hello":"world"}');
    expect(out.usedRender).toBe(false);
    expect(renderFn).not.toHaveBeenCalled();
  });

  it('throws a clear error for binary content', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ contentType: 'application/pdf', body: '%PDF-1.7…' }),
    );

    await expect(
      scrapeToMarkdown('https://example.com/doc.pdf', {
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 5000,
        signal: freshSignal(),
      }),
    ).rejects.toThrow(/binary content/i);
  });
});

describe('scrapeToMarkdown — cancellation', () => {
  it('propagates an abort that occurs during fetch', async () => {
    const ac = new AbortController();
    const fetchFn = vi.fn(async () => {
      ac.abort(new Error('cancelled'));
      throw new Error('The operation was aborted');
    });

    await expect(
      scrapeToMarkdown('https://example.com/a', {
        fetchFn: fetchFn as unknown as typeof fetch,
        timeoutMs: 5000,
        signal: ac.signal,
      }),
    ).rejects.toThrow();
  });
});
