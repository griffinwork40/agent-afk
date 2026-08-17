/**
 * Incremental reverse-history-search modal for readWithAutocompleteTty.
 *
 * Triggered by Ctrl-R; exits on Enter (accept), Esc/Ctrl-G (cancel), or
 * Ctrl-C (abort). While active the status line shows:
 *   `(reverse-i-search)\`<query>\`: <match>`
 * Repeated Ctrl-R cycles to the next older matching entry.
 *
 * Integration contract:
 *   - Enter / exit via `enterReverseSearch` / `exitReverseSearch`.
 *   - `handleReverseSearchKey` processes each keypress; returns `true` if it
 *     consumed the key, `false` to fall through to the normal handler.
 *   - State is stored on `ReverseSearchState`; attach it to `ReaderState`
 *     (see reader.state.ts extension note) or carry it as a parallel bag.
 *
 * Invariant: no closure over `let` bindings from readWithAutocompleteTty.
 * All mutable state is threaded through `ReverseSearchState`; all immutable
 * dependencies come through the explicit parameters.
 */

import { InputCore } from '../input-core.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx, repaint as _repaint } from './reader.repaint.js';
import type { KeyInfo } from './types.js';

/** Mutable state for the reverse-search modal, parallel to ReaderState. */
export interface ReverseSearchState {
  /** Whether the modal is currently active. */
  active: boolean;
  /** Current search query (what the user has typed since Ctrl-R). */
  query: string;
  /**
   * Index into the history entries array at which the current match was found
   * (entries are newest-first from `getEntries()`). -1 means no match yet.
   */
  matchIndex: number;
  /** Buffer content saved when Ctrl-R was pressed, restored on cancel. */
  savedBuffer: string;
}

/** Create a fresh, inactive ReverseSearchState. */
export function createReverseSearchState(): ReverseSearchState {
  return { active: false, query: '', matchIndex: -1, savedBuffer: '' };
}

/**
 * Activate reverse-search mode. Saves the current buffer and resets
 * the search query + match pointer.
 */
export function enterReverseSearch(rs: ReverseSearchState, st: ReaderState): void {
  rs.active = true;
  rs.query = '';
  rs.matchIndex = -1;
  rs.savedBuffer = st.input.buffer;
}

/**
 * Deactivate reverse-search mode without applying the match (cancel).
 * Restores the buffer to what it was when Ctrl-R was pressed.
 */
export function cancelReverseSearch(rs: ReverseSearchState, st: ReaderState): void {
  rs.active = false;
  st.input = InputCore.seed(rs.savedBuffer);
}

/**
 * Deactivate reverse-search mode and keep whatever is in the buffer (accept).
 * The `_st` parameter is kept for signature symmetry with `cancelReverseSearch`
 * (both functions are called from the same dispatch sites).
 */
export function acceptReverseSearch(rs: ReverseSearchState, _st: ReaderState): void {
  rs.active = false;
  // Buffer is already set by the last applyMatch call. Keep it as-is.
}

/**
 * Find the next older match for `query` in `entries`, starting AFTER
 * `startAfter` (exclusive). Pass -1 to start from the newest entry.
 *
 * Returns the index into `entries` of the match, or -1 if none found.
 */
export function findNextMatch(
  query: string,
  entries: readonly string[],
  startAfter: number,
): number {
  if (entries.length === 0 || query.length === 0) return -1;
  const lo = query.toLowerCase();
  for (let i = startAfter + 1; i < entries.length; i++) {
    if (entries[i]!.toLowerCase().includes(lo)) return i;
  }
  return -1;
}

/**
 * Apply a matched history entry to the buffer (cursor at end).
 */
function applyMatch(match: string, st: ReaderState): void {
  st.input = InputCore.seed(match);
}

/**
 * Render the reverse-search status line to a string.
 * Format mirrors bash/readline: `(reverse-i-search)\`<query>\': <match>`
 */
export function renderReverseSearchLine(query: string, match: string | null): string {
  const display = match ?? '';
  return `(reverse-i-search)\`${query}\': ${display}`;
}

/**
 * Process a single keypress while reverse-search is active.
 *
 * Returns `true` if the key was consumed by the search modal (caller should
 * `return`), `false` to hand control back to the normal dispatcher.
 *
 * Consumed keys:
 *   - Printable chars: append to query, search from beginning.
 *   - Backspace: remove last char from query, re-search.
 *   - Ctrl-R: cycle to the next older match.
 *   - Enter: accept current match, return false (let normal Enter submit).
 *   - Esc / Ctrl-G: cancel, restore saved buffer, return true.
 *   - Ctrl-C: cancel without restoring (let normal Ctrl-C handle abort).
 */
export function handleReverseSearchKey(
  char: string | undefined,
  key: KeyInfo,
  rs: ReverseSearchState,
  st: ReaderState,
  entries: readonly string[],
  repaintCtx: RepaintCtx,
  repaintFn: typeof _repaint,
): boolean {
  // Ctrl-R: cycle to next older match.
  if (key?.ctrl && key?.name === 'r') {
    const next = findNextMatch(rs.query, entries, rs.matchIndex);
    if (next !== -1) {
      rs.matchIndex = next;
      applyMatch(entries[next]!, st);
    }
    repaintReverseSearch(rs, st, entries, repaintCtx, repaintFn);
    return true;
  }

  // Esc or Ctrl-G: cancel.
  if (key?.name === 'escape' || (key?.ctrl && key?.name === 'g')) {
    cancelReverseSearch(rs, st);
    repaintFn(st, repaintCtx);
    return true;
  }

  // Ctrl-C: do not consume — let the abort path in the outer dispatcher fire.
  if (key?.ctrl && key?.name === 'c') {
    cancelReverseSearch(rs, st);
    return false;
  }

  // Enter: accept (keep current buffer), do not consume — normal Enter logic submits.
  if (key?.name === 'return') {
    acceptReverseSearch(rs, st);
    return false;
  }

  // Backspace: trim query by one grapheme cluster.
  if (key?.name === 'backspace') {
    if (rs.query.length > 0) {
      // Use spread to correctly handle multi-byte chars.
      const chars = [...rs.query];
      chars.pop();
      rs.query = chars.join('');
    }
    // Re-search from the beginning when query shrinks.
    rs.matchIndex = -1;
    const next = findNextMatch(rs.query, entries, -1);
    if (next !== -1) { rs.matchIndex = next; applyMatch(entries[next]!, st); }
    else if (rs.query.length === 0) { st.input = InputCore.seed(rs.savedBuffer); }
    repaintReverseSearch(rs, st, entries, repaintCtx, repaintFn);
    return true;
  }

  // Printable character: append to query and search from beginning.
  const noModifier = !key?.ctrl && !key?.meta;
  const printable =
    noModifier && typeof char === 'string' && char.length > 0 && char >= ' '
      ? char
      : null;
  if (printable !== null) {
    rs.query += printable;
    rs.matchIndex = -1;
    const next = findNextMatch(rs.query, entries, -1);
    if (next !== -1) { rs.matchIndex = next; applyMatch(entries[next]!, st); }
    repaintReverseSearch(rs, st, entries, repaintCtx, repaintFn);
    return true;
  }

  // Any other key (arrows, etc.): exit the modal without changing buffer, let
  // the outer dispatcher process the key normally.
  acceptReverseSearch(rs, st);
  return false;
}

/**
 * Repaint during reverse-search: write the search status line as the prompt.
 *
 * We call the normal repaint (which already clears and redraws) and then
 * overwrite the prompt text with the search-mode indicator. Since `repaintFn`
 * uses `repaintCtx.promptText` verbatim, we temporarily swap it before the
 * call and restore it after — a pure side-effect-free swap that leaves the ctx
 * unchanged from the caller's perspective.
 */
function repaintReverseSearch(
  rs: ReverseSearchState,
  st: ReaderState,
  entries: readonly string[],
  repaintCtx: RepaintCtx,
  repaintFn: typeof _repaint,
): void {
  const match = rs.matchIndex >= 0 ? (entries[rs.matchIndex] ?? null) : null;
  const line = renderReverseSearchLine(rs.query, match);

  // Temporarily override promptText so repaint shows the search indicator.
  const savedPrompt = repaintCtx.promptText;
  const savedLen = repaintCtx.promptVisibleLen;
  // Cast to mutable for the duration of this call — we restore before returning.
  (repaintCtx as { promptText: string }).promptText = line;
  (repaintCtx as { promptVisibleLen: number }).promptVisibleLen = line.length;
  try {
    repaintFn(st, repaintCtx);
  } finally {
    (repaintCtx as { promptText: string }).promptText = savedPrompt;
    (repaintCtx as { promptVisibleLen: number }).promptVisibleLen = savedLen;
  }
}
