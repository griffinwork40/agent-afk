/**
 * Tier 1 of the ghost-text engine: the deterministic, synchronous suggestion
 * source. Pure — no provider, no timers, no state — so it is safe to call on
 * the keystroke hot path and testable without any infrastructure.
 *
 * Split out of `./suggest`, which now composes the tiers rather than
 * implementing them. Mirrors the sibling split of the LLM tier
 * (`./suggest-tier2`) and the empty-prompt proposal (`./suggest-prompt`).
 *
 * @module cli/input/suggest-tier1
 */

import { list as listSlashCommands, aliasEntries } from '../slash/registry.js';
import { sortByRecency } from './suggest-rank.js';
import type { SuggestContext } from './suggest.js';

/**
 * Tier 1 deterministic ghost resolver.
 *
 * Sources in priority order:
 *   (a) the top dropdown candidate exposed by `ctx.getDropdownTopCandidate`
 *   (b) the most-recent history entry that starts with `buffer`
 *   (c) mid-sentence skill name prefix-match against the slash registry —
 *       fires only when a `/partial` token is preceded by whitespace (i.e.,
 *       it is NOT the first token in the buffer).
 *
 * Returns the FULL candidate string or null when no source matches.
 */
export function getDeterministicGhost(buffer: string, ctx: SuggestContext): string | null {
  if (buffer.length === 0) return null;

  // (a) Dropdown top candidate
  const dropdownCandidate = ctx.getDropdownTopCandidate(buffer);
  if (
    dropdownCandidate !== null &&
    dropdownCandidate.startsWith(buffer) &&
    dropdownCandidate.length > buffer.length
  ) {
    return dropdownCandidate;
  }

  // (b) History prefix-match (newest first)
  const history = ctx.getHistory();
  for (const entry of history) {
    if (entry.startsWith(buffer) && entry.length > buffer.length) {
      return entry;
    }
  }

  // (c) Mid-sentence skill name prefix-match
  // Fires only when the /partial token is preceded by at least one whitespace
  // character — i.e., NOT the first token in the buffer. The \s+ guard is the
  // sole first-token filter: "/fo" does not match; "run /fo" does.
  const midSentenceMatch = /\s+\/([A-Za-z][A-Za-z0-9_:-]*)$/.exec(buffer);
  if (midSentenceMatch) {
    const partial = midSentenceMatch[1]!; // e.g. "fo" from "can you run /fo"
    const slashPartial = '/' + partial;   // e.g. "/fo"
    const canonicalNames = listSlashCommands().map(cmd => cmd.name);
    const aliasNames = aliasEntries().map(e => e.alias);
    const allNames = [...canonicalNames, ...aliasNames];
    // Recency-ranked, alphabetical as terminal tie-break. With ~100 names a
    // 2-char prefix is ambiguous for most commands, so alphabetical alone
    // rarely surfaces the one the user means.
    const match = sortByRecency(
      allNames.filter(name => name.startsWith(slashPartial)),
      ctx.getHistory(),
    )[0];
    if (match) {
      // Return the full buffer with the partial /token replaced by the full skill name.
      const prefixEnd = buffer.length - slashPartial.length;
      return buffer.slice(0, prefixEnd) + match;
    }
  }

  return null;
}
