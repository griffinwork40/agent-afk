/**
 * Recency ranking for slash-command completion candidates.
 *
 * Both completion surfaces — the autocomplete dropdown (`filterSlashCandidates`)
 * and the Tier-1 ghost resolver (`getDeterministicGhost`) — historically broke
 * prefix ties alphabetically. With ~100 registered commands and aliases that is
 * almost never the command the user wants: `/re` resolves to `/reauth` ahead of
 * `/refactor`, `/research`, `/resolve`, `/review`, and six others.
 *
 * This module ranks a tie-break bucket by how recently the user actually ran
 * each command, read from the REPL's own input history. Alphabetical order is
 * retained as the terminal tie-break, so behaviour is unchanged for a user with
 * no history and for commands never yet used.
 *
 * Pure and dependency-free: callers pass a history snapshot, so this is unit
 * testable with no REPL, no disk, and no session.
 *
 * @module cli/input/suggest-rank
 */

/**
 * Matches a `/command` token: a leading slash followed by an identifier.
 * Mirrors the character class used by the slash registry and the Tier-1
 * mid-sentence resolver (`[A-Za-z][A-Za-z0-9_:-]*`) so a name accepted by one
 * is recognised by the other. Global: one history entry may name several.
 */
const SLASH_TOKEN = /(?:^|\s)(\/[A-Za-z][A-Za-z0-9_:-]*)/g;

/** Rank assigned to a command that appears nowhere in history. */
export const UNRANKED = Number.POSITIVE_INFINITY;

/**
 * Build a `command name -> recency rank` index from a newest-first history
 * snapshot. Rank 0 is the most recently used command; lower sorts first.
 *
 * Contract: `history` MUST be newest-first (the order `ReplHistory.getEntries()`
 * returns). The first occurrence encountered therefore wins, and later — older —
 * mentions of the same command never downgrade it. Names are lowercased, since
 * the registry is lowercase and user input is not reliably so.
 */
export function buildRecencyRanks(history: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry) continue;
    // A fresh lastIndex per entry: SLASH_TOKEN is module-scoped and global, so
    // reusing it across entries without resetting would skip matches.
    SLASH_TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SLASH_TOKEN.exec(entry)) !== null) {
      const name = m[1]?.toLowerCase();
      if (name !== undefined && !ranks.has(name)) ranks.set(name, i);
    }
  }
  return ranks;
}

/**
 * Look up a candidate's recency rank. Accepts values with or without the
 * leading slash so both dropdown candidates (`/review`) and bare registry keys
 * (`review`) resolve against the same index.
 */
export function rankOf(value: string, ranks: ReadonlyMap<string, number>): number {
  const name = value.startsWith('/') ? value.toLowerCase() : `/${value.toLowerCase()}`;
  return ranks.get(name) ?? UNRANKED;
}

/**
 * Comparator: most-recently-used first, then alphabetical.
 *
 * Invariant: alphabetical order is the terminal tie-break, never skipped. Two
 * commands that are both unranked compare exactly as they did before recency
 * ranking existed — which is what keeps a no-history session, and every
 * existing ordering test, behaving identically.
 */
export function compareByRecency(
  a: string,
  b: string,
  ranks: ReadonlyMap<string, number>,
): number {
  const ra = rankOf(a, ranks);
  const rb = rankOf(b, ranks);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

/**
 * Sort a list of slash-command names by recency, then alphabetically.
 * Returns a new array; the input is not mutated.
 */
export function sortByRecency(
  names: readonly string[],
  history: readonly string[],
): string[] {
  const ranks = buildRecencyRanks(history);
  return names.slice().sort((a, b) => compareByRecency(a, b, ranks));
}
