/**
 * Public surface of the `src/web/` content-fetching layer.
 *
 * Consumed by the `web_scrape` tool handler. Backends are pluggable behind
 * the `SearchBackend` interface and the injected `FetchFn` / `RenderFn` seams.
 *
 * @module web
 */

export { extractReadableMarkdown, THIN_CONTENT_CHARS } from './extract.js';
export { scrapeToMarkdown } from './scrape.js';
export type { ScrapeOptions, ScrapeResult } from './scrape.js';
export {
  createExaSearchBackend,
  resolveSearchBackend,
  formatSearchResults,
} from './search.js';
export type { ExaBackendOptions, ResolveSearchOptions } from './search.js';
export type {
  ExtractedContent,
  FetchFn,
  RenderFn,
  RenderedPage,
  SearchBackend,
  SearchResult,
} from './types.js';
