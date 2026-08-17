/**
 * Paste and clipboard helpers for the readWithAutocompleteTty keypress handler.
 *
 * Bracketed paste (RFC 2068 / XTerm private mode 2004): the terminal wraps
 * pasted text in ESC [ 200 ~ ... ESC [ 201 ~ markers. The handler here detects
 * both the start and end markers and speculatively probes the clipboard for
 * image data (Cmd+V on macOS places both text and image data on the pasteboard).
 *
 * Ctrl+V (literal) also probes for a clipboard image without triggering the
 * bracketed paste path at all — it is the explicit "attach image" binding.
 *
 * Invariant: no closure over `let` bindings from readWithAutocompleteTty.
 * All mutable state is threaded through `ReaderState`; all immutable
 * dependencies come through the `PasteCtx`.
 */

import { readClipboardImage } from './clipboard-image.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx, schedulePaint as _schedulePaint, repaint as _repaint } from './reader.repaint.js';

/**
 * Handle a bracketed-paste START marker (ESC [ 200 ~).
 * Saves the buffer length so the end handler can detect zero-character pastes.
 */
export function handlePasteStart(st: ReaderState): void {
  st.pasting = true;
  st.pasteStartBufferLen = st.input.buffer.length;
}

/**
 * Handle a bracketed-paste END marker (ESC [ 201 ~).
 *
 * Two cases:
 *  - Zero characters pasted → speculatively probe clipboard for an image
 *    (Cmd+V on a clipboard image sends an empty bracketed paste on macOS).
 *  - Non-empty paste → repaint to show the text, then speculatively probe
 *    for a parallel clipboard image (Finder copies text+image simultaneously).
 */
export function handlePasteEnd(
  st: ReaderState,
  repaintCtx: RepaintCtx,
  repaintFn: typeof _repaint,
  schedulePaintFn: typeof _schedulePaint,
): void {
  st.pasting = false;
  if (st.input.buffer.length === st.pasteStartBufferLen) {
    // Zero characters pasted — probe for image.
    if (!st.clipboardInFlight) {
      st.clipboardInFlight = true;
      readClipboardImage().then((img) => {
        if (img) {
          st.clipboardFailureMsg = null;
          st.attachments.push(img);
        } else {
          st.clipboardFailureMsg = '[clipboard: no image found]';
        }
        schedulePaintFn(st, repaintCtx);
      }).catch(() => { /* ignore */ }).finally(() => {
        st.clipboardInFlight = false;
      });
    }
  } else {
    // Non-empty paste: repaint text, speculatively probe for image.
    repaintFn(st, repaintCtx);
    if (!st.clipboardInFlight) {
      st.clipboardInFlight = true;
      readClipboardImage().then((img) => {
        if (img) {
          st.clipboardFailureMsg = null;
          st.attachments.push(img);
          schedulePaintFn(st, repaintCtx);
        }
      }).catch(() => { /* ignore */ }).finally(() => {
        st.clipboardInFlight = false;
      });
    }
  }
}

/**
 * Handle Ctrl+V (explicit clipboard-image attach).
 *
 * The in-flight guard prevents concurrent osascript spawns from rapid key
 * repetition. schedulePaint() is used so that if the user typed during the
 * async probe, the repaint reflects the latest buffer state.
 */
export function handleCtrlV(
  st: ReaderState,
  repaintCtx: RepaintCtx,
  schedulePaintFn: typeof _schedulePaint,
): void {
  if (!st.clipboardInFlight) {
    st.clipboardInFlight = true;
    readClipboardImage().then((img) => {
      if (img) {
        st.clipboardFailureMsg = null;
        st.attachments.push(img);
      } else {
        st.clipboardFailureMsg = '[clipboard: no image found]';
      }
      schedulePaintFn(st, repaintCtx);
    }).catch(() => { /* ignore */ }).finally(() => {
      st.clipboardInFlight = false;
    });
  }
}
