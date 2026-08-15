/**
 * Regular-expression utilities shared across the codebase.
 *
 * @module utils/regexp
 */

/**
 * Escape a string so it can be used as a literal match inside a `RegExp`.
 *
 * Replaces every character that has special meaning in a regex pattern
 * (`.*+?^${}()|[\]`) with its backslash-escaped equivalent, using the
 * industry-standard character class from MDN's "Escaping user input" guide.
 *
 * @example
 * const re = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
 */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
