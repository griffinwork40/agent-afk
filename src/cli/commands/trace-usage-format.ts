/**
 * Cache-usage formatting for `afk trace show`.
 *
 * Lives in its own file because `trace.ts` is already far past the repo's
 * 350-line ceiling; this is one whole concern (how prompt-cache token counts
 * are rendered) rather than another branch inside the event renderer.
 *
 * @module cli/commands/trace-usage-format
 */

/** The `finalTokens` object carried on a `closure` trace event. */
export interface FinalTokens {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheCreation?: number | undefined;
}

/**
 * Contract: render the prompt-cache slice of a closure's token counts as a
 * compact suffix, or `''` when the session recorded no cache activity (so
 * uncached and pre-cache-era traces render exactly as before).
 *
 * History: the closure renderer printed reason/turns/cost/stop-reason and
 * silently dropped `cacheRead`/`cacheCreation`, even though the trace schema
 * has carried both since the field was added. Combined with `/cost` and the
 * turn footer also omitting them, prompt-cache effectiveness was invisible on
 * every surface an operator actually reads — a cache that degraded to a 100%
 * miss rate would show up only on the monthly bill. Emitting the hit rate here
 * makes the regression observable in the one artifact that is durable per
 * session.
 *
 * The hit rate is `cacheRead / (cacheRead + cacheCreation)` — the share of
 * cacheable tokens served from an existing entry rather than freshly written.
 * A healthy warm session trends high; a prefix that keeps getting invalidated
 * shows sustained low values because every call re-writes what it should have
 * read.
 */
export function formatCacheUsage(tokens: FinalTokens | undefined): string {
  if (!tokens) return '';
  const read = tokens.cacheRead ?? 0;
  const created = tokens.cacheCreation ?? 0;
  const cacheable = read + created;
  if (cacheable === 0) return '';

  const parts = [`cache r=${fmtTokens(read)}`, `w=${fmtTokens(created)}`];
  parts.push(`hit=${Math.round((read / cacheable) * 100)}%`);
  return `  ${parts.join(' ')}`;
}

/** Compact token count: 1234 → `1.2k`, 1234567 → `1.2m`. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}
