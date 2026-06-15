/**
 * Web-search backends for `web_scrape` search mode.
 *
 * Ships one backend — Exa (exa.ai) — behind a `SearchBackend` interface so
 * other engines (Brave / Tavily / SearXNG / SerpAPI) can be added later
 * without touching the handler. The handler calls `resolveSearchBackend()`
 * to pick a backend from available credentials; when none is configured it
 * receives a clear, actionable error instead of a failed request.
 *
 * Deliberate non-goal: search-engine scraping (DuckDuckGo HTML, etc.). It is
 * brittle and bot-blocked; we require a real search API key instead.
 *
 * @module web/search
 */

import type { FetchFn, SearchBackend, SearchResult } from './types.js';
import { sanitizeForDisplay } from '../utils/terminal-sanitize.js';

const EXA_ENDPOINT = 'https://api.exa.ai/search';
/** Exa's free/basic plans cap `numResults` at 10. */
const EXA_MAX_RESULTS = 10;

/** One result from Exa's `/search` response. `contents` fields are optional. */
interface ExaSearchResult {
  title?: string | null;
  url?: string;
  /** Present when `contents.highlights` is requested — query-relevant snippets. */
  highlights?: string[];
}

interface ExaResponse {
  results?: ExaSearchResult[];
}

export interface ExaBackendOptions {
  apiKey: string;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: FetchFn;
}

/**
 * Construct an Exa Search backend bound to an API key.
 *
 * Exa's REST API returns JSON directly (no browser needed), making search
 * robust and deterministic — the opposite of scraping a search-results page.
 * We request `contents.highlights` so each result carries a query-relevant
 * snippet for the `description` field; Exa highlights are plain text, so no
 * markup stripping is needed.
 */
export function createExaSearchBackend(opts: ExaBackendOptions): SearchBackend {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  return {
    name: 'exa',
    async search(query, { limit, signal }): Promise<SearchResult[]> {
      const res = await fetchFn(EXA_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': opts.apiKey,
          'User-Agent': 'agent-afk/web_scrape',
        },
        body: JSON.stringify({
          query,
          type: 'auto',
          numResults: Math.min(Math.max(limit, 1), EXA_MAX_RESULTS),
          contents: { highlights: { numSentences: 3, highlightsPerUrl: 1 } },
        }),
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
        throw new Error(`Exa Search HTTP ${res.status}${statusText}${detail}`);
      }

      let json: ExaResponse;
      try {
        json = (await res.json()) as ExaResponse;
      } catch (err) {
        throw new Error(
          `Exa Search response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const results = json.results ?? [];
      return results
        .slice(0, limit)
        .map((r) => ({
          title: (r.title ?? '').trim() || '(untitled)',
          url: r.url ?? '',
          description: (r.highlights?.[0] ?? '').trim(),
        }))
        .filter((r) => r.url.length > 0);
    },
  };
}

export interface ResolveSearchOptions {
  /** Exa API key (from EXA_API_KEY), if present. */
  exaApiKey?: string | undefined;
  /** Override for tests. */
  fetchFn?: FetchFn;
}

/**
 * Pick a search backend from available credentials.
 *
 * Resolution order (extend here as backends are added):
 *   1. Exa — when `exaApiKey` is set.
 *   …  (future: Brave key, SearXNG instance URL, Tavily key, …)
 *
 * Returns `{ error }` with an actionable message when nothing is configured,
 * so the handler surfaces a `ToolResult { isError: true }` rather than making
 * a doomed request.
 */
export function resolveSearchBackend(opts: ResolveSearchOptions): SearchBackend | { error: string } {
  if (opts.exaApiKey !== undefined && opts.exaApiKey.trim() !== '') {
    return createExaSearchBackend({ apiKey: opts.exaApiKey, fetchFn: opts.fetchFn });
  }
  return {
    error:
      'web_scrape search mode requires a search backend. Set EXA_API_KEY ' +
      '(free tier at https://exa.ai) to enable it. ' +
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
