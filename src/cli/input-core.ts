/**
 * Pure buffer/cursor mutations shared by CLI input surfaces.
 *
 * Cursor positions and replacement ranges remain UTF-16 code-unit indexes,
 * but all edit/navigation operations snap to grapheme-cluster boundaries so
 * surrogate pairs and combining sequences stay intact.
 */

import { nextGraphemeIndex, previousGraphemeIndex, splitGraphemes } from './display.js';
import { buildVisualPositionMap } from './input/echo.js';

// ---------------------------------------------------------------------------
// Discriminated return types for vertical line movement
// ---------------------------------------------------------------------------

export type MoveLineResult =
  | { moved: true; state: InputCoreState }
  | { moved: false };

export interface InputCoreState {
  readonly buffer: string;
  readonly cursor: number;
}

export interface InputCoreRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Build the set of UTF-16 indices that are valid grapheme-cluster boundaries
 * for `buffer`. Index 0 and `buffer.length` are always included. Any index
 * strictly between the start and end of a multi-code-unit grapheme (e.g. the
 * second code unit of a surrogate pair) is NOT included.
 *
 * Used by vertical navigation to skip mid-grapheme landing candidates — the
 * landing-index search must never place the cursor inside a surrogate pair or
 * combining sequence regardless of how `string-width` measures a partial slice
 * of that grapheme.
 */
function graphemeBoundaries(buffer: string): Set<number> {
  return new Set(graphemeOffsets(buffer));
}

/**
 * Ascending UTF-16 offsets of every grapheme-cluster boundary in `buffer`,
 * always starting with 0 and ending with `buffer.length`. Segments the
 * buffer exactly once, so callers that walk many graphemes (word jumps)
 * stay linear instead of re-segmenting per step.
 */
function graphemeOffsets(buffer: string): number[] {
  const offsets = [0];
  let offset = 0;
  for (const grapheme of splitGraphemes(buffer)) {
    offset += grapheme.length;
    offsets.push(offset);
  }
  return offsets;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) {
    return 0;
  }
  return Math.max(0, Math.min(length, Math.trunc(index)));
}

function moveCursor(state: InputCoreState, cursor: number): InputCoreState {
  const nextCursor = clampIndex(cursor, state.buffer.length);
  if (nextCursor === state.cursor) {
    return state;
  }
  return {
    buffer: state.buffer,
    cursor: nextCursor,
  };
}

/**
 * Walk backward from `cursor` over a "word" boundary: first skip any
 * trailing whitespace, then skip the run of non-whitespace before it.
 * Mirrors readline's `backward-kill-word` (Option+Delete on macOS).
 *
 * Steps by grapheme cluster so multi-code-unit graphemes (emoji, combined
 * sequences) are never split (#4987). The buffer is segmented once per call
 * and the boundary list is walked, keeping the operation linear.
 */
function wordStartBefore(buffer: string, cursor: number): number {
  let i = clampIndex(cursor, buffer.length);
  const offsets = graphemeOffsets(buffer);
  // k = index of the largest boundary strictly below i (what
  // previousGraphemeIndex(buffer, i) would return).
  let k = offsets.length - 1;
  while (k > 0 && offsets[k]! >= i) k--;
  while (i > 0) {
    const prev = offsets[k]!;
    if (!/\s/.test(buffer.slice(prev, i))) break;
    i = prev;
    k--;
  }
  while (i > 0) {
    const prev = offsets[k]!;
    if (/\s/.test(buffer.slice(prev, i))) break;
    i = prev;
    k--;
  }
  return i;
}

/**
 * Walk forward from `cursor` over a "word" boundary: skip leading
 * whitespace, then the run of non-whitespace after it.
 * Mirrors readline's `kill-word` (Option+Fn-Delete on macOS).
 *
 * Steps by grapheme cluster so multi-code-unit graphemes (emoji, combined
 * sequences) are never split (#4987). The buffer is segmented once per call
 * and the boundary list is walked, keeping the operation linear.
 */
function wordEndAfter(buffer: string, cursor: number): number {
  const len = buffer.length;
  let i = clampIndex(cursor, len);
  const offsets = graphemeOffsets(buffer);
  // k = index of the smallest boundary strictly above i (what
  // nextGraphemeIndex(buffer, i) would return).
  let k = 0;
  while (k < offsets.length - 1 && offsets[k]! <= i) k++;
  while (i < len) {
    const next = offsets[k]!;
    if (!/\s/.test(buffer.slice(i, next))) break;
    i = next;
    k++;
  }
  while (i < len) {
    const next = offsets[k]!;
    if (/\s/.test(buffer.slice(i, next))) break;
    i = next;
    k++;
  }
  return i;
}

/**
 * Index of the start of the current logical line (after the previous '\n'
 * or 0 if there is none).
 *
 * COR-7: when cursor is 0, `lastIndexOf('\n', -1)` is treated as
 * `lastIndexOf('\n', 0)` and returns 0 if `buffer[0] === '\n'`, causing
 * the function to return 1 instead of 0. Guard by clamping the search
 * start to `i - 1` only when `i > 0`.
 */
function lineStart(buffer: string, cursor: number): number {
  const i = clampIndex(cursor, buffer.length);
  const nl = i === 0 ? -1 : buffer.lastIndexOf('\n', i - 1);
  return nl < 0 ? 0 : nl + 1;
}

/**
 * Index of the end of the current logical line (the next '\n' or
 * buffer.length if there is none).
 */
function lineEnd(buffer: string, cursor: number): number {
  const i = clampIndex(cursor, buffer.length);
  const nl = buffer.indexOf('\n', i);
  return nl < 0 ? buffer.length : nl;
}

function replaceRange(
  state: InputCoreState,
  range: InputCoreRange,
  text: string,
): InputCoreState {
  const start = clampIndex(range.start, state.buffer.length);
  const end = clampIndex(range.end, state.buffer.length);
  const from = Math.min(start, end);
  const to = Math.max(start, end);

  if (from === to && text.length === 0) {
    return state;
  }

  const buffer = state.buffer.slice(0, from) + text + state.buffer.slice(to);
  const cursor = from + text.length;

  if (buffer === state.buffer && cursor === state.cursor) {
    return state;
  }

  return { buffer, cursor };
}

export const InputCore = {
  seed(buffer = ''): InputCoreState {
    return {
      buffer,
      cursor: buffer.length,
    };
  },

  replaceRange,

  insert(state: InputCoreState, text: string): InputCoreState {
    if (text.length === 0) {
      return state;
    }
    return replaceRange(state, { start: state.cursor, end: state.cursor }, text);
  },

  backspace(state: InputCoreState): InputCoreState {
    if (state.cursor === 0) {
      return state;
    }
    const start = previousGraphemeIndex(state.buffer, state.cursor);
    return replaceRange(state, { start, end: state.cursor }, '');
  },

  deleteForward(state: InputCoreState): InputCoreState {
    if (state.cursor >= state.buffer.length) {
      return state;
    }
    const end = nextGraphemeIndex(state.buffer, state.cursor);
    return replaceRange(state, { start: state.cursor, end }, '');
  },

  /**
   * Delete the word preceding the cursor (Option+Delete on macOS).
   * Skips trailing whitespace, then the previous non-whitespace run.
   * No-op when there's nothing to the left of the cursor.
   */
  deleteWordBackward(state: InputCoreState): InputCoreState {
    if (state.cursor === 0) {
      return state;
    }
    const start = wordStartBefore(state.buffer, state.cursor);
    if (start === state.cursor) {
      return state;
    }
    return replaceRange(state, { start, end: state.cursor }, '');
  },

  /**
   * Delete the word following the cursor (Option+Fn-Delete on macOS).
   * Skips leading whitespace, then the next non-whitespace run.
   */
  deleteWordForward(state: InputCoreState): InputCoreState {
    if (state.cursor >= state.buffer.length) {
      return state;
    }
    const end = wordEndAfter(state.buffer, state.cursor);
    if (end === state.cursor) {
      return state;
    }
    return replaceRange(state, { start: state.cursor, end }, '');
  },

  /**
   * Delete from the cursor back to the start of the current logical line
   * (Cmd+Delete on macOS — note: most terminals do not forward Cmd+Delete
   * natively; this is also bound to Ctrl+U, which terminals send when
   * Cmd+Delete is configured to translate to `\x15`).
   */
  deleteToLineStart(state: InputCoreState): InputCoreState {
    const start = lineStart(state.buffer, state.cursor);
    if (start === state.cursor) {
      return state;
    }
    return replaceRange(state, { start, end: state.cursor }, '');
  },

  /**
   * Delete from the cursor to the end of the current logical line
   * (Ctrl+K — symmetric counterpart to `deleteToLineStart`).
   */
  deleteToLineEnd(state: InputCoreState): InputCoreState {
    const end = lineEnd(state.buffer, state.cursor);
    if (end === state.cursor) {
      return state;
    }
    return replaceRange(state, { start: state.cursor, end }, '');
  },

  moveLeft(state: InputCoreState): InputCoreState {
    return moveCursor(state, previousGraphemeIndex(state.buffer, state.cursor));
  },

  moveRight(state: InputCoreState): InputCoreState {
    return moveCursor(state, nextGraphemeIndex(state.buffer, state.cursor));
  },

  moveHome(state: InputCoreState): InputCoreState {
    return moveCursor(state, 0);
  },

  moveEnd(state: InputCoreState): InputCoreState {
    return moveCursor(state, state.buffer.length);
  },

  /**
   * Move cursor to the start of the current logical line (Ctrl+A).
   * In a multi-line buffer, "line start" is the character after the
   * previous '\n' (or 0 if the cursor is on the first line).
   */
  moveLineStart(state: InputCoreState): InputCoreState {
    return moveCursor(state, lineStart(state.buffer, state.cursor));
  },

  /**
   * Move cursor to the end of the current logical line (Ctrl+E).
   * In a multi-line buffer, "line end" is the position of the next '\n'
   * (or buffer.length if the cursor is on the last line).
   */
  moveLineEnd(state: InputCoreState): InputCoreState {
    return moveCursor(state, lineEnd(state.buffer, state.cursor));
  },

  /**
   * Move cursor backward by one word (Alt+B / Option+B).
   * Skips trailing whitespace, then the preceding non-whitespace run.
   */
  moveWordBackward(state: InputCoreState): InputCoreState {
    return moveCursor(state, wordStartBefore(state.buffer, state.cursor));
  },

  /**
   * Move cursor forward by one word (Alt+F / Option+F).
   * Skips leading whitespace, then the next non-whitespace run.
   */
  moveWordForward(state: InputCoreState): InputCoreState {
    return moveCursor(state, wordEndAfter(state.buffer, state.cursor));
  },

  /**
   * Move cursor up one visual row within the buffer (Ctrl+P / ↑ when no
   * dropdown).
   *
   * Returns `{ moved: true; state }` when the cursor successfully moved to
   * the row above; returns `{ moved: false }` when the cursor is already on
   * the first visual row (caller should consider history recall instead).
   *
   * External constraint: terminal column arithmetic is governed by
   * `buildVisualPositionMap`, which shares the exact width primitive that
   * `visualCursorPos` (the repaint layer's cursor-positioner) measures with —
   * so the row/col mapping here cannot drift from what the terminal actually
   * renders. Injecting `terminalWidth` and `promptVisibleLen` from the caller
   * keeps InputCore pure.
   *
   * PERF: builds the (row, col) map for every index in ONE forward pass
   * (O(buffer.length)) and scans it for the landing index, replacing the
   * former O(n^2) loop that re-probed `visualCursorPos` (itself O(n)) at every
   * candidate index. The landing rule is preserved verbatim: among indices on
   * the target visual row, pick the one whose column is closest to the source
   * column, LEFTMOST winning ties (strict `<`), starting from index 0 so a
   * target row with no exact column match still lands on its first index.
   */
  moveUpLine(
    state: InputCoreState,
    terminalWidth: number,
    promptVisibleLen: number,
  ): MoveLineResult {
    const cols = terminalWidth || 80;
    const { rowAt, colAt } = buildVisualPositionMap(state.buffer, promptVisibleLen, cols);
    const boundaries = graphemeBoundaries(state.buffer);
    // Snap the source cursor to the nearest grapheme boundary at or before it.
    // If the cursor somehow sits inside a surrogate pair or combining sequence,
    // the partial-slice width measured by `colAt` is version-dependent (sw8 vs
    // sw9 disagree on lone-surrogate width). Snapping to the boundary index
    // guarantees a stable `targetCol` on both versions.
    const snappedCursor = boundaries.has(state.cursor)
      ? state.cursor
      : previousGraphemeIndex(state.buffer, state.cursor);
    const row = rowAt[snappedCursor]!;
    if (row === 0) {
      // Already on the first visual row — signal to caller for history recall.
      return { moved: false };
    }
    // Target: same visual column on the row above.
    const targetRow = row - 1;
    const targetCol = colAt[snappedCursor]!;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i <= state.buffer.length; i++) {
      if (!boundaries.has(i)) continue;
      const r = rowAt[i]!;
      if (r === targetRow) {
        const dist = Math.abs(colAt[i]! - targetCol);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      } else if (r > targetRow) {
        // Rows are monotonically non-decreasing in index — once past the
        // target row, no later index can be on it.
        break;
      }
    }
    const next = moveCursor(state, best);
    if (next === state) return { moved: false };
    return { moved: true, state: next };
  },

  /**
   * Move cursor down one visual row within the buffer (Ctrl+N / ↓ when no
   * dropdown).
   *
   * Returns `{ moved: true; state }` on success, `{ moved: false }` when
   * already on the last visual row (caller may advance history forward).
   *
   * External constraint: same `buildVisualPositionMap` invariant as
   * `moveUpLine`.
   *
   * PERF: single O(buffer.length) forward pass over the shared position map
   * (was O(n^2) via per-index `visualCursorPos`). The landing rule is
   * preserved verbatim: `best` defaults to `buffer.length` (the buffer-end
   * index), then among interior indices `0..length-1` on the target row the
   * closest column wins (LEFTMOST on ties, strict `<`); the buffer-end index
   * is considered LAST with the same strict comparison, so it only wins when
   * it is strictly closer than every interior candidate — matching the
   * original ordering exactly.
   */
  moveDownLine(
    state: InputCoreState,
    terminalWidth: number,
    promptVisibleLen: number,
  ): MoveLineResult {
    const cols = terminalWidth || 80;
    const { rowAt, colAt, totalRows } = buildVisualPositionMap(
      state.buffer,
      promptVisibleLen,
      cols,
    );
    const boundaries = graphemeBoundaries(state.buffer);
    const snappedCursor = boundaries.has(state.cursor)
      ? state.cursor
      : previousGraphemeIndex(state.buffer, state.cursor);
    const row = rowAt[snappedCursor]!;
    if (row >= totalRows) {
      // Already on the last visual row.
      return { moved: false };
    }
    const targetRow = row + 1;
    const targetCol = colAt[snappedCursor]!;
    let best = state.buffer.length;
    let bestDist = Infinity;
    // Interior indices first (0..length-1), then the buffer-end index below —
    // preserves the original's ordering, where `best` starts at buffer.length
    // and the end index is only overwritten by a strictly-closer interior hit.
    for (let i = 0; i < state.buffer.length; i++) {
      if (!boundaries.has(i)) continue;
      const r = rowAt[i]!;
      if (r === targetRow) {
        const dist = Math.abs(colAt[i]! - targetCol);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      } else if (r > targetRow) {
        break;
      }
    }
    // Buffer-end index, considered last with the same strict comparison.
    if (rowAt[state.buffer.length]! === targetRow) {
      const dist = Math.abs(colAt[state.buffer.length]! - targetCol);
      if (dist < bestDist) {
        best = state.buffer.length;
      }
    }
    const next = moveCursor(state, best);
    if (next === state) return { moved: false };
    return { moved: true, state: next };
  },
} as const;
