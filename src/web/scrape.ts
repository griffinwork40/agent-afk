/**
 * Fetch-first web scraper with Playwright-render escalation.
 *
 * Replaces Firecrawl's `markdown` mode with a local pipeline:
 *
 *   1. Plain `fetch` the URL (cheap, no browser). Most articles, docs, and
 *      blogs are server-rendered, so this is the fast common path.
 *   2. Run the shared extraction pipeline (Readability + Turndown).
 *   3. If the result is thin — a short extraction that signals a JS-gated SPA,
 *      or a failed/blocked fetch — escalate to a real headless-browser render
 *      via the injected `RenderFn` (the existing `BrowserProvider`), then run
 *      the SAME extraction pipeline on the post-JavaScript DOM.
 *   4. Return whichever path produced more content.
 *
 * Graceful degradation: if the render escalation fails (Playwright not
 * installed, navigation error, timeout) but we already have *some* fetched
 * content, we return that rather than failing. We only error when no content
 * could be obtained by either path.
 *
 * @module web/scrape
 */

import { extractReadableMarkdown, THIN_CONTENT_CHARS } from './extract.js';
import type { ExtractedContent, FetchFn, RenderFn, RenderedPage } from './types.js';
import { debugLog } from '../utils/debug.js';

/** Content-types we treat as HTML (run the extraction pipeline). */
const HTMLISH_RE = /(text\/html|application\/xhtml\+xml)/i;
/** Text-but-not-HTML types we return verbatim (already readable; no extraction). */
const TEXTISH_RE = /(application\/json|\/xml|\+xml|text\/|application\/(java|ecma)script|csv)/i;
/** Binary types extraction can't handle — caller should use `raw` mode. */
const BINARY_RE = /(image\/|audio\/|video\/|application\/pdf|application\/zip|application\/octet-stream|font\/)/i;

const FETCH_HEADERS: Record<string, string> = {
  // A browser-like UA reduces (does not eliminate) naive bot blocks on the
  // plain-fetch path; genuinely JS-gated or hard-walled pages still escalate.
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 agent-afk/web_scrape',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

export interface ScrapeOptions {
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: FetchFn;
  /**
   * Override for tests. Defaults to a lazy adapter over the browser provider's
   * `render()`. Injecting this lets tests exercise the escalation path without
   * launching chromium.
   */
  renderFn?: RenderFn;
  /** Numeric timeout budget forwarded to fetch (via signal) and to render. */
  timeoutMs: number;
  /** Combined parent+timeout signal. Aborting cancels fetch and render. */
  signal: AbortSignal;
}

export interface ScrapeResult {
  title: string;
  markdown: string;
  /** URL after redirects (from whichever path produced the result). */
  finalUrl: string;
  /** True when the result came from the Playwright-render escalation. */
  usedRender: boolean;
}

/** Run extraction without throwing — degenerate DOMs yield empty content. */
function safeExtract(html: string, url: string): ExtractedContent {
  try {
    return extractReadableMarkdown(html, url);
  } catch (err) {
    debugLog('[web/scrape] extraction failed', { url, err });
    return { title: '', markdown: '', textLength: 0, usedFallback: true };
  }
}

/**
 * Default render adapter: lazily imports the browser registry so chromium is
 * never loaded for the common fetch-only path. Surfaces a missing-Playwright
 * failure as a recognizable error the handler can turn into an install hint.
 */
async function renderViaBrowser(
  url: string,
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<RenderedPage> {
  const { getBrowserProvider } = await import('../browser/registry.js');
  const provider = await getBrowserProvider();
  return provider.render({ url, timeoutMs: opts.timeoutMs, signal: opts.signal });
}

/**
 * Scrape a URL to markdown, escalating to a headless render when the cheap
 * fetch yields thin content.
 *
 * @throws when no content can be obtained (fetch failed AND render failed), or
 *   when the resource is binary (use `raw` mode instead). Abort propagates.
 */
export async function scrapeToMarkdown(url: string, opts: ScrapeOptions): Promise<ScrapeResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const renderFn = opts.renderFn ?? renderViaBrowser;

  // ---- Phase 1: plain fetch -------------------------------------------------
  let fetched: ExtractedContent | null = null;
  let fetchedUrl = url;
  let fetchStatus: number | null = null;
  let fetchErr: unknown = null;

  try {
    const res = await fetchFn(url, {
      headers: FETCH_HEADERS,
      redirect: 'follow',
      signal: opts.signal,
    });
    fetchStatus = res.status;
    fetchedUrl = res.url || url;
    const contentType = res.headers.get('content-type') ?? '';

    if (res.ok) {
      if (BINARY_RE.test(contentType)) {
        throw new Error(
          `web_scrape markdown mode received binary content (${contentType.split(';')[0]}). ` +
            `Use mode: "raw" to fetch the bytes, or a different tool.`,
        );
      }
      const body = await res.text();
      if (TEXTISH_RE.test(contentType) && !HTMLISH_RE.test(contentType)) {
        // JSON / XML / plain text / CSV — already readable; return verbatim.
        return { title: '', markdown: body.trim(), finalUrl: fetchedUrl, usedRender: false };
      }
      // HTML or unknown content-type → extraction pipeline.
      fetched = safeExtract(body, fetchedUrl);
    }
  } catch (err) {
    // Abort is terminal — propagate so the handler reports cancellation.
    if (opts.signal.aborted) throw err;
    // A thrown binary-content error must surface, not silently escalate.
    if (err instanceof Error && err.message.startsWith('web_scrape markdown mode received binary')) {
      throw err;
    }
    // Otherwise a network-level failure — fall through to render escalation.
    fetchErr = err;
  }

  // ---- Phase 2: decide whether to escalate ----------------------------------
  const thin = fetched === null || fetched.textLength < THIN_CONTENT_CHARS;
  if (!thin && fetched !== null) {
    return {
      title: fetched.title,
      markdown: fetched.markdown,
      finalUrl: fetchedUrl,
      usedRender: false,
    };
  }

  // ---- Phase 3: render escalation -------------------------------------------
  try {
    const rendered = await renderFn(url, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    const renderedContent = safeExtract(rendered.html, rendered.finalUrl);
    // Prefer the render result when it has at least as much text as the fetch.
    if (fetched === null || renderedContent.textLength >= fetched.textLength) {
      return {
        title: renderedContent.title,
        markdown: renderedContent.markdown,
        finalUrl: rendered.finalUrl,
        usedRender: true,
      };
    }
  } catch (renderErr) {
    // Abort during render is terminal.
    if (opts.signal.aborted) throw renderErr;
    // Render failed (e.g. Playwright not installed). If we have *some* fetched
    // content, degrade gracefully to it. If a missing-Playwright error is the
    // only signal AND we have nothing, re-throw it so the handler can hint.
    if (fetched === null) {
      const rMsg = renderErr instanceof Error ? renderErr.message : String(renderErr);
      const fMsg =
        fetchErr instanceof Error ? fetchErr.message : `HTTP ${fetchStatus ?? 'error'}`;
      const err = new Error(
        `web_scrape could not retrieve ${url}: fetch failed (${fMsg}) and ` +
          `render failed (${rMsg}).`,
      );
      // Preserve the render cause so the handler can detect a missing install.
      (err as Error & { cause?: unknown }).cause = renderErr;
      throw err;
    }
    // else fall through and return the thin fetched content below.
  }

  // ---- Phase 4: fall back to the (thin) fetched content ---------------------
  if (fetched !== null) {
    return {
      title: fetched.title,
      markdown: fetched.markdown,
      finalUrl: fetchedUrl,
      usedRender: false,
    };
  }

  // No content from either path and no thrown error above (e.g. render
  // returned empty and fetch produced nothing) — surface a clear failure.
  throw new Error(`web_scrape could not retrieve any content from ${url} (HTTP ${fetchStatus ?? 'error'}).`);
}
