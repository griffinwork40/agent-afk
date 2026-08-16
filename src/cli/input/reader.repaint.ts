/**
 * repaint + schedulePaint helpers for readWithAutocompleteTty.
 *
 * Both functions are tightly coupled — schedulePaint's setImmediate callback
 * calls repaint, and repaint is scheduled in many keypress branches — so they
 * live together in one sibling module rather than being split further.
 *
 * Invariant: neither function closes over any `let` from readWithAutocompleteTty.
 * Every piece of mutable state is threaded through the `ReaderState` bag.
 */

import * as ansiEscapes from 'ansi-escapes';
import stringWidth from 'string-width';
import { stripAnsi } from '../display.js';
import { colorizeInputBuffer, type SlashRegistryView } from '../input-highlight.js';
import { renderStatusLine } from './attachments.js';
import { formatDropdownRow, formatHintRow } from './dropdown.js';
import { visualCursorPos, visualRowCount } from './echo.js';
import {
  detectTrigger,
  filterFileCandidates,
  filterFlagCandidates,
  filterSlashCandidates,
} from './trigger.js';
import type { IHistoryRing } from './types.js';
import type { ReaderState } from './reader.state.js';

/** Context required by repaint that cannot change across calls. */
export interface RepaintCtx {
  stdout: NodeJS.WriteStream;
  promptText: string;
  promptVisibleLen: number;
  slashRegistryView: SlashRegistryView;
  historyGetEntries?: IHistoryRing['getEntries'];
}

/**
 * Fully redraw the input line (and optional dropdown) at whatever row the
 * cursor currently occupies. Preserves surrounding history — uses only
 * relative cursor motion and erase-from-cursor-to-end-of-screen.
 */
export function repaint(st: ReaderState, ctx: RepaintCtx): void {
  const { stdout, promptText, promptVisibleLen, slashRegistryView, historyGetEntries } = ctx;

  // If the previous render spanned multiple rows (multi-line buffer) or had a status line,
  // move the cursor up to the top row of that render before clearing.
  if (st.prevStatusRows > 0 || st.prevBufferRows > 0) {
    stdout.write(ansiEscapes.cursorUp(st.prevStatusRows + st.prevBufferRows));
  }

  // Cursor is now at col 0 of the first row of the previous render.
  // Move to col 0 and erase everything below.
  stdout.write('\r');
  stdout.write(ansiEscapes.eraseDown);

  // Write status line: attachment summary, or ephemeral failure notice, or nothing.
  if (st.attachments.length > 0) {
    stdout.write(renderStatusLine(st.attachments) + '\n');
    st.prevStatusRows = 1;
  } else if (st.clipboardFailureMsg !== null) {
    // Paint-clear: consume and display the failure message exactly once.
    const msg = st.clipboardFailureMsg;
    st.clipboardFailureMsg = null;
    stdout.write(msg + '\n');
    st.prevStatusRows = 1;
  } else {
    st.prevStatusRows = 0;
  }

  // Write prompt + buffer (cursor ends at end-of-buffer on input line).
  // The slash highlighter wraps the leading `/<command>` token in ANSI
  // escapes (zero-width) — printable length is unchanged, so cursor math
  // below (`promptVisibleLen + input.cursor`) still works against the
  // uncolored buffer.
  stdout.write(promptText + colorizeInputBuffer(st.input.buffer, slashRegistryView));

  // Recompute trigger / candidates from current buffer + cursor.
  //
  // Suppression check: if the user just hit Escape, the dropdown stays
  // closed for as long as the (buffer, cursor) signature matches the
  // dismissed state. Any edit or cursor move produces a different
  // signature and re-arms autocomplete on the next paint.
  st.ac.trigger = detectTrigger(st.input.buffer, st.input.cursor);
  const currentSignature = `${st.input.cursor}:${st.input.buffer}`;
  if (st.ac.suppressedSignature !== null && st.ac.suppressedSignature !== currentSignature) {
    st.ac.suppressedSignature = null;
  }
  if (st.ac.trigger && st.ac.suppressedSignature === null) {
    if (st.ac.trigger.kind === 'slash') {
      st.ac.candidates = filterSlashCandidates(
        st.ac.trigger.query,
        historyGetEntries?.() ?? [],
      ).slice(0, 12);
    } else if (st.ac.trigger.kind === 'file') {
      // File candidates are bounded upstream (MAX_FILE_MATCHES) and the
      // dropdown scrolls; do NOT re-cap to 12, or entries past the 12th
      // (e.g. src/, tests/ in a typical cwd) become unreachable.
      st.ac.candidates = filterFileCandidates(st.ac.trigger.query);
    } else {
      st.ac.candidates = filterFlagCandidates(st.ac.trigger.command, st.ac.trigger.query);
    }
    st.ac.dropdownOpen = st.ac.candidates.length > 0;
  } else {
    st.ac.dropdownOpen = false;
    st.ac.candidates = [];
  }
  if (st.ac.selectedIndex >= st.ac.candidates.length) st.ac.selectedIndex = Math.max(0, st.ac.candidates.length - 1);
  if (st.ac.viewportStart > st.ac.selectedIndex) st.ac.viewportStart = st.ac.selectedIndex;
  if (st.ac.selectedIndex >= st.ac.viewportStart + st.maxDropdownRows) {
    st.ac.viewportStart = st.ac.selectedIndex - st.maxDropdownRows + 1;
  }

  const cols = stdout.columns || 80;
  st.rowsBelow = 0;
  if (st.ac.dropdownOpen && cols > 40) {
    const maxWidth = Math.min(cols - 4, 60);
    const visibleCount = Math.min(st.ac.candidates.length - st.ac.viewportStart, st.maxDropdownRows);
    for (let i = 0; i < visibleCount; i++) {
      const idx = st.ac.viewportStart + i;
      const row = formatDropdownRow(st.ac.candidates[idx]!, idx === st.ac.selectedIndex, maxWidth, st.ac.trigger?.kind);
      stdout.write('\n' + row);
      // Each rendered row may itself wrap if the terminal is narrow
      // enough that the row's printable width exceeds `cols`. Count
      // soft-wrapped rows so eraseDown on the next repaint covers
      // every visible cell. ANSI escapes are zero-width — strip
      // before measuring.
      const rowWidth = stringWidth(stripAnsi(row));
      st.rowsBelow += Math.max(1, Math.ceil(rowWidth / cols));
    }

    // Tooltip row: "when to use" guidance for the highlighted candidate.
    // Only slash-command candidates carry hints today (file and flag
    // candidates leave `hint` undefined); formatHintRow returns null in
    // that case so no row is written and the dropdown collapses cleanly.
    //
    // Constraint: this row sits BELOW the dropdown — the cursor-return
    // math below uses `rowsBelow` as the total written-below count, so
    // every tooltip soft-wrap row must be folded into that total before
    // we compute the upward jump. Forgetting to update `rowsBelow` here
    // strands the cursor on the tooltip row on the next repaint.
    const hintWidth = Math.min(cols - 4, 80);
    const hintRow = formatHintRow(st.ac.candidates[st.ac.selectedIndex]?.hint, hintWidth);
    if (hintRow !== null) {
      stdout.write('\n' + hintRow);
      const hintRowWidth = stringWidth(stripAnsi(hintRow));
      st.rowsBelow += Math.max(1, Math.ceil(hintRowWidth / cols));
    }
  }

  // Return cursor to the input position within the rendered block.
  //
  // After writing prompt+buffer (+ optional dropdown), the terminal
  // cursor sits at the end of the last dropdown row — or at the end
  // of the buffer's last visual row if no dropdown. The cursor's
  // target visual (row, col) within the block is independent of the
  // natural end position when the user has arrow-keyed mid-buffer
  // OR the buffer wraps OR contains '\n'.
  //
  // Naive `\r` + cursorForward(promptW + cursor) is wrong here:
  // `\r` lands on the LAST visual row (post-wrap), not the prompt's
  // row, and cursorForward clamps at the right edge — so on every
  // soft-wrap the visible cursor jams against the screen edge
  // instead of tracking the typed text.
  //
  // Constraint: terminal cursor motion is row/column-relative; the
  // only known reference is the end-of-render position. Reconstruct
  // the target by computing visual (row, col) from the buffer +
  // cursor index, then navigate up from end-of-render.
  const newPrevBufferRows = visualRowCount(st.input.buffer, promptVisibleLen, cols);
  const { row: vRow, col: vCol } = visualCursorPos(
    st.input.buffer,
    st.input.cursor,
    promptVisibleLen,
    cols,
  );
  // End-of-render row offset from top of buffer block is
  // `newPrevBufferRows + rowsBelow`. Move up to land on vRow; clamp
  // at 0 to tolerate the deferred-wrap boundary where vRow can
  // briefly exceed newPrevBufferRows by one (cursor at the implicit
  // next row that hasn't been written yet).
  const upRows = Math.max(0, newPrevBufferRows - vRow + st.rowsBelow);
  if (upRows > 0) stdout.write(ansiEscapes.cursorUp(upRows));
  stdout.write('\r');
  if (vCol > 0) stdout.write(ansiEscapes.cursorForward(vCol));

  st.prevBufferRows = newPrevBufferRows;
}

/**
 * Coalesce repaints during burst (rapid keypress) periods.
 * If a repaint is already pending, returns immediately.
 * Otherwise, schedules repaint on next setImmediate tick.
 */
export function schedulePaint(st: ReaderState, ctx: RepaintCtx): void {
  if (st.repaintPending) return;
  st.repaintPending = true;
  setImmediate(() => {
    // COR-1: guard against firing after cleanup()+resolve().
    if (st.repaintPending && !st.settled) {
      st.repaintPending = false;
      repaint(st, ctx);
    }
  });
}
