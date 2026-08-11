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
import { extractionAdvisory } from './extraction-advisory.js';
import type { ExtractedContent, FetchFn, RenderFn, RenderedPage } from './types.js';
import { assertEgressAllowed, guardedFetch, EgressBlockedError } from './egress-guard.js';
import type { EgressGuardOptions } from './egress-guard.js';
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
  /**
   * Override for tests: DNS resolution used by the SSRF egress guard. Defaults
   * (inside the guard) to `dns/promises.lookup`. Injecting it keeps unit tests
   * off the network, matching the `fetchFn` / `renderFn` seams above.
   */
  lookupFn?: EgressGuardOptions['lookupFn'];
}

export interface ScrapeResult {
  title: string;
  markdown: string;
  /** URL after redirects (from whichever path produced the result). */
  finalUrl: string;
  /** True when the result came from the Playwright-render escalation. */
  usedRender: boolean;
  /**
   * Set when extraction retained suspiciously little of the source's visible
   * text — see `extraction-advisory.ts`. Optional and non-blocking: the result
   * is still a success, and consumers that ignore it behave exactly as before.
   */
  advisory?: string;
}

/** Run extraction without throwing — degenerate DOMs yield empty content. */
async function safeExtract(html: string, url: string): Promise<ExtractedContent> {
  try {
    return await extractReadableMarkdown(html, url);
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
  opts: { timeoutMs: number; signal: AbortSignal; requestGuard?: (url: string) => Promise<void> },
): Promise<RenderedPage> {
  const { getBrowserProvider } = await import('../browser/registry.js');
  const provider = await getBrowserProvider();
  return provider.render({
    url,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    requestGuard: opts.requestGuard,
  });
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
  const guardOpts: EgressGuardOptions =
    opts.lookupFn !== undefined ? { lookupFn: opts.lookupFn } : {};

  // ---- Phase 1: plain fetch -------------------------------------------------
  let fetched: ExtractedContent | null = null;
  // Retained for the extraction-advisory ratio in Phase 2: `body` is scoped to
  // the try block below, and the advisory needs the source html to compare
  // against what extraction kept.
  let fetchedHtml = '';
  let fetchedUrl = url;
  let fetchStatus: number | null = null;
  let fetchErr: unknown = null;

  try {
    // guardedFetch = retryFetch (transient 429/5xx + network blips on an
    // idempotent GET) wrapped in the SSRF egress guard, which forces
    // redirect:'manual' so every hop is re-validated (issue #575).
    const res = await guardedFetch(
      fetchFn,
      url,
      { headers: FETCH_HEADERS, signal: opts.signal },
      guardOpts,
    );
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
      fetchedHtml = body;
      fetched = await safeExtract(body, fetchedUrl);
      // Extraction is an async boundary (lazy jsdom/Readability/Turndown import
      // on first call, then parse) that does NOT observe the signal. Re-check
      // after it resolves so a cancel/timeout that fired during the await is
      // honored — the catch below turns this into a terminal abort instead of
      // returning a stale successful result.
      if (opts.signal.aborted) throw opts.signal.reason ?? new Error('aborted');
    }
  } catch (err) {
    // Abort is terminal — propagate so the handler reports cancellation.
    if (opts.signal.aborted) throw err;
    // Invariant: an egress refusal is TERMINAL and must never fall through to
    // the render escalation. The headless render is a second, independent
    // egress path (chromium does its own DNS + redirect handling), so degrading
    // to it would hand an attacker exactly the internal fetch the guard just
    // refused. Re-throw before any escalation decision (issue #575).
    if (err instanceof EgressBlockedError) throw err;
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
    // This is the exact path that produced the silent-gap bug: extraction looked
    // healthy, so no render escalation ran, so nothing told the model a section
    // had been dropped. Attach the advisory here and nowhere else — the thin and
    // render paths already give the model a visible signal (a tiny body, or a
    // render that superseded the fetch).
    const advisory = extractionAdvisory({
      html: fetchedHtml,
      extractedTextLength: fetched.textLength,
    });
    return {
      title: fetched.title,
      markdown: fetched.markdown,
      finalUrl: fetchedUrl,
      usedRender: false,
      ...(advisory !== undefined ? { advisory } : {}),
    };
  }

  // ---- Phase 3: render escalation -------------------------------------------
  try {
    // Invariant: the render escalation is a SECOND egress path — chromium does
    // its own DNS resolution and follows redirects internally, so the
    // plain-fetch guard above does not cover it. Validate before navigating,
    // then re-validate `finalUrl` after, because an in-browser redirect chain is
    // opaque to us (same pre/post pattern `act()` uses for the domain policy).
    await assertEgressAllowed(url, guardOpts);
    const rendered = await renderFn(url, {
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      requestGuard: (requestUrl) => assertEgressAllowed(requestUrl, guardOpts),
    });
    // Only re-check a finalUrl that actually MOVED to another http(s) target:
    // the pre-check already cleared `url`, and a non-http landing spot
    // (`about:blank`, a stubbed empty string) names no egress target to
    // classify — treating those as refusals would break benign renders.
    if (rendered.finalUrl !== url && /^https?:\/\//i.test(rendered.finalUrl)) {
      await assertEgressAllowed(rendered.finalUrl, guardOpts);
    }
    const renderedContent = await safeExtract(rendered.html, rendered.finalUrl);
    // Same async-boundary abort re-check as the fetch path above: extraction
    // does not observe the signal, so honor a cancel/timeout that landed during
    // it. The catch below re-throws when aborted rather than degrading.
    if (opts.signal.aborted) throw opts.signal.reason ?? new Error('aborted');
    // Prefer the render result when it has at least as much text as the fetch.
    if (fetched === null || renderedContent.textLength >= fetched.textLength) {
      const advisory = extractionAdvisory({
        html: rendered.html,
        extractedTextLength: renderedContent.textLength,
      });
      return {
        title: renderedContent.title,
        markdown: renderedContent.markdown,
        finalUrl: rendered.finalUrl,
        usedRender: true,
        ...(advisory !== undefined ? { advisory } : {}),
      };
    }
  } catch (renderErr) {
    // Abort during render is terminal.
    if (opts.signal.aborted) throw renderErr;
    // An egress refusal on the render path is terminal too: degrading to thin
    // fetched content here would report partial success for a request the guard
    // refused, hiding the block from the caller.
    if (renderErr instanceof EgressBlockedError) throw renderErr;
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
