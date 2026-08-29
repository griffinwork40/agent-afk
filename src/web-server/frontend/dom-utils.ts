/**
 * Shared DOM query helpers.
 *
 * Two variants with distinct null-safety contracts:
 *
 *  • `$(id)` — null-safe: returns `HTMLElement | null`.  Use wherever the
 *    element may legitimately be absent (e.g. optional chrome, feature-flagged
 *    regions).  Mirrors `document.getElementById`.
 *
 *  • `$required(id)` — asserting: returns `HTMLElement` and throws a
 *    `ReferenceError` if the element is missing.  Use when the markup is
 *    required by the page contract and its absence is a hard bug.
 */

/**
 * Null-safe element lookup.
 *
 * @param id - The HTML element `id` to look up.
 * @returns The matching element, or `null` if absent.
 */
export function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * Asserting element lookup.  Throws a `ReferenceError` when the element
 * is missing, making the invariant violation explicit at the call site.
 *
 * @param id - The HTML element `id` to look up.
 * @returns The matching element.
 * @throws {ReferenceError} If no element with the given `id` exists.
 */
export function $required(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new ReferenceError(`missing required element #${id}`);
  return node;
}
