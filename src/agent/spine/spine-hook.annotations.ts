/**
 * Trailing-annotation stripping for SPINE.md entry descriptions (#2484).
 *
 * The teardown hook appends ` (reinforced YYYY-MM-DD)` / ` (partially weakened
 * YYYY-MM-DD)` to a description. Historical 120-char truncation left arbitrary
 * prefixes of those annotations on disk (` (reinf`, ` (partially weakened
 * 2026-09-2`). Before re-appending, the hook must strip ANY such prefix, or the
 * fragment survives and the next annotation stacks on top of it.
 */

/** Label of the reinforcement annotation (without the leading ` (`). */
export const REINFORCED_LABEL = 'reinforced';
/** Label of the partial-weakening annotation (without the leading ` (`). */
export const WEAKENED_LABEL = 'partially weakened';

/**
 * Invariant: the fragment must contain ` (` plus at least this many label
 * characters before it is treated as a truncated annotation. Two characters
 * (` (re`, ` (pa`) matches the prior behaviour and keeps legitimate trailing
 * parentheticals like ` (r` or ` (p` intact.
 *
 * The 2-char threshold is intentional: it is the shortest prefix that both
 * labels share exclusively with each other (`re` / `pa`). A 1-char prefix
 * would be ambiguous; keeping it at 2 means a real description ending in
 * exactly ` (r` or ` (p` is preserved, while ` (re` or ` (pa` is stripped.
 */
const MIN_LABEL_CHARS = 2;

/**
 * Matches the text that may follow the full label: a space then a prefix of
 * `YYYY-MM-DD)`. The year group requires at least one digit (`\d{1,4}`) so
 * that a description truncated at exactly `label + " "` (space present, no
 * date at all) does NOT match this template and therefore passes through the
 * `rest.startsWith(' ')` guard without being mis-stripped.
 */
const DATE_TEMPLATE = /^\d{1,4}(?:-\d{0,2}(?:-\d{0,2}\)?)?)?$/;

/**
 * Strip a complete or truncated ` (<label> YYYY-MM-DD)` annotation from the end
 * of `description`. Returns `description` unchanged when its tail is not a
 * prefix of that annotation.
 *
 * Contract: matching is character-exact against `label`, so every truncation
 * point is recognised, not just word or chunk boundaries.
 */
export function stripTrailingAnnotation(
  description: string,
  label: typeof REINFORCED_LABEL | typeof WEAKENED_LABEL,
): string {
  const open = description.lastIndexOf(' (');
  if (open === -1) return description;
  const tail = description.slice(open + 2); // text after " ("
  if (isAnnotationPrefix(tail, label)) return description.slice(0, open);
  return description;
}

function isAnnotationPrefix(tail: string, label: typeof REINFORCED_LABEL | typeof WEAKENED_LABEL): boolean {
  if (tail.length <= label.length) {
    return tail.length >= MIN_LABEL_CHARS && label.startsWith(tail);
  }
  if (!tail.startsWith(label)) return false;
  const rest = tail.slice(label.length);
  // After the full label: nothing more than " " + a prefix of "YYYY-MM-DD)".
  if (!rest.startsWith(' ')) return false;
  return DATE_TEMPLATE.test(rest.slice(1));
}
