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
  headers?: Record<string, string>;
}): Response {
  const status = opts.status ?? 200;
  const headers = new Headers();
  if (opts.contentType !== undefined) headers.set('content-type', opts.contentType);
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
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

/**
 * Hermetic DNS seam for the SSRF egress guard (issue #575): resolves every
 * hostname to a fixed PUBLIC address so these tests never issue real DNS and
 * never depend on network reachability. Guard behaviour is covered in
 * `src/web/egress-guard.test.ts`; the guard's integration with this module is
 * covered by the `egress guard` describe block at the bottom of this file.
 */
const publicLookup = async (): Promise<readonly { address: string }[]> => [
  { address: '93.184.216.34' },
];

describe('scrapeToMarkdown — fetch-first happy path', () => {
  it('uses the fetch result and does NOT render when content is rich', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: richHtml() }));
    const renderFn = vi.fn<RenderFn>(async () => ({ html: '', finalUrl: '', httpStatus: 200 }));

    const out = await scrapeToMarkdown('https://example.com/a', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
      lookupFn: publicLookup,
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
      lookupFn: publicLookup,
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
      lookupFn: publicLookup,
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
      lookupFn: publicLookup,
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
        lookupFn: publicLookup,
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
      lookupFn: publicLookup,
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
        lookupFn: publicLookup,
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
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow();
  });

  it('propagates an abort that occurs during render (Phase 3 signal.aborted guard)', async () => {
    // Branch: scrape.ts ~L170 — signal is aborted when the render catch block
    // runs. The renderFn fires the abort and then throws so the catch branch
    // sees signal.aborted === true and re-throws rather than degrading.
    const ac = new AbortController();
    const fetchFn = vi.fn(async () =>
      makeResponse({ contentType: 'text/html', body: SHELL_HTML }),
    );
    const renderFn = vi.fn<RenderFn>(async () => {
      ac.abort(new Error('render aborted'));
      throw new Error('render aborted');
    });

    await expect(
      scrapeToMarkdown('https://example.com/a', {
        fetchFn: fetchFn as unknown as typeof fetch,
        renderFn,
        timeoutMs: 5000,
        signal: ac.signal,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow(/render aborted/);
  });

  it('honors an abort that fires during the fetch-path extraction await', async () => {
    // Regression for the lazy-jsdom async boundary (PR #587): safeExtract /
    // extractReadableMarkdown do not observe the signal, so an abort landing
    // while the fetched HTML is being extracted must be caught by the post-await
    // guard. Here fetch resolves normally with rich (non-thin) HTML but the
    // signal aborts as the body is read; without the guard scrapeToMarkdown
    // would return a successful result after cancellation.
    const ac = new AbortController();
    const fetchFn = vi.fn(async () => {
      const res = makeResponse({ contentType: 'text/html', body: richHtml() });
      (res as { text: () => Promise<string> }).text = async () => {
        ac.abort(new Error('cancelled during extraction'));
        return richHtml();
      };
      return res;
    });
    const renderFn = vi.fn<RenderFn>(async () => ({ html: '', finalUrl: '', httpStatus: 200 }));

    await expect(
      scrapeToMarkdown('https://example.com/a', {
        fetchFn: fetchFn as unknown as typeof fetch,
        renderFn,
        timeoutMs: 5000,
        signal: ac.signal,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow();
    // The abort must short-circuit before any render escalation.
    expect(renderFn).not.toHaveBeenCalled();
  });

  it('honors an abort that fires during the render-path extraction await', async () => {
    // Regression for the lazy-jsdom async boundary (PR #587), Phase 3: the thin
    // fetch escalates to render, render resolves normally with rich HTML, but
    // the signal aborts around the render/extraction boundary. Only the
    // post-await guard catches this — the existing catch fires solely when
    // render or extraction throws. Without the guard the rich render result
    // would be returned as a success after cancellation.
    const ac = new AbortController();
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: SHELL_HTML }));
    const renderFn = vi.fn<RenderFn>(async () => {
      ac.abort(new Error('cancelled during render extraction'));
      return { html: richHtml('rendered'), finalUrl: 'https://example.com/a', httpStatus: 200 };
    });

    await expect(
      scrapeToMarkdown('https://example.com/a', {
        fetchFn: fetchFn as unknown as typeof fetch,
        renderFn,
        timeoutMs: 5000,
        signal: ac.signal,
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow();
    expect(renderFn).toHaveBeenCalledOnce();
  });
});

describe('scrapeToMarkdown — render produces fewer chars than thin fetch', () => {
  it('returns the fetched content with usedRender:false when render yields less text', async () => {
    // Branch: scrape.ts ~L160 — render succeeds but renderedContent.textLength
    // is strictly less than fetched.textLength. The condition
    // `renderedContent.textLength >= fetched.textLength` is false so we fall
    // through to Phase 4 and return the thin fetched content with usedRender:false.
    //
    // Setup: the thin shell HTML has a visible "Loading…" word (a few chars of
    // text). The render returns a completely empty document — even fewer chars —
    // so the comparison flips and we keep the fetch result.
    const fetchFn = vi.fn(async () =>
      makeResponse({ contentType: 'text/html', body: SHELL_HTML }),
    );
    const emptyHtml = '<html><head><title></title></head><body></body></html>';
    const renderFn = vi.fn<RenderFn>(async () => ({
      html: emptyHtml,
      finalUrl: 'https://example.com/a',
      httpStatus: 200,
    }));

    const out = await scrapeToMarkdown('https://example.com/a', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
      lookupFn: publicLookup,
    });

    // Render was invoked (thin fetch triggered escalation)…
    expect(renderFn).toHaveBeenCalledOnce();
    // …but the render produced less content, so we fell back to the fetch result.
    expect(out.usedRender).toBe(false);
    // The thin fetched content should be present (the "Loading" text from SHELL_HTML).
    expect(out.markdown).toContain('Loading');
  });
});

describe('scrapeToMarkdown — SSRF egress guard (issue #575)', () => {
  /** Resolves every hostname to loopback — the DNS-rebinding scenario. */
  const rebindLookup = async (): Promise<readonly { address: string }[]> => [
    { address: '127.0.0.1' },
  ];

  it('passes a pre-request guard to the renderer for redirects and subresources', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: SHELL_HTML }));
    const renderFn = vi.fn<RenderFn>(async (_url, renderOpts) => {
      await renderOpts.requestGuard?.('http://169.254.169.254/latest/meta-data/');
      return { html: richHtml('unreachable'), finalUrl: 'https://example.com/', httpStatus: 200 };
    });

    await expect(
      scrapeToMarkdown('https://example.com/', {
        fetchFn: fetchFn as unknown as typeof fetch,
        renderFn,
        timeoutMs: 5000,
        signal: freshSignal(),
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow(/internal\/private address 169\.254\.169\.254/);
  });

  it('refuses an internal IP literal without fetching or rendering', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: richHtml() }));
    const renderFn = vi.fn<RenderFn>(async () => ({
      html: richHtml('rendered'),
      finalUrl: 'http://169.254.169.254/',
      httpStatus: 200,
    }));

    await expect(
      scrapeToMarkdown('http://169.254.169.254/latest/meta-data/', {
        fetchFn: fetchFn as unknown as typeof fetch,
        renderFn,
        timeoutMs: 5000,
        signal: freshSignal(),
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow(/internal\/private address 169\.254\.169\.254/);

    expect(fetchFn).not.toHaveBeenCalled();
    // Critical: the refusal must NOT degrade into the render escalation, which
    // is a second, independent egress path.
    expect(renderFn).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to loopback (DNS rebinding) and does NOT escalate to render', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: richHtml() }));
    const renderFn = vi.fn<RenderFn>(async () => ({
      html: richHtml('rendered'),
      finalUrl: 'https://safe-looking.example/',
      httpStatus: 200,
    }));

    await expect(
      scrapeToMarkdown('https://safe-looking.example/', {
        fetchFn: fetchFn as unknown as typeof fetch,
        renderFn,
        timeoutMs: 5000,
        signal: freshSignal(),
        lookupFn: rebindLookup,
      }),
    ).rejects.toThrow(/internal\/private address 127\.0\.0\.1/);

    expect(fetchFn).not.toHaveBeenCalled();
    expect(renderFn).not.toHaveBeenCalled();
  });

  it('refuses a redirect hop that lands on internal space', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ status: 302, headers: { location: 'http://169.254.169.254/latest/' } }),
    );
    const renderFn = vi.fn<RenderFn>(async () => ({
      html: richHtml('rendered'),
      finalUrl: 'https://example.com/a',
      httpStatus: 200,
    }));

    await expect(
      scrapeToMarkdown('https://example.com/a', {
        fetchFn: fetchFn as unknown as typeof fetch,
        renderFn,
        timeoutMs: 5000,
        signal: freshSignal(),
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow(/internal\/private address 169\.254\.169\.254/);

    // Only the first (public) hop was requested.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(renderFn).not.toHaveBeenCalled();
  });

  it('refuses when the RENDER path redirects to internal space (post-navigation re-check)', async () => {
    // Fetch yields thin content → escalation fires; the render then reports a
    // finalUrl inside link-local space, which the post-check must catch.
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: SHELL_HTML }));
    const renderFn = vi.fn<RenderFn>(async () => ({
      html: richHtml('rendered from internal'),
      finalUrl: 'http://169.254.169.254/latest/meta-data/',
      httpStatus: 200,
    }));

    await expect(
      scrapeToMarkdown('https://example.com/a', {
        fetchFn: fetchFn as unknown as typeof fetch,
        renderFn,
        timeoutMs: 5000,
        signal: freshSignal(),
        lookupFn: publicLookup,
      }),
    ).rejects.toThrow(/internal\/private address 169\.254\.169\.254/);

    expect(renderFn).toHaveBeenCalledOnce();
  });

  it('allows an internal target when AFK_WEB_ALLOW_PRIVATE_HOSTS=1', async () => {
    vi.stubEnv('AFK_WEB_ALLOW_PRIVATE_HOSTS', '1');
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: richHtml('localhost body') }));

    const out = await scrapeToMarkdown('http://127.0.0.1:3000/', {
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 5000,
      signal: freshSignal(),
      lookupFn: publicLookup,
    });

    expect(out.markdown).toContain('localhost body');
    expect(fetchFn).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });
});

describe('scrapeToMarkdown — extraction advisory', () => {
  /**
   * A page whose visible text is dominated by regions Readability discards
   * (nav/aside/footer), so extraction succeeds and looks healthy while most of
   * the page's words never reach the model. This is the shape that produced the
   * silent-gap retry storm: rich enough to skip the render escalation, lossy
   * enough that a section the caller wanted can be missing.
   */
  function lossyHtml(): string {
    const filler = (label: string, n: number): string =>
      Array.from(
        { length: n },
        (_, i) =>
          `<p>${label} row ${i + 1}: this text exists in the source document and a human ` +
          `reading the page in a browser would see it rendered on screen.</p>`,
      ).join('');
    return (
      '<!DOCTYPE html><html><head><title>Docs</title></head><body>' +
      `<nav>${filler('nav', 40)}</nav>` +
      '<article><h1>Docs</h1><p>The one short paragraph Readability keeps as the article ' +
      'body, padded just enough to clear the thin-content floor and skip the render.</p>' +
      '<p>A second sentence of genuine article prose so extraction has a real region.</p>' +
      '</article>' +
      `<aside>${filler('aside', 40)}</aside><footer>${filler('footer', 40)}</footer>` +
      '</body></html>'
    );
  }

  it('attaches an advisory when extraction keeps little of the visible text', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: lossyHtml() }));
    const renderFn = vi.fn<RenderFn>(async () => ({ html: '', finalUrl: '', httpStatus: 200 }));

    const out = await scrapeToMarkdown('https://example.com/docs', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
      lookupFn: publicLookup,
    });

    // Behavior is unchanged: still a successful fetch-path result, no render.
    expect(out.usedRender).toBe(false);
    expect(renderFn).not.toHaveBeenCalled();
    expect(out.markdown.length).toBeGreaterThan(0);
    expect(out.advisory).toBeDefined();
    expect(out.advisory).toContain('mode: "raw"');
  });

  it('attaches no advisory to an ordinary article', async () => {
    const fetchFn = vi.fn(async () => makeResponse({ contentType: 'text/html', body: richHtml() }));
    const renderFn = vi.fn<RenderFn>(async () => ({ html: '', finalUrl: '', httpStatus: 200 }));

    const out = await scrapeToMarkdown('https://example.com/a', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
      lookupFn: publicLookup,
    });

    expect(out.advisory).toBeUndefined();
  });

  it('attaches no advisory to a non-html body (no extraction ran)', async () => {
    const fetchFn = vi.fn(async () =>
      makeResponse({ contentType: 'application/json', body: JSON.stringify({ a: 1 }) }),
    );
    const renderFn = vi.fn<RenderFn>(async () => ({ html: '', finalUrl: '', httpStatus: 200 }));

    const out = await scrapeToMarkdown('https://example.com/api', {
      fetchFn: fetchFn as unknown as typeof fetch,
      renderFn,
      timeoutMs: 5000,
      signal: freshSignal(),
      lookupFn: publicLookup,
    });

    expect(out.advisory).toBeUndefined();
  });
});
