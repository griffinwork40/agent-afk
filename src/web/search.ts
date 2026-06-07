/**
 * Web-search backends for `web_scrape` search mode.
 *
 * v1 ships exactly one backend — Brave Search — behind a `SearchBackend`
 * interface so DuckDuckGo / SearXNG / Tavily / SerpAPI can be added later
 * without touching the handler. The handler calls `resolveSearchBackend()`
 * to pick a backend from available credentials; when none is configured it
 * receives a clear, actionable error instead of a failed request.
 *
 * Deliberate non-goal for v1: search-engine scraping (DuckDuckGo HTML, etc.).
 * It is brittle and bot-blocked; we require a real search API key instead.
 *
 * @module web/search
 */

import type { FetchFn, SearchBackend, SearchResult } from './types.js';
import { sanitizeForDisplay } from '../utils/terminal-sanitize.js';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
/** Brave caps `count` at 20 per request. */
const BRAVE_MAX_COUNT = 20;

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

/** Strip Brave's `<strong>`-highlighted snippet markup and collapse spaces. */
function stripMarkup(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BraveBackendOptions {
  apiKey: string;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: FetchFn;
}

/**
 * Construct a Brave Search backend bound to an API key.
 *
 * Brave's REST API returns JSON directly (no browser needed), making search
 * robust and deterministic — the opposite of scraping a search-results page.
 */
export function createBraveSearchBackend(opts: BraveBackendOptions): SearchBackend {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  return {
    name: 'brave',
    async search(query, { limit, signal }): Promise<SearchResult[]> {
      const url = new URL(BRAVE_ENDPOINT);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(Math.min(Math.max(limit, 1), BRAVE_MAX_COUNT)));

      const res = await fetchFn(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': opts.apiKey,
          'User-Agent': 'agent-afk/web_scrape',
        },
        signal,
      });

      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.text();
          const clean = sanitizeForDisplay(body);
          if (clean) detail = `: ${clean.length > 200 ? clean.slice(0, 200) + '…' : clean}`;
        } catch {
          // Ignore — proceed with status only.
        }
        const statusText = res.statusText ? ` ${res.statusText}` : '';
        throw new Error(`Brave Search HTTP ${res.status}${statusText}${detail}`);
      }

      let json: BraveResponse;
      try {
        json = (await res.json()) as BraveResponse;
      } catch (err) {
        throw new Error(
          `Brave Search response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const results = json.web?.results ?? [];
      return results
        .slice(0, limit)
        .map((r) => ({
          title: stripMarkup(r.title ?? '') || '(untitled)',
          url: r.url ?? '',
          description: stripMarkup(r.description ?? ''),
        }))
        .filter((r) => r.url.length > 0);
    },
  };
}

export interface ResolveSearchOptions {
  /** Brave API key (from BRAVE_SEARCH_API_KEY), if present. */
  braveApiKey?: string | undefined;
  /** Override for tests. */
  fetchFn?: FetchFn;
}

/**
 * Pick a search backend from available credentials.
 *
 * Resolution order (extend here as backends are added):
 *   1. Brave — when `braveApiKey` is set.
 *   …  (future: SearXNG instance URL, Tavily key, …)
 *
 * Returns `{ error }` with an actionable message when nothing is configured,
 * so the handler surfaces a `ToolResult { isError: true }` rather than making
 * a doomed request.
 */
export function resolveSearchBackend(opts: ResolveSearchOptions): SearchBackend | { error: string } {
  if (opts.braveApiKey !== undefined && opts.braveApiKey.trim() !== '') {
    return createBraveSearchBackend({ apiKey: opts.braveApiKey, fetchFn: opts.fetchFn });
  }
  return {
    error:
      'web_scrape search mode requires a search backend. Set BRAVE_SEARCH_API_KEY ' +
      '(free tier at https://brave.com/search/api/) to enable it. ' +
      'Use mode: "markdown" to read a known URL, or mode: "raw" for a direct fetch.',
  };
}

/** Render search results as markdown for the model. Pure; unit-tested. */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `# Search results for "${query}"\n\n(no results)`;
  }
  const lines: string[] = [`# Search results for "${query}"`, ''];
  results.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.title}`);
    if (r.url) lines.push(r.url);
    if (r.description) lines.push(r.description);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}
