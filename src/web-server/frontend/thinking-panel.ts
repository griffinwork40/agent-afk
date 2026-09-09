/**
 * Collapsible thinking-block panel for the web transcript.
 *
 * Renders a {@link ThinkingItem} as a single-line summary ("◆ thought for Xs")
 * that toggles to reveal the full thinking text in a bordered, dimmed block.
 *
 * Invariant: NO innerHTML with model-derived text. Every value from `item.text`
 * is written through `textContent` only. Thinking content is attacker-influencable
 * in the same way tool output is — it must never be treated as markup.
 *
 * Contract: `renderThinkingBlock` is idempotent on the SAME container — calling
 * it twice with the same container replaces the first node. Wave 2-Beta wiring
 * should call it once per item and cache the resulting DOM node; it does NOT need
 * to re-call on subsequent SSE events (thinking items are append-only in the
 * view-model — their text never mutates after the first `done` event seals them).
 *
 * @module web-server/frontend/thinking-panel
 */

import type { ThinkingItem } from './view-model.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Estimate thinking duration from character count.
 *
 * Contract: `item.text` carries raw thinking content but NO recorded wall-clock
 * duration — the ledger stores only the text. A reading-time proxy (chars / 800,
 * floored at 1s) gives a plausible "thought for Xs" label. 800 chars/s was
 * calibrated against observed Sonnet extended-thinking outputs where ~2 000 chars
 * corresponds to ~2–3 real seconds of generation.
 */
function estimateDurationSecs(text: string): number {
  return Math.max(1, Math.round(text.length / 800));
}

/** Build the one-line collapsed summary text. */
function summaryLabel(item: ThinkingItem): string {
  const secs = estimateDurationSecs(item.text);
  return `◆ thought for ${secs}s`;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Render a thinking block into `container`, replacing any prior content.
 *
 * @param item      - The {@link ThinkingItem} to render.
 * @param container - Host element. Its existing children are cleared first.
 *
 * DOM structure produced:
 * ```
 * div.thinking-block
 *   div.thinking-summary          ← click target; always visible
 *   div.thinking-body             ← hidden when collapsed, visible when expanded
 *     pre.thinking-pre            ← verbatim text, monospace
 * ```
 *
 * Expand/collapse is toggled by adding/removing `.thinking-block--open` on the
 * root `div.thinking-block`. CSS drives the visibility; JS only flips the class.
 * This keeps the panel framework-free and avoids the `<details>/<summary>` pair,
 * which would fight with the incremental renderer's class-based change detection
 * (that renderer keys off `.className` to detect state transitions on tool nodes).
 */
export function renderThinkingBlock(item: ThinkingItem, container: HTMLElement): void {
  // Clear previous content (idempotent re-call safety).
  container.textContent = '';

  const block = el('div', 'thinking-block');
  block.setAttribute('data-thinking-id', item.id);

  // ── summary row (always visible) ──────────────────────────────────────────
  const summary = el('div', 'thinking-summary');
  const label = el('span', 'thinking-label', summaryLabel(item));
  const chevron = el('span', 'thinking-chevron', '›');
  summary.appendChild(chevron);
  summary.appendChild(label);

  // ── body (expanded only) ──────────────────────────────────────────────────
  const body = el('div', 'thinking-body');
  const pre = el('pre', 'thinking-pre', item.text);
  body.appendChild(pre);

  // ── toggle ────────────────────────────────────────────────────────────────
  // Contract: the handler closes over `block` only — it does NOT capture `item`
  // into a live closure that could pin memory after the item is superseded. The
  // toggle is purely structural (class flip) with no model interaction.
  summary.addEventListener('click', () => {
    block.classList.toggle('thinking-block--open');
  });

  // Keyboard: allow toggling via Enter/Space for accessibility.
  summary.setAttribute('role', 'button');
  summary.setAttribute('tabindex', '0');
  summary.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      block.classList.toggle('thinking-block--open');
    }
  });

  block.appendChild(summary);
  block.appendChild(body);
  container.appendChild(block);
}

/**
 * Convenience factory: creates a fresh host `div` and calls
 * {@link renderThinkingBlock} into it. Use when the caller does not already
 * manage a host element (e.g. direct integration with `renderItem` in render.ts).
 *
 * Contract: the returned element's first child is the `.thinking-block` node.
 * The wrapper `div.thinking-host` carries no visual styles — it exists only so
 * callers get a stable single-root return value they can hand to the DOM.
 */
export function createThinkingBlockNode(item: ThinkingItem): HTMLElement {
  const host = el('div', 'thinking-host');
  renderThinkingBlock(item, host);
  return host;
}
