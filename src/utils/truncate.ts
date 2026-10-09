/**
 * Code-point-safe string truncation helper.
 *
 * Moved from `src/cli/commands/trace-format.ts` (where it was collocated with
 * trace-rendering helpers) so that non-CLI modules can import it without
 * pulling in the CLI layer.
 *
 * `trace-format.ts` still re-exports this function for backwards-compatibility
 * with its existing importers.
 *
 * @module utils/truncate
 */

/**
 * Truncate `s` to at most `n` Unicode code points (not UTF-16 units), appending
 * `…` at the cut so an emoji straddling the boundary is never split into a lone
 * surrogate.  ASCII input is unaffected: `s.length` and code-point count agree
 * for ASCII, so existing callers see identical output for ASCII strings.
 *
 * @param s - Input string.
 * @param n - Maximum number of Unicode code points in the result (including the
 *   trailing `…` when the string is truncated).
 */
export function truncate(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length > n ? `${cps.slice(0, n - 1).join('')}…` : s;
}
