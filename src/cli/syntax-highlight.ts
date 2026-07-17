/**
 * ANSI syntax highlighting for fenced code blocks in the TUI.
 *
 * Wraps emphasize (a chalk-styled wrapper over highlight.js/lowlight)
 * with:
 *   - chalk.level === 0 short-circuit (NO_COLOR / non-TTY / CI)
 *   - long-input bypass (>2048 chars) to keep render latency bounded
 *   - try/catch graceful fallback for unknown languages or parse errors
 *   - small LRU(32) cache for short snippets so re-renders are free
 *
 * Only the existing semantic palette is referenced (via syntax-theme).
 */

import chalk from 'chalk';
import { createEmphasize, common } from 'emphasize';
import { buildSyntaxTheme } from './syntax-theme.js';

const emphasize = createEmphasize(common);

const MAX_HIGHLIGHT_LEN = 2048;
const MAX_CACHE_LEN = 512;
const MAX_CACHE_ENTRIES = 32;

const cache = new Map<string, string>();

/**
 * Drop all memoized styled output. Called by `applyTheme()` (./theme.ts) on
 * a theme swap so already-highlighted snippets are re-highlighted with the
 * new palette instead of served from the cache in the previous theme's tones.
 */
export function clearHighlightCache(): void {
  cache.clear();
}

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  // Move-to-end for LRU recency.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: string): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * Highlight `text` as `lang`, returning the ANSI-styled output. On any
 * failure (unknown language, internal error) returns `text` unchanged.
 */
export function highlightCode(text: string, lang: string): string {
  if (chalk.level === 0) return text;
  if (text.length > MAX_HIGHLIGHT_LEN) return text;

  const cacheable = text.length < MAX_CACHE_LEN;
  const key = cacheable ? `${lang} ${text}` : '';
  if (cacheable) {
    const hit = cacheGet(key);
    if (hit !== undefined) return hit;
  }

  let out: string;
  try {
    if (!lang || !emphasize.registered(lang)) {
      out = text;
    } else {
      const result = emphasize.highlight(lang, text, buildSyntaxTheme());
      out = typeof result?.value === 'string' ? result.value : text;
    }
  } catch {
    out = text;
  }

  if (cacheable) cacheSet(key, out);
  return out;
}
