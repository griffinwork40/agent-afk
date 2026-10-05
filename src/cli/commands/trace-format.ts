/**
 * Pure formatting helpers for `afk trace show`.
 *
 * Extracted from `trace.ts` (past the 350-line ceiling) so the renderer and
 * the `--results` journal decorator (trace-results.ts) share one set of
 * duration / byte / time / truncation formatters.
 *
 * @module cli/commands/trace-format
 */

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** UTC HH:MM:SS slice of an ISO-8601 timestamp; deterministic across
 *  timezones (good for stable output and tests). */
export function fmtTime(ts: string): string {
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

/**
 * Truncate `s` to at most `n` Unicode code points (not UTF-16 units), appending
 * `…` at the cut so an emoji straddling the boundary is never split into a lone
 * surrogate. ASCII input is unaffected: `s.length` and code-point count agree
 * for ASCII, so existing callers see identical output for ASCII strings.
 */
export function truncate(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length > n ? `${cps.slice(0, n - 1).join('')}…` : s;
}

/** Fixed label column so event lines align. */
export function label(s: string): string {
  const WIDTH = 9;
  return s.length >= WIDTH ? s : s + ' '.repeat(WIDTH - s.length);
}
