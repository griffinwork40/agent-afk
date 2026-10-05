/**
 * Cursor and editing bindings -- extracted from
 * terminal-compositor.input-dispatch.ts.
 *
 * Exports: handleCursorAndEdit -- the readline-parity handler for
 * word/line navigation, kill commands, Ctrl+L, Ctrl+D, arrow keys,
 * Home/End, and forward-Delete. All bindings delegate to InputCore
 * pure transitions or call back into the KeyDispatchHost slice.
 */

import { InputCore } from './input-core.js';
import type { KeyInfo } from './terminal-compositor.types.js';
import type { KeyDispatchHost } from './terminal-compositor.input-dispatch.js';
import { commitIfChanged, applyAtomicPlaceholderDelete } from './terminal-compositor.input-dispatch.enter.js';

export function handleCursorAndEdit(self: KeyDispatchHost, key: KeyInfo): boolean {
  // Invariant: modifier-aware navigation bindings MUST be dispatched
  // before the plain `left`/`right` handlers below. The plain
  // handlers match on `name === 'left'/'right'` regardless of
  // modifiers, so meta/ctrl-modified arrows would otherwise be
  // shadowed and never reach the word-nav code.
  //
  // Contract: every binding in this block is a pure cursor/edit op
  // delegated to InputCore. Detection by `(modifier, name)` mirrors
  // the dormant `reader.ts` fallback so behavior is consistent across
  // both input surfaces. Node's readline parser maps modified arrows
  // and Esc-prefixed letters as documented inline below.
  //
  // Buffer-modifying ops call `history?.resetRecall()` before
  // `applyEdit` (same convention as the existing backspace/delete
  // branches). Pure cursor moves rely on `applyEdit`'s identity
  // check to no-op at buffer edges.

  // Cmd+<- (terminal default remap on Terminal.app & iTerm2 sends
  // \x01 = Ctrl+A) / Ctrl+A -> move to start of current logical line.
  if (key?.ctrl && key?.name === 'a') {
    self.applyEdit(InputCore.moveLineStart(self.input));
    return true;
  }

  // Cmd+-> (default remap -> \x05 = Ctrl+E) / Ctrl+E -> line end.
  if (key?.ctrl && key?.name === 'e') {
    self.applyEdit(InputCore.moveLineEnd(self.input));
    return true;
  }

  // Option+<- (xterm CSI 1;3D -> meta+left) / Cmd+<- when terminal sends
  // CSI 1;9D (also parsed as meta+left by Node) / Ctrl+<- (CSI 1;5D,
  // cross-platform word-back convention) -> word backward.
  if ((key?.meta || key?.ctrl) && key?.name === 'left') {
    self.applyEdit(InputCore.moveWordBackward(self.input));
    return true;
  }

  // Option+-> / Cmd+-> (CSI 1;9C) / Ctrl+-> -> word forward.
  if ((key?.meta || key?.ctrl) && key?.name === 'right') {
    self.applyEdit(InputCore.moveWordForward(self.input));
    return true;
  }

  // Option+B / Alt+B (Esc-prefixed, "Use Option as Meta" mode) -> word back.
  if (key?.meta && key?.name === 'b') {
    self.applyEdit(InputCore.moveWordBackward(self.input));
    return true;
  }

  // Option+F / Alt+F -> word forward.
  if (key?.meta && key?.name === 'f') {
    self.applyEdit(InputCore.moveWordForward(self.input));
    return true;
  }

  // Ctrl+W -> delete word backward (readline `backward-kill-word`).
  if (key?.ctrl && key?.name === 'w') {
    return commitIfChanged(self, InputCore.deleteWordBackward(self.input));
  }

  // Ctrl+U -> delete from cursor to start of current line
  // (readline `backward-kill-line`). Also fires on Cmd+Delete in
  // iTerm2 profiles that remap it to ^U.
  if (key?.ctrl && key?.name === 'u') {
    return commitIfChanged(self, InputCore.deleteToLineStart(self.input));
  }

  // Ctrl+K -> delete from cursor to end of current line
  // (readline `kill-line`). Symmetric counterpart to Ctrl+U.
  if (key?.ctrl && key?.name === 'k') {
    return commitIfChanged(self, InputCore.deleteToLineEnd(self.input));
  }

  // Ctrl+L -> clear screen and repaint the live frame.
  // External constraint: clearScreen() writes the erase sequences BEFORE
  // repaint() so log-update's cursor-math starts from a clean screen.
  // Mirrors reader.ts:566-576. Works in idle and streaming modes alike --
  // there is no turn-scoped state to protect here.
  if (key?.ctrl && key?.name === 'l') {
    self.clearScreen();
    return true;
  }

  // Ctrl+D -> EOF / forward-delete.
  // When the buffer is EMPTY: trigger the same onCancel path used by idle
  // Ctrl+C (equivalent to EOF on an empty line -- standard shell behavior).
  // When the buffer is NON-EMPTY: forward-delete one character at the
  // cursor (readline `delete-char`). Mirrors reader.ts:462-478.
  if (key?.ctrl && key?.name === 'd') {
    if (self.input.buffer.length === 0) {
      if (self.onCancel) self.onCancel();
    } else {
      self.history?.resetRecall();
      self.applyEdit(InputCore.deleteForward(self.input));
    }
    return true;
  }

  if (key?.name === 'left') { self.applyEdit(InputCore.moveLeft(self.input)); return true; }

  if (key?.name === 'right') {
    // When cursor is already at end-of-buffer and a ghost is showing,
    // Right-arrow accepts ONE WORD from the ghost (nibble), keeping the
    // rest visible as dim text. Tab accepts the full ghost in one shot.
    // Mid-buffer Right-arrow keeps its normal cursor-advance behavior.
    if (
      self.input.cursor === self.input.buffer.length &&
      self.activeGhost !== null &&
      !self.autocompleteState?.dropdownOpen
    ) {
      self.applyGhostWordAccept();
    } else {
      self.applyEdit(InputCore.moveRight(self.input));
    }
    return true;
  }

  // Home -> move to start of current logical line (`moveLineStart`).
  // In a multi-line buffer this lands at the character after the previous
  // '\n', not at absolute position 0 -- matching the user's visual intent
  // when editing a multi-line draft. Ctrl+A retains the same behavior
  // (it has always called moveLineStart). moveHome / moveEnd (buffer-
  // absolute) are intentionally NOT used here.
  if (key?.name === 'home') {
    self.applyEdit(InputCore.moveLineStart(self.input));
    return true;
  }

  // End -> move to end of current logical line (`moveLineEnd`).
  // Symmetric counterpart to Home above. In a multi-line buffer this
  // lands at the '\n' position (the character before the newline),
  // not at the absolute buffer end. Ctrl+E retains the same behavior.
  if (key?.name === 'end') {
    self.applyEdit(InputCore.moveLineEnd(self.input));
    return true;
  }

  if (key?.name === 'delete') {
    // Option+Fn-Delete -> meta+delete: delete next word.
    if (key?.meta) {
      return commitIfChanged(self, InputCore.deleteWordForward(self.input));
    }
    // Atomic placeholder delete (forward) -- symmetric counterpart
    // to the backspace branch. When the cursor sits at the
    // leading `[` of a placeholder, Delete removes the whole token.
    if (applyAtomicPlaceholderDelete(self, 'forward')) return true;
    self.history?.resetRecall();
    self.applyEdit(InputCore.deleteForward(self.input));
    return true;
  }
  return false;
}
