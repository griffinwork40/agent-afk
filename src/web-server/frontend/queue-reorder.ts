/**
 * Pure, immutable list operations for the mid-run message queue in the
 * `afk web` frontend. No browser globals — every function returns a new
 * array and never mutates its input, and out-of-range indices are no-ops
 * (the input array is returned unchanged, not thrown from) so a stale index
 * from a race with a concurrent queue drain degrades gracefully.
 *
 * @module web-server/frontend/queue-reorder
 */

function isInBounds<T>(list: readonly T[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < list.length;
}

/**
 * Swap the item at `index` with its predecessor. No-op (returns an
 * array equal-by-value to `list`) when `index` is out of range or already
 * at the front.
 */
export function moveUp<T>(list: readonly T[], index: number): T[] {
  if (!isInBounds(list, index) || index === 0) return list.slice();
  const next = list.slice();
  const above = next[index - 1];
  const current = next[index];
  if (above === undefined || current === undefined) return list.slice();
  next[index - 1] = current;
  next[index] = above;
  return next;
}

/**
 * Swap the item at `index` with its successor. No-op when `index` is out
 * of range or already at the end.
 */
export function moveDown<T>(list: readonly T[], index: number): T[] {
  if (!isInBounds(list, index) || index === list.length - 1) return list.slice();
  const next = list.slice();
  const below = next[index + 1];
  const current = next[index];
  if (below === undefined || current === undefined) return list.slice();
  next[index + 1] = current;
  next[index] = below;
  return next;
}

/**
 * Return a new array with the item at `index` removed. No-op when `index`
 * is out of range.
 */
export function removeAt<T>(list: readonly T[], index: number): T[] {
  if (!isInBounds(list, index)) return list.slice();
  const next = list.slice();
  next.splice(index, 1);
  return next;
}

/**
 * Return a new array with the item at `index` replaced by `value`. No-op
 * when `index` is out of range.
 */
export function editAt<T>(list: readonly T[], index: number, value: T): T[] {
  if (!isInBounds(list, index)) return list.slice();
  const next = list.slice();
  next[index] = value;
  return next;
}

/**
 * Return a new array with `value` inserted before `index`. Clamps rather
 * than no-ops: `index <= 0` inserts at the front, `index >= list.length`
 * (including exactly `list.length`, the natural "append" position) inserts
 * at the end — an insert is never a no-op since there is always a valid
 * position to place a new item, unlike operations that target an existing
 * element.
 */
export function insert<T>(list: readonly T[], index: number, value: T): T[] {
  const next = list.slice();
  const clamped = Number.isInteger(index) ? Math.max(0, Math.min(index, next.length)) : next.length;
  next.splice(clamped, 0, value);
  return next;
}
