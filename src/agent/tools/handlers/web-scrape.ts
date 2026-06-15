/**
 * Handler for the `web_scrape` tool.
 *
 * Fetches web content and returns text suitable for model consumption. Three
 * modes, each backed locally — no third-party scraping API:
 *
 *   - `markdown` (default): fetch the URL, isolate the main content with
 *     Mozilla Readability, and convert it to markdown with Turndown. If the
 *     plain fetch yields thin content (a JS-gated SPA, or a blocked/empty
 *     response) the scraper escalates to a real headless-browser render via
 *     the existing `BrowserProvider` and re-runs the same extraction pipeline.
 *     No API key required. See `src/web/scrape.ts`.
 *   - `raw`: GET <url> directly. No transformation — caller gets whatever the
 *     origin serves (HTML, JSON, plain text, …). No auth.
 *   - `search`: query a web-search backend and return ranked results as
 *     markdown. Ships Exa Search (`EXA_API_KEY`); the backend interface is
 *     pluggable (Brave / DuckDuckGo / SearXNG / Tavily can be added
 *     later). When no backend is configured the handler returns a clear,
 *     actionable error. See `src/web/search.ts`.
 *
 * Security note: this tool can issue arbitrary outbound HTTP(S) requests to
 * any host the operator's network can reach. The bash tool already has
 * unrestricted network access in agent-afk's threat model, so web_scrape does
 * not widen the surface — it just gives the model a structured, size-capped,
 * timeout-enforced alternative to `curl | head -c …`. The markdown render
 * escalation deliberately bypasses the interactive browser domain allowlist
 * for the same reason (see `BrowserProvider.render()`).
 *
 * @module agent/tools/handlers/web-scrape
 */

import type { ToolHandler } from '../types.js';
import { scrapeToMarkdown } from '../../../web/scrape.js';
import { resolveSearchBackend, formatSearchResults } from '../../../web/search.js';
import type { RenderFn } from '../../../web/types.js';

// External constraint: Node 20+ ships `fetch` as a global. Older runtimes
// would throw before reaching this handler because tsconfig targets >=20.
type FetchFn = typeof fetch;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 1_000_000; // 1 MB
const MAX_MAX_BYTES = 10_000_000; // 10 MB hard ceiling
const TRUNC_MARKER = '\n\n[…truncated by agent-afk web_scrape]';
const DEFAULT_SEARCH_LIMIT = 10;

// Hints in a thrown error message that mean the optional Playwright peer dep
// (or its chromium binary) is missing — surfaced as a friendly install nudge.
const PLAYWRIGHT_MISSING_HINTS = ['Cannot find package', 'ERR_MODULE_NOT_FOUND', "Executable doesn't exist"];

interface WebScrapeOptions {
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: FetchFn;
  /** Override for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Override for tests: the render escalation used by markdown mode. Defaults
   * (inside the scraper) to a lazy adapter over the browser provider, so tests
   * can exercise escalation without launching chromium.
   */
  renderFn?: RenderFn;
}

type Mode = 'markdown' | 'raw' | 'search';

interface ParsedInput {
  mode: Mode;
  url: string | undefined;
  query: string | undefined;
  timeoutMs: number;
  maxBytes: number;
}

function parseInput(raw: unknown): ParsedInput | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Invalid input: expected an object' };
  }
  const obj = raw as Record<string, unknown>;

  const modeRaw = obj['mode'] ?? 'markdown';
  if (modeRaw !== 'markdown' && modeRaw !== 'raw' && modeRaw !== 'search') {
    return {
      error:
        `Invalid input: mode must be one of "markdown", "raw", "search" ` +
        `(got ${JSON.stringify(modeRaw)})`,
    };
  }
  const mode = modeRaw as Mode;

  let url: string | undefined;
  let query: string | undefined;

  if (mode === 'search') {
    if (typeof obj['query'] !== 'string' || obj['query'].length === 0) {
      return { error: 'Invalid input: search mode requires a non-empty "query" string' };
    }
    query = obj['query'];
  } else {
    if (typeof obj['url'] !== 'string' || obj['url'].length === 0) {
      return { error: `Invalid input: ${mode} mode requires a non-empty "url" string` };
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(obj['url']);
    } catch {
      return { error: `Invalid input: "${obj['url']}" is not a valid absolute URL` };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { error: `Invalid input: protocol "${parsedUrl.protocol}" not supported (http/https only)` };
    }
    url = parsedUrl.toString();
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj['timeout_ms'] !== undefined) {
    if (typeof obj['timeout_ms'] !== 'number' || !Number.isFinite(obj['timeout_ms']) || obj['timeout_ms'] <= 0) {
      return { error: 'Invalid input: timeout_ms must be a positive finite number' };
    }
    timeoutMs = Math.min(obj['timeout_ms'], MAX_TIMEOUT_MS);
  }

  let maxBytes = DEFAULT_MAX_BYTES;
  if (obj['max_bytes'] !== undefined) {
    if (typeof obj['max_bytes'] !== 'number' || !Number.isFinite(obj['max_bytes']) || obj['max_bytes'] <= 0) {
      return { error: 'Invalid input: max_bytes must be a positive finite number' };
    }
    maxBytes = Math.min(obj['max_bytes'], MAX_MAX_BYTES);
  }

  return { mode, url, query, timeoutMs, maxBytes };
}

function truncateUtf8(body: string, maxBytes: number): string {
  // External constraint: maxBytes is a UTF-8 byte ceiling, but `.subarray()`
  // can split a multi-byte sequence. Convert to Buffer, slice, decode with
  // 'utf8' which replaces a partial trailing code point with U+FFFD rather
  // than emitting garbage.
  const buf = Buffer.from(body, 'utf8');
  if (buf.byteLength <= maxBytes) return body;
  return buf.subarray(0, maxBytes).toString('utf8') + TRUNC_MARKER;
}

/** Did this error (or its cause chain) signal a missing Playwright install? */
function isPlaywrightMissing(err: unknown): boolean {
  const messages: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    messages.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  const joined = messages.join(' | ');
  return PLAYWRIGHT_MISSING_HINTS.some((hint) => joined.includes(hint));
}

export function createWebScrapeHandler(opts: WebScrapeOptions = {}): ToolHandler {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const env = opts.env ?? process.env;

  return async (input, signal) => {
    if (typeof fetchFn !== 'function') {
      return {
        content:
          'web_scrape unavailable: global fetch() is not present in this runtime ' +
          '(agent-afk requires Node 20+).',
        isError: true,
      };
    }

    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }

    // Pre-aborted short-circuit: return immediately without arming a timer or
    // issuing any request when the caller's signal is already aborted.
    if (signal.aborted) {
      const reason = signal.reason;
      const msg = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
      return { content: `web_scrape aborted: ${msg}`, isError: true };
    }

    // Ordered-operation constraint: build the AbortController, wire the parent
    // signal AND the timeout to it, then issue work. The `finally` block tears
    // down the listener + timer in the inverse order. Failing to clear the
    // timer leaks a Node timer reference; failing to remove the listener leaks
    // a hard reference to `ac` from the caller's signal.
    const ac = new AbortController();
    const onParentAbort = (): void => {
      ac.abort(signal.reason);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;

    const abortMessage = (): string => {
      const reason = ac.signal.reason;
      return reason instanceof Error ? reason.message : String(reason ?? 'aborted');
    };

    try {
      signal.addEventListener('abort', onParentAbort, { once: true });
      timer = setTimeout(() => {
        ac.abort(new Error(`web_scrape timeout after ${parsed.timeoutMs}ms`));
      }, parsed.timeoutMs);

      // ---- raw mode: direct GET, no transformation --------------------------
      if (parsed.mode === 'raw') {
        let res: Response;
        try {
          res = await fetchFn(parsed.url!, {
            method: 'GET',
            headers: { 'User-Agent': 'agent-afk/web_scrape', Accept: '*/*' },
            signal: ac.signal,
          });
        } catch (err) {
          if (ac.signal.aborted) return { content: `web_scrape aborted: ${abortMessage()}`, isError: true };
          return {
            content: `web_scrape network error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        if (!res.ok) {
          return {
            content:
              `web_scrape HTTP ${res.status} ${res.statusText || ''}`.trimEnd() + ` for ${parsed.url}`,
            isError: true,
          };
        }
        let body: string;
        try {
          body = await res.text();
        } catch (err) {
          return {
            content: `web_scrape read error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        return { content: truncateUtf8(body, parsed.maxBytes) };
      }

      // ---- markdown mode: fetch-first scrape + render escalation ------------
      if (parsed.mode === 'markdown') {
        try {
          const result = await scrapeToMarkdown(parsed.url!, {
            fetchFn,
            renderFn: opts.renderFn,
            timeoutMs: parsed.timeoutMs,
            signal: ac.signal,
          });
          if (result.markdown.trim().length === 0) {
            return {
              content: `web_scrape extracted no readable content from ${parsed.url}.`,
              isError: true,
            };
          }
          return { content: truncateUtf8(result.markdown, parsed.maxBytes) };
        } catch (err) {
          if (ac.signal.aborted) return { content: `web_scrape aborted: ${abortMessage()}`, isError: true };
          const base = err instanceof Error ? err.message : String(err);
          const hint = isPlaywrightMissing(err)
            ? ' (the render fallback needs the optional Playwright browser — run `pnpm exec playwright install chromium`)'
            : '';
          return { content: `web_scrape markdown error: ${base}${hint}`, isError: true };
        }
      }

      // ---- search mode: pluggable backend (Exa) -----------------------------
      const backend = resolveSearchBackend({
        exaApiKey: env['EXA_API_KEY'],
        fetchFn,
      });
      if ('error' in backend) {
        return { content: backend.error, isError: true };
      }
      try {
        const results = await backend.search(parsed.query!, {
          limit: DEFAULT_SEARCH_LIMIT,
          timeoutMs: parsed.timeoutMs,
          signal: ac.signal,
        });
        return { content: truncateUtf8(formatSearchResults(parsed.query!, results), parsed.maxBytes) };
      } catch (err) {
        if (ac.signal.aborted) return { content: `web_scrape aborted: ${abortMessage()}`, isError: true };
        return {
          content: `web_scrape search error (${backend.name}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    } finally {
      // Inverse-of-setup teardown order: timer first (it was set last),
      // then listener removal (it was added first).
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
    }
  };
}

export const webScrapeHandler: ToolHandler = createWebScrapeHandler();
