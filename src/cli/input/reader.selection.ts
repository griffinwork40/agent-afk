/**
 * applySelection helper for readWithAutocompleteTty.
 *
 * Applies the currently highlighted dropdown candidate to the input buffer.
 * Extracted from the Promise closure so it can be a module-level function
 * taking explicit parameters rather than a closure over the enclosing locals.
 */

import { InputCore } from '../input-core.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx, repaint as _repaint } from './reader.repaint.js';

/**
 * Apply the currently highlighted dropdown selection to the buffer.
 *
 * Returns `true` if a candidate was actually applied, `false` if there was
 * no candidate to apply.
 *
 * COR-2: callers that conditionally submit after a slash completion MUST gate
 * on this return value — if no candidate was selected, applySelection() is a
 * no-op and the raw partial slash text must NOT be submitted.
 */
export function applySelection(
  st: ReaderState,
  ctx: RepaintCtx,
  repaintFn: typeof _repaint,
): boolean {
  const selected = st.ac.candidates[st.ac.selectedIndex];
  if (!selected) return false;
  const upToCursor = st.input.buffer.slice(0, st.input.cursor);
  const afterCursor = st.input.buffer.slice(st.input.cursor);

  let start: number;
  let text: string;
  if (st.ac.trigger?.kind === 'slash') {
    const match = /\/[A-Za-z_-]*$/.exec(upToCursor);
    start = match ? upToCursor.length - match[0].length : st.input.cursor;
    text = selected.value + (afterCursor.startsWith(' ') ? '' : ' ');
  } else if (st.ac.trigger?.kind === 'flag') {
    // Replace the partial `--query` token at end-of-line with the selected flag.
    const match = /--[a-z0-9-]*$/.exec(upToCursor);
    start = match ? upToCursor.length - match[0].length : st.input.cursor;
    text = selected.value + (afterCursor.startsWith(' ') ? '' : ' ');
  } else {
    // Token boundary = start of trailing non-whitespace run (the `@token`).
    const tokenStart = upToCursor.search(/[^\s]*$/);
    start = tokenStart >= 0 ? tokenStart : st.input.cursor;
    text = selected.value;
  }

  st.input = InputCore.replaceRange(st.input, { start, end: st.input.cursor }, text);
  st.ac.dropdownOpen = false;
  st.ac.viewportStart = 0;
  st.ac.selectedIndex = 0;
  repaintFn(st, ctx);
  return true;
}
