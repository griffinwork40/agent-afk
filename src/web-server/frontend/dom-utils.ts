/**
 * DOM element lookup helpers shared across the web frontend.
 *
 * Two contracts — choose based on caller semantics:
 *   - $required: element is a structural invariant; absence is a programmer error.
 *   - $optional: graceful-degradation; absent element means no-op.
 */

/**
 * Look up a required element by id. Throws if absent.
 * Use when the element is declared in index.html and must exist before main() runs.
 */
export function $required(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

/**
 * Look up an optional element by id. Returns null if absent.
 * Use for progressive-enhancement / graceful-degradation.
 */
export function $optional(id: string): HTMLElement | null {
  return document.getElementById(id);
}
