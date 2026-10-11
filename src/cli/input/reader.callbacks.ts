/**
 * Submit / abort / EOF callback factories for readWithAutocompleteTty.
 *
 * Extracted from reader.ts to keep readWithAutocompleteTty under the
 * 200-line function ceiling. Each factory takes explicit parameters so
 * there is no closure over readWithAutocompleteTty's `let` bindings
 * (same invariant as the other reader.* siblings).
 */

import * as ansiEscapes from 'ansi-escapes';
import { colorizeInputBuffer } from '../input-highlight.js';
import { describeAttachmentSummary } from './attachments.js';
import { formatSubmittedEcho } from './echo.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx } from './reader.repaint.js';
import type { ReadWithAutocompleteOpts, ReadWithAutocompleteResult } from './types.js';

export interface ReaderCallbacks {
  onSubmit: () => void;
  onAbort: (err: Error) => void;
  onEof: () => void;
}

/**
 * Build the three terminal-state callbacks for a single readWithAutocompleteTty
 * invocation. All mutable state is accessed through `st` (passed by reference);
 * the `cleanup` function is provided by the caller so callbacks can detach
 * listeners without knowing their implementation.
 */
export function buildReaderCallbacks(
  st: ReaderState,
  stdout: NodeJS.WriteStream,
  repaintCtx: RepaintCtx,
  opts: ReadWithAutocompleteOpts,
  promptText: string,
  cleanup: () => void,
  resolve: (value: ReadWithAutocompleteResult) => void,
  reject: (err: Error) => void,
): ReaderCallbacks {
  const onSubmit = (): void => {
    // Clear dropdown (if any) and leave the submitted input line as the last
    // visible row, with cursor on the next line for the caller's output.
    if (st.prevStatusRows > 0 || st.prevBufferRows > 0) {
      stdout.write(ansiEscapes.cursorUp(st.prevStatusRows + st.prevBufferRows));
    }
    // Erase everything below the cursor so any prior multi-line edit
    // state or dropdown chrome is cleared before the echo is rewritten.
    stdout.write('\r');
    stdout.write(ansiEscapes.eraseDown);
    st.rowsBelow = 0;
    // eraseDown above wipes the in-input `renderStatusLine` indicator, so
    // any attachment acknowledgment must be re-emitted as part of the
    // post-submit echo or the user loses all visual confirmation that an
    // image rode along with the turn.
    const echo = formatSubmittedEcho({
      buffer: colorizeInputBuffer(st.input.buffer, repaintCtx.slashRegistryView),
      promptText,
      isTTY: Boolean(stdout.isTTY),
      attachmentSummary: describeAttachmentSummary(st.attachments),
    });
    // External constraint (DECSTBM contract): the StatusLine reserves the
    // bottom row via a persistent scroll region. A `\n` written at the
    // bottom of that sub-region triggers a sub-region scroll on
    // xterm/iTerm2/Apple Terminal and the displaced top line silently
    // exits without entering scrollback — meaning this echo can vanish
    // from the user's scroll history if subsequent turn output causes
    // enough cumulative sub-region scrolls. Route through the guard so
    // the write happens with full-screen scroll semantics, which DOES
    // enter scrollback. No-op when statusLine has no guard or hasn't
    // started (e.g. non-TTY test surfaces).
    const writeEcho = (): void => { stdout.write(echo + '\n'); };
    if (opts.statusLine?.withFullScrollRegion) {
      opts.statusLine.withFullScrollRegion(writeEcho);
    } else {
      writeEcho();
    }
    cleanup();
    resolve({ text: st.input.buffer, attachments: [...st.attachments] });
    st.prevBufferRows = 0;
  };

  const onAbort = (err: Error): void => {
    const abortUpRows = st.prevStatusRows + st.prevBufferRows;
    if (abortUpRows > 0) {
      stdout.write(ansiEscapes.cursorUp(abortUpRows));
    }
    if (st.rowsBelow > 0) {
      stdout.write(ansiEscapes.eraseDown);
      st.rowsBelow = 0;
    }
    stdout.write('\n');
    cleanup();
    reject(err);
    st.prevBufferRows = 0;
  };

  const onEof = (): void => {
    cleanup();
    resolve({ text: '', attachments: [...st.attachments] });
    st.prevBufferRows = 0;
  };

  return { onSubmit, onAbort, onEof };
}
