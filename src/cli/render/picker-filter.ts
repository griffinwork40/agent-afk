/**
 * Fuzzy-filter scorer for the `runPicker` search overlay.
 *
 * Imported by `picker.ts` only when `opts.searchable` is true. Extracted to
 * its own file to keep `picker.ts` under the 350 non-blank/non-comment LOC
 * ceiling imposed by the project style guide.
 *
 * Scoring tiers:
 *   100 — exact case-insensitive substring match
 *    50 + density bonus — all query chars appear in order as a subsequence
 *   excluded — no match
 *
 * ANSI escape sequences are stripped before scoring so options that contain
 * palette colours (e.g. `palette.dim(id)` appended by `uniquePickLabels`)
 * are matched against their visible text, not the raw escape bytes.
 */

import { stripAnsi } from '../display.js';

export interface FilterResult {
  /** Index into the original `options` array. */
  originalIndex: number;
  /** Match score (higher = better). */
  score: number;
}

/**
 * Score `text` against `query`.  Returns `undefined` when there is no match.
 *
 * The visible text is derived by stripping ANSI sequences first; the original
 * string is never mutated.
 */
function score(rawText: string, query: string): number | undefined {
  if (query.length === 0) return 100; // empty query matches everything
  const text = stripAnsi(rawText).toLowerCase();
  const q = query.toLowerCase();

  // Tier 1: exact substring
  if (text.includes(q)) return 100;

  // Tier 2: subsequence — all query chars appear in order
  let qi = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (text[ti] === q[qi]) {
      if (firstMatch === -1) firstMatch = ti;
      lastMatch = ti;
      qi++;
    }
  }
  if (qi < q.length) return undefined; // not a subsequence

  // Density bonus: tighter matches score higher (fewer gaps → higher density)
  const span = lastMatch - firstMatch + 1;
  const density = q.length / span; // 0 < density ≤ 1
  return 50 + Math.round(density * 49); // 50..99
}

/**
 * Filter `options` by `query` and return matches sorted by descending score,
 * each carrying the `originalIndex` back into the full options array.
 *
 * When `query` is empty, all options pass through in original order.
 */
export function filterOptions(options: readonly string[], query: string): FilterResult[] {
  const results: FilterResult[] = [];
  for (let i = 0; i < options.length; i++) {
    const s = score(options[i] ?? '', query);
    if (s !== undefined) results.push({ originalIndex: i, score: s });
  }
  if (query.length === 0) return results; // preserve original order
  return results.sort((a, b) => b.score - a.score);
}
