/**
 * Shared types for the `src/web/` content-fetching layer.
 *
 * This module is the contract between the `web_scrape` tool handler
 * (`src/agent/tools/handlers/web-scrape.ts`) and the pluggable scrape/search
 * backends in this directory. Nothing here imports a network or browser SDK —
 * those live behind the injected function seams (`FetchFn`, `RenderFn`).
 *
 * @module web/types
 */

/** The global `fetch` signature. Injected into backends so tests can stub it. */
export type FetchFn = typeof fetch;

/**
 * Renders a URL to fully-loaded HTML using a real (headless) browser, so the
 * caller sees the post-JavaScript DOM. Injected into the scraper so tests can
 * stub the browser without launching chromium.
 *
 * Contract:
 *   - Resolves with the serialized DOM (`html`), the post-redirect URL
 *     (`finalUrl`), and the navigation HTTP status (or `null` when the
 *     navigation produced no HTTP response, e.g. `about:blank`).
 *   - Rejects on navigation failure, timeout, abort, or a missing Playwright
 *     install. The scraper maps a rejection to a graceful fallback or a
 *     `ToolResult` error, never a crash.
 */
export type RenderFn = (
  url: string,
  opts: { timeoutMs: number; signal: AbortSignal },
) => Promise<RenderedPage>;

/** Output of a {@link RenderFn} — the rendered DOM plus navigation metadata. */
export interface RenderedPage {
  html: string;
  finalUrl: string;
  httpStatus: number | null;
}

/**
 * Readable content extracted from an HTML document and converted to markdown.
 *
 * Produced by `extractReadableMarkdown()` in `./extract.ts`. The `textLength`
 * field drives the scraper's thin-content heuristic — a short extraction from
 * a plain `fetch` signals a JS-gated page that should escalate to a render.
 */
export interface ExtractedContent {
  /** Article/page title, or '' when none could be derived. */
  title: string;
  /** Main content converted to markdown. May be '' for an empty document. */
  markdown: string;
  /**
   * Length of the extracted plain text (pre-markdown), used by the scraper to
   * decide whether the fetch-first result is "thin" and warrants a render.
   */
  textLength: number;
  /**
   * True when Readability found no article and we fell back to converting the
   * whole document body. Surfaced so the scraper can prefer a render result.
   */
  usedFallback: boolean;
}

/** A single ranked web-search result. */
export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

/**
 * A pluggable web-search backend.
 *
 * Ships one implementation: Exa (`./search.ts`). The interface exists so
 * Brave / DuckDuckGo / SearXNG / Tavily / SerpAPI backends can be added
 * later without touching the handler — it resolves a backend and calls
 * `search()`.
 */
export interface SearchBackend {
  /** Backend identifier, e.g. `'exa'`. Surfaced in error messages. */
  readonly name: string;
  /**
   * Run a query and return ranked results.
   *
   * @throws when the upstream request fails or the backend is misconfigured
   *   (e.g. missing API key). The handler maps the error to a `ToolResult`.
   */
  search(
    query: string,
    opts: { limit: number; timeoutMs: number; signal: AbortSignal },
  ): Promise<SearchResult[]>;
}
