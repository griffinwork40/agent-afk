/**
 * Layout helpers for the input box's submitted-echo and row counting.
 *
 * Pure: no I/O. Used by the raw-mode reader to know how many rows the
 * current buffer will occupy on next repaint and how to render the
 * post-submit echo.
 */

import stringWidth from 'string-width';
import { stripAnsi } from '../display.js';
import { palette } from '../palette.js';
import { card } from '../render.js';
import { getTerminalWidth } from '../terminal-size.js';

/**
 * Render the post-submit echo of the user's input.
 *
 * User echoes are right-aligned (chat-bubble convention — the speaker's own
 * messages sit on the right).
 *
 * - Non-TTY: returns `promptText + buffer` verbatim (line-mode fallback —
 *   right-alignment requires a live terminal width to make sense).
 * - TTY + short single-line buffer: returns the buffer padded with leading
 *   spaces so it ends flush against the right edge of the terminal. The
 *   prompt prefix is dropped — the user already saw it while typing, and
 *   keeping it would defeat the right-alignment.
 * - TTY + multi-line buffer OR a single line that would not fit on one row:
 *   returns a `card({kind:'user', body: buffer})` block with the cyan bar
 *   on the right edge, so user turns are visually distinct from agent
 *   output in long transcripts.
 *
 * When `attachmentSummary` is provided, it is appended below the echoed
 * buffer in dim style. This preserves the user's visual acknowledgment that
 * an image rode along with their message — the pre-submit `renderStatusLine`
 * status indicator is wiped by the `eraseDown` that precedes this echo, so
 * the summary must be re-emitted here or it vanishes entirely.
 *
 * The returned string does NOT include a trailing newline; the caller adds
 * one to advance the cursor below the echoed content.
 *
 * @param opts - Submission context.
 * @returns Multi-line string ready to write to stdout.
 */
export function formatSubmittedEcho(opts: {
  buffer: string;
  promptText: string;
  isTTY: boolean;
  /** Optional override for the terminal width — defaults to the live width. */
  terminalWidth?: number;
  /**
   * Optional plain-text annotation rendered dim below the echoed buffer
   * (e.g. "[image attached]"). Empty / undefined → no annotation. The
   * caller passes raw text; styling is applied here so callers stay free
   * of palette concerns.
   */
  attachmentSummary?: string;
}): string {
  const { buffer, promptText, isTTY, attachmentSummary } = opts;
  const summary = attachmentSummary && attachmentSummary.length > 0 ? attachmentSummary : null;

  if (!isTTY) {
    // Non-TTY (pipe / log / file): right-alignment is meaningless. Append
    // the summary inline so it lands on the same captured line as the
    // echoed message.
    const base = promptText + buffer;
    return summary !== null ? `${base} ${summary}` : base;
  }

  const cols = opts.terminalWidth ?? getTerminalWidth();
  const isMultiLine = buffer.includes('\n');
  const bufferW = stringWidth(stripAnsi(buffer));
  // "Long" = the rendered single line would not comfortably fit on one row
  // with at least 2 cols of right margin. Card path avoids ugly mid-word
  // wrap of a right-aligned echo.
  const isLong = bufferW >= cols - 2;

  let primary: string;
  if (!isMultiLine && !isLong) {
    // Right-pad with leading spaces so the buffer ends near the terminal edge.
    // Prepend a ▶ glyph (2 visible columns) so the user's own message has a
    // distinctive left shoulder in scrollback — replaces the two leading spaces.
    const GLYPH = palette.user('▶') + ' '; // 2 visible columns: glyph + space
    const GLYPH_W = 2;
    // Invariant (last-column safety): the echoed content ends at column
    // `cols - 1` at most — never the terminal's final column. A printable
    // glyph in the last column leaves many emulators (iTerm2/Ghostty/Kitty/
    // WezTerm) in the DECAWM deferred-wrap state; when the compositor later
    // CUP-repositions for the committed-band repaint — and skill/slash turns
    // fire extra repaints (arm→streaming, dispose→idle) — those terminals
    // flush the pending wrap inconsistently and the committed row drops or
    // triples in scrollback (the "user prompt echoed 3×" report). xterm
    // handles the boundary cleanly, so this never surfaces in the
    // @xterm/headless harness — only on real terminals. The card path
    // (render/card.ts `rightEdge = cols - 1`) reserves this column the same
    // way; this inline path is its sibling and must match or the bug returns.
    const rightEdge = cols - 1;
    const pad = Math.max(0, rightEdge - bufferW - GLYPH_W);
    primary = GLYPH + ' '.repeat(pad) + buffer;
  } else {
    primary = card({ kind: 'user', body: buffer });
  }

  if (summary === null) {
    return primary;
  }

  // Right-align the dim summary line. `palette.dim` wraps in ANSI escapes
  // (zero-width); pad based on the visible width of the raw summary string.
  // Reserve the final column for the same last-column-safety reason as the
  // primary echo above — a glyph in the last column triggers the DECAWM
  // deferred-wrap tripling/drop on real terminals.
  const summaryW = stringWidth(summary);
  const summaryPad = Math.max(0, cols - 1 - summaryW);
  const summaryLine = ' '.repeat(summaryPad) + palette.dim(summary);
  return primary + '\n' + summaryLine;
}

/**
 * Count visual rows (including soft-wrap) after the first row, for cursor-up on next repaint.
 * Prompt width counts toward line 0 only; continuation lines start at column 0.
 *
 * Both `buffer` and `promptVisibleLen` are interpreted as printable widths —
 * callers should pass the prompt's already-stripped width and a buffer that
 * matches what's actually written to the terminal. `stringWidth` handles
 * wide chars; we strip ANSI from the buffer before measuring so colorized
 * tokens (zero-width escapes) don't inflate the count.
 */
export function visualRowCount(
  buffer: string,
  promptVisibleLen: number,
  cols: number,
): number {
  const columnWidth = cols || 80;
  const lines = buffer.split('\n');
  let totalRows = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = stripAnsi(lines[i]!);
    const visibleWidth = (i === 0 ? promptVisibleLen : 0) + stringWidth(line);
    totalRows += Math.max(1, Math.ceil(visibleWidth / columnWidth));
  }
  return Math.max(0, totalRows - 1);
}

/**
 * Compute the visual (row, col) position of `cursorIdx` within the rendered
 * prompt+buffer block. `row` is 0-indexed from the prompt's row; `col` is the
 * 0-indexed terminal column on that row. Accounts for both explicit `\n`
 * splits and soft-wrap at `cols`.
 *
 * Used by the input reader's repaint to position the terminal cursor after
 * a rewrite — the naive `promptW + cursorIdx` formula clamps past the right
 * edge on wrap, leaving the visible cursor stuck at the screen edge.
 *
 * Edge case: when the cursor sits exactly at a wrap boundary
 * (`visiblePrefix % cols === 0` with a non-empty prefix), the cursor is
 * conceptually at col 0 of the next row (the terminal's deferred-wrap
 * state). We report that position; callers should clamp any negative
 * `cursorUp` that results from `visualRowCount` undercounting the deferred
 * row.
 */
export function visualCursorPos(
  buffer: string,
  cursorIdx: number,
  promptVisibleLen: number,
  cols: number,
): { row: number; col: number } {
  const columnWidth = cols || 80;
  const lines = buffer.split('\n');
  let row = 0;
  let consumed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // +1 for the '\n' separator that follows this line (except the last).
    const lineSpan = line.length + (i < lines.length - 1 ? 1 : 0);
    if (cursorIdx <= consumed + line.length) {
      // Cursor is on this line at character offset (cursorIdx - consumed).
      const lineOffset = cursorIdx - consumed;
      const beforeCursor = stripAnsi(line.slice(0, lineOffset));
      const visiblePrefix = (i === 0 ? promptVisibleLen : 0) + stringWidth(beforeCursor);
      const wrappedRow = Math.floor(visiblePrefix / columnWidth);
      const wrappedCol = visiblePrefix % columnWidth;
      return { row: row + wrappedRow, col: wrappedCol };
    }
    // Cursor lies past this line — advance past its visual rows.
    const visibleWidth = (i === 0 ? promptVisibleLen : 0) + stringWidth(stripAnsi(line));
    row += Math.max(1, Math.ceil(visibleWidth / columnWidth));
    consumed += lineSpan;
  }
  // Unreachable for valid cursorIdx, but fall back to the end of the block.
  return { row, col: 0 };
}
