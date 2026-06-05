/**
 * Pure buffer/cursor mutations shared by CLI input surfaces.
 *
 * Cursor positions and replacement ranges remain UTF-16 code-unit indexes,
 * but all edit/navigation operations snap to grapheme-cluster boundaries so
 * surrogate pairs and combining sequences stay intact.
 */

import { nextGraphemeIndex, previousGraphemeIndex } from './display.js';
import { visualCursorPos } from './input/echo.js';

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
 */
function wordStartBefore(buffer: string, cursor: number): number {
  let i = clampIndex(cursor, buffer.length);
  while (i > 0 && /\s/.test(buffer.charAt(i - 1))) i--;
  while (i > 0 && !/\s/.test(buffer.charAt(i - 1))) i--;
  return i;
}

/**
 * Walk forward from `cursor` over a "word" boundary: skip leading
 * whitespace, then the run of non-whitespace after it.
 * Mirrors readline's `kill-word` (Option+Fn-Delete on macOS).
 */
function wordEndAfter(buffer: string, cursor: number): number {
  const len = buffer.length;
  let i = clampIndex(cursor, len);
  while (i < len && /\s/.test(buffer.charAt(i))) i++;
  while (i < len && !/\s/.test(buffer.charAt(i))) i++;
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
   * `visualCursorPos`, which is the same function the repaint layer uses.
   * Injecting `terminalWidth` and `promptVisibleLen` from the caller keeps
   * InputCore pure.
   */
  moveUpLine(
    state: InputCoreState,
    terminalWidth: number,
    promptVisibleLen: number,
  ): MoveLineResult {
    const cols = terminalWidth || 80;
    const { row, col } = visualCursorPos(state.buffer, state.cursor, promptVisibleLen, cols);
    if (row === 0) {
      // Already on the first visual row — signal to caller for history recall.
      return { moved: false };
    }
    // Target: same visual column on the row above.
    const targetRow = row - 1;
    const targetCol = col;
    // Walk backward through the buffer looking for the character at (targetRow, targetCol).
    // We re-derive position for each candidate index via visualCursorPos — this is O(n)
    // over buffer length, acceptable for typical REPL inputs (< a few hundred chars).
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i <= state.buffer.length; i++) {
      const pos = visualCursorPos(state.buffer, i, promptVisibleLen, cols);
      if (pos.row === targetRow) {
        const dist = Math.abs(pos.col - targetCol);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
        // Once we've passed targetRow, stop (rows are monotonically non-decreasing).
      } else if (pos.row > targetRow) {
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
   * External constraint: same `visualCursorPos` invariant as `moveUpLine`.
   */
  moveDownLine(
    state: InputCoreState,
    terminalWidth: number,
    promptVisibleLen: number,
  ): MoveLineResult {
    const cols = terminalWidth || 80;
    const { row, col } = visualCursorPos(state.buffer, state.cursor, promptVisibleLen, cols);
    // Compute the total number of visual rows in the buffer block.
    const lastPos = visualCursorPos(state.buffer, state.buffer.length, promptVisibleLen, cols);
    if (row >= lastPos.row) {
      // Already on the last visual row.
      return { moved: false };
    }
    const targetRow = row + 1;
    const targetCol = col;
    let best = state.buffer.length;
    let bestDist = Infinity;
    // PERF-4: loop bound is `< buffer.length` — the buffer-end position is
    // handled below by reusing the already-computed `lastPos`, avoiding a
    // duplicate O(n) call to visualCursorPos at i === buffer.length.
    for (let i = 0; i < state.buffer.length; i++) {
      const pos = visualCursorPos(state.buffer, i, promptVisibleLen, cols);
      if (pos.row === targetRow) {
        const dist = Math.abs(pos.col - targetCol);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      } else if (pos.row > targetRow) {
        break;
      }
    }
    // Reuse lastPos (already computed above) for the buffer-end position.
    if (lastPos.row === targetRow) {
      const dist = Math.abs(lastPos.col - targetCol);
      if (dist < bestDist) {
        best = state.buffer.length;
      }
    }
    const next = moveCursor(state, best);
    if (next === state) return { moved: false };
    return { moved: true, state: next };
  },
} as const;
