/**
 * Navigation and editing key handlers for readWithAutocompleteTty.
 *
 * Handles the standard readline/emacs movement and editing bindings:
 * arrow keys, home/end, Ctrl+A/E/B/F/P/N/W/U/K/X, Alt+B/F, backspace,
 * delete, and Ctrl+L (clear-screen).
 *
 * The submit/abort, paste, and printable-character paths stay in the
 * main keypress dispatcher ({@link ./reader.keypress.ts}).
 *
 * Invariant: no closure over `let` bindings from readWithAutocompleteTty.
 */

import * as ansiEscapes from 'ansi-escapes';
import { InputCore } from '../input-core.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx, repaint as _repaint } from './reader.repaint.js';
import type { KeyInfo, IHistoryRing } from './types.js';

/**
 * Process a single navigation or editing key.
 *
 * Returns `true` if the key was handled (caller should `return`),
 * `false` if it was not recognised as a nav/edit key and control
 * should fall through to the next dispatch arm.
 */
export function handleNavKey(
  key: KeyInfo,
  st: ReaderState,
  stdout: NodeJS.WriteStream,
  repaintCtx: RepaintCtx,
  repaintFn: typeof _repaint,
  history: IHistoryRing | undefined,
): boolean {
  // Ctrl+L: clear screen and repaint current draft.
  // External constraint: `cursorTo(0,0)` + eraseDown must precede
  // repaint() — if repaint fires first, its cursorUp math will be
  // wrong relative to the cleared screen.
  if (key?.ctrl && key?.name === 'l') {
    st.prevBufferRows = 0;
    st.prevStatusRows = 0;
    stdout.write('\x1b[H\x1b[2J'); // cursor home then erase entire screen
    repaintFn(st, repaintCtx);
    return true;
  }

  // Ctrl+A: move to start of current logical line (readline emacs-mode).
  if (key?.ctrl && key?.name === 'a') {
    const next = InputCore.moveLineStart(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  // Ctrl+E: move to end of current logical line.
  if (key?.ctrl && key?.name === 'e') {
    const next = InputCore.moveLineEnd(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  // Ctrl+B: char backward (alias for left arrow).
  if (key?.ctrl && key?.name === 'b') {
    const next = InputCore.moveLeft(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  // Ctrl+F: char forward (alias for right arrow).
  if (key?.ctrl && key?.name === 'f') {
    const next = InputCore.moveRight(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  // Alt+B / Option+B: word backward.
  if (key?.meta && key?.name === 'b') {
    const next = InputCore.moveWordBackward(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  // Alt+F / Option+F: word forward.
  if (key?.meta && key?.name === 'f') {
    const next = InputCore.moveWordForward(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  // Ctrl+W: delete word backward (readline backward-kill-word).
  if (key?.ctrl && key?.name === 'w') {
    const next = InputCore.deleteWordBackward(st.input);
    if (next !== st.input) { st.input = next; history?.resetRecall(); repaintFn(st, repaintCtx); }
    return true;
  }

  // Ctrl+P / ↑: move up one visual row in draft, or recall history.
  // Priority: (1) dropdown → existing selection behavior; (2) cursor can
  // move up in buffer → do that; (3) buffer empty/pristine at top row →
  // recall from history.
  if ((key?.ctrl && key?.name === 'p') || key?.name === 'up') {
    if (st.ac.dropdownOpen) {
      if (st.ac.selectedIndex > 0) {
        st.ac.selectedIndex--;
        if (st.ac.selectedIndex < st.ac.viewportStart) st.ac.viewportStart = st.ac.selectedIndex;
        repaintFn(st, repaintCtx);
      }
      return true;
    }
    const cols = stdout.columns || 80;
    const result = InputCore.moveUpLine(st.input, cols, repaintCtx.promptVisibleLen);
    if (result.moved) {
      st.input = result.state;
      history?.resetRecall();
      repaintFn(st, repaintCtx);
    } else {
      if (history) {
        const recalled = history.back(st.input.buffer);
        if (recalled !== null) {
          st.input = InputCore.seed(recalled);
          repaintFn(st, repaintCtx);
        }
      }
    }
    return true;
  }

  // Ctrl+N / ↓: move down one visual row in draft, or forward through history.
  if ((key?.ctrl && key?.name === 'n') || key?.name === 'down') {
    if (st.ac.dropdownOpen) {
      if (st.ac.selectedIndex < st.ac.candidates.length - 1) {
        st.ac.selectedIndex++;
        if (st.ac.selectedIndex >= st.ac.viewportStart + st.maxDropdownRows) {
          st.ac.viewportStart = st.ac.selectedIndex - st.maxDropdownRows + 1;
        }
        repaintFn(st, repaintCtx);
      }
      return true;
    }
    const cols = stdout.columns || 80;
    const result = InputCore.moveDownLine(st.input, cols, repaintCtx.promptVisibleLen);
    if (result.moved) {
      st.input = result.state;
      history?.resetRecall();
      repaintFn(st, repaintCtx);
    } else {
      if (history) {
        const recalled = history.forward();
        if (recalled !== null) {
          st.input = InputCore.seed(recalled);
          repaintFn(st, repaintCtx);
        }
      }
    }
    return true;
  }

  if (key?.name === 'left') {
    const next = InputCore.moveLeft(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  if (key?.name === 'right') {
    const next = InputCore.moveRight(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  if (key?.name === 'home') {
    const next = InputCore.moveHome(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  if (key?.name === 'end') {
    const next = InputCore.moveEnd(st.input);
    if (next !== st.input) { st.input = next; repaintFn(st, repaintCtx); }
    return true;
  }

  // Ctrl+U / Cmd+Delete-when-mapped-to-^U: delete to start of line.
  // macOS Terminal.app intercepts Cmd+Delete and does not forward it to
  // TUI programs by default. iTerm2 and other terminals can be configured
  // to send `\x15` (Ctrl+U) on Cmd+Delete; when they do, this handler
  // fires. Ctrl+U is also a standard readline binding for the same op.
  if (key?.ctrl && key?.name === 'u') {
    const next = InputCore.deleteToLineStart(st.input);
    if (next !== st.input) { st.input = next; history?.resetRecall(); repaintFn(st, repaintCtx); }
    return true;
  }

  // Ctrl+K: delete to end of line (symmetric counterpart to Ctrl+U).
  if (key?.ctrl && key?.name === 'k') {
    const next = InputCore.deleteToLineEnd(st.input);
    if (next !== st.input) { st.input = next; history?.resetRecall(); repaintFn(st, repaintCtx); }
    return true;
  }

  // Ctrl+X: discard most-recently-added attachment (no-op if none queued).
  // Binding rationale: unbound in this file; visually associated with
  // cut/remove (Windows cut, Emacs kill-region prefix); avoids EOF risk
  // of Ctrl+D and terminal-suspend risk of Ctrl+Z.
  if (key?.ctrl && key?.name === 'x') {
    if (st.attachments.length > 0) { st.attachments.pop(); repaintFn(st, repaintCtx); }
    return true;
  }

  if (key?.name === 'backspace') {
    // Option+Delete on macOS → meta+backspace: delete previous word.
    if (key?.meta) {
      const next = InputCore.deleteWordBackward(st.input);
      if (next !== st.input) { st.input = next; history?.resetRecall(); repaintFn(st, repaintCtx); }
      return true;
    }
    const next = InputCore.backspace(st.input);
    if (next !== st.input) { st.input = next; history?.resetRecall(); repaintFn(st, repaintCtx); }
    else if (st.attachments.length > 0) { st.attachments.pop(); repaintFn(st, repaintCtx); }
    return true;
  }

  if (key?.name === 'delete') {
    // Option+Fn-Delete on macOS → meta+delete: delete next word.
    if (key?.meta) {
      const next = InputCore.deleteWordForward(st.input);
      if (next !== st.input) { st.input = next; history?.resetRecall(); repaintFn(st, repaintCtx); }
      return true;
    }
    const next = InputCore.deleteForward(st.input);
    if (next !== st.input) { st.input = next; history?.resetRecall(); repaintFn(st, repaintCtx); }
    return true;
  }

  return false;
}

/**
 * Write a Ctrl+D EOF output sequence to stdout.
 * Factored out so the caller can call cleanup/resolve after writing.
 */
export function writeEofOutput(st: ReaderState, stdout: NodeJS.WriteStream): void {
  if (st.prevStatusRows > 0 || st.prevBufferRows > 0) {
    stdout.write(ansiEscapes.cursorUp(st.prevStatusRows + st.prevBufferRows));
  }
  if (st.rowsBelow > 0) {
    stdout.write(ansiEscapes.eraseDown);
    st.rowsBelow = 0;
  }
  stdout.write('\n');
}
