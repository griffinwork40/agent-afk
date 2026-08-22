/**
 * Incremental DOM diffing helpers for `renderTranscript`.
 *
 * Extracted here to keep render.ts under its 350-LOC ceiling.
 * Private to the frontend package — not part of the public API.
 *
 * Steady-state cost is O(new items) instead of O(N) — the common case of one
 * arriving SSE event appends a single node and leaves all prior nodes untouched.
 *
 * Full rebuild is triggered only when `items.length` is less than the current
 * child count, which signals a session switch or reset. In that case the cache
 * is cleared and all nodes are recreated from scratch.
 */

import type { TranscriptItem } from './view-model.js';

/**
 * Module-level cache: maps item.id → the DOM node that represents it.
 *
 * Keyed by a stable `item.id` that is assigned once at model creation time and
 * never reassigned. The cache is cleared on a full rebuild (session switch /
 * reset), so stale entries from a previous session never collide with a new one.
 */
const nodeCache = new Map<string, HTMLElement>();

/**
 * True when `item` should replace its existing DOM node rather than be skipped.
 *
 * Only tool items can change state after initial render (running → ok/error,
 * or output arriving after the tool_use_detail). All other kinds are
 * append-only once emitted.
 */
function itemChanged(item: TranscriptItem, existing: HTMLElement): boolean {
  if (item.kind !== 'tool') return false;
  // The node's class encodes the current status; compare it to the item's.
  return existing.className !== `tool tool-${item.status}`;
}

/**
 * Apply an incremental update to the transcript container.
 *
 * @param container - The scroll container holding transcript nodes.
 * @param items     - Current ordered item list from the view-model.
 * @param renderItem - Factory that converts a TranscriptItem to an HTMLElement.
 *
 * Scroll-pinning contract (preserved from the original full-rebuild behaviour):
 *   - The CALLER samples `isPinnedToBottom` BEFORE this call — scroll position
 *     is stable across incremental appends, unlike a full wipe.
 *   - The CALLER calls `scrollToBottom` after this call when it was pinned.
 */
export function applyIncrementalUpdate(
  container: HTMLElement,
  items: TranscriptItem[],
  renderItem: (item: TranscriptItem) => HTMLElement,
): void {
  // Full rebuild: session switch / reset detected by shrinking item count.
  if (items.length < container.childElementCount) {
    nodeCache.clear();
    container.textContent = '';
  }

  for (const item of items) {
    const existing = nodeCache.get(item.id);
    if (existing === undefined) {
      // New item — create and append.
      const node = renderItem(item);
      nodeCache.set(item.id, node);
      container.appendChild(node);
    } else if (itemChanged(item, existing)) {
      // Existing item whose state changed (e.g. tool running → ok/error).
      const node = renderItem(item);
      nodeCache.set(item.id, node);
      container.replaceChild(node, existing);
    }
    // Otherwise: item is unchanged — skip, O(1).
  }
}
