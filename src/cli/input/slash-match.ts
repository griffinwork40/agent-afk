/**
 * Slash-command candidate matching — the ranking core, shared by every surface.
 *
 * Invariant: this module must stay BROWSER-SAFE. It is bundled into the `afk
 * web` frontend by esbuild (`scripts/build-web-ui.mjs`, `platform: 'browser'`),
 * so it may not import node builtins, the slash registry, or anything reaching
 * them transitively. Its only import is `./suggest-rank.js`, which is itself
 * dependency-free. `./trigger.ts` — the terminal-side caller — imports `fs` and
 * therefore cannot be shared; that is precisely why the ranking lives here
 * instead of there.
 *
 * The caller supplies the command universe rather than this module reading it,
 * which is what makes one implementation serve both surfaces: the REPL builds
 * the universe from the in-process registry, and the browser builds it from the
 * `GET /api/commands` payload. Ranking is therefore identical on both, by
 * construction rather than by convention.
 */

import { buildRecencyRanks, compareByRecency } from './suggest-rank.js';

/** Max rows returned. Mirrors the dropdown viewport the REPL renders. */
export const MAX_SLASH_MATCHES = 20;

/**
 * Contract: one entry in the searchable command universe. A structural subset
 * of `SlashCommand` (cli/slash/types.ts) carrying only the fields matching and
 * rendering consult — declared here so this module needs no import from the
 * slash layer, and so the HTTP payload can satisfy it directly.
 *
 * `name` carries its leading slash (`/mint`), matching `SlashCommand.name`.
 */
export interface CommandEntry {
  name: string;
  summary?: string;
  hint?: string;
}

/**
 * Contract: a matched row. Mirrors `Candidate` in `./types.ts`, redeclared here
 * to keep this module free of an import from a file that pulls in readline
 * types. The shapes are structurally identical, so terminal callers can pass
 * these straight through.
 */
export interface SlashCandidate {
  value: string;
  summary?: string;
  hint?: string;
}

/**
 * True when every character of `needle` appears in `haystack` in order (not
 * necessarily contiguous). Used for the subsequence fallback so an abbreviation
 * like `cfg` matches `config`. Both inputs are expected pre-lowercased.
 */
export function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/**
 * Rank a command universe against a typed query.
 *
 * Ranking: prefix matches first (preserving the historical `startsWith`
 * behaviour), then subsequence matches — e.g. `cfg` → `/config` — appended
 * below, so abbreviations resolve without displacing the common prefix case.
 * Matching is case-insensitive against the name WITHOUT its leading slash.
 * Capped at {@link MAX_SLASH_MATCHES}.
 *
 * Within each bucket, candidates are ordered by how recently the user ran them
 * (`recentHistory`, newest-first), falling back to alphabetical. Omitting
 * `recentHistory` — or passing an empty array — yields plain alphabetical
 * ordering, which is the browser's case (it has no REPL history to draw on).
 *
 * De-duplication is by `value`: a name appearing in both buckets keeps only its
 * prefix-bucket placement, so an entry can never be listed twice.
 */
export function matchSlashCandidates(
  universe: readonly CommandEntry[],
  query: string,
  recentHistory: readonly string[] = [],
): SlashCandidate[] {
  const q = query.toLowerCase();

  const keyed = universe.map((entry) => ({
    key: entry.name.replace(/^\//, '').toLowerCase(),
    cand: {
      value: entry.name,
      ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
      ...(entry.hint !== undefined ? { hint: entry.hint } : {}),
    } satisfies SlashCandidate,
  }));

  const prefix = keyed.filter((u) => u.key.startsWith(q));
  const prefixValues = new Set(prefix.map((u) => u.cand.value));
  const subseq =
    q.length === 0
      ? []
      : keyed.filter((u) => !prefixValues.has(u.cand.value) && isSubsequence(q, u.key));

  const ranks = buildRecencyRanks(recentHistory);
  const byValue = (a: { cand: SlashCandidate }, b: { cand: SlashCandidate }): number =>
    compareByRecency(a.cand.value, b.cand.value, ranks);
  prefix.sort(byValue);
  subseq.sort(byValue);
  return [...prefix, ...subseq].map((u) => u.cand).slice(0, MAX_SLASH_MATCHES);
}
