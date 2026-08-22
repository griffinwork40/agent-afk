/**
 * handleKeypress — key-event dispatcher for readWithAutocompleteTty.
 *
 * Routes over the full key taxonomy in priority order:
 *   bracketed-paste markers → control sequences → navigation/editing →
 *   submit/abort → printable characters.
 *
 * Sub-concerns extracted into sibling modules:
 *   - Paste / clipboard:        {@link ./reader.keypress.paste.ts}
 *   - Navigation/editing:       {@link ./reader.keypress.nav.ts}
 *   - Submit/tab (Enter, Tab):  {@link ./reader.keypress.submit.ts}
 *
 * Invariant: no closure over `let` bindings from readWithAutocompleteTty.
 * All mutable state is threaded through `ReaderState`; all immutable
 * dependencies come through `KeypressCtx`.
 */

import { isPrintableGrapheme } from './printable.js';
import { handlePasteStart, handlePasteEnd, handleCtrlV } from './reader.keypress.paste.js';
import { handleNavKey, writeEofOutput } from './reader.keypress.nav.js';
import { handleReturnKey, handleTabKey } from './reader.keypress.submit.js';
import {
  enterReverseSearch,
  handleReverseSearchKey,
} from './reader.reverse-search.js';
import { InputCore } from '../input-core.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx, repaint as _repaint, schedulePaint as _schedulePaint } from './reader.repaint.js';
import type { applySelection as _applySelection } from './reader.selection.js';
import type { KeyInfo, ReadWithAutocompleteOpts } from './types.js';

/** Callbacks wired to the promise resolution / rejection paths. */
export interface KeypressCallbacks {
  onSubmit(): void;
  onAbort(err: Error): void;
  /** Ctrl+D on an empty buffer resolves with empty text (not a rejection). */
  onEof(): void;
}

/** Full context required by handleKeypress. */
export interface KeypressCtx {
  opts: ReadWithAutocompleteOpts;
  stdout: NodeJS.WriteStream;
  repaintCtx: RepaintCtx;
  callbacks: KeypressCallbacks;
  /** Burst detection window in milliseconds. */
  pasteWindowMs: number;
}

/**
 * Process a single keypress event emitted by `readline.emitKeypressEvents`.
 */
export function handleKeypress(
  char: string | undefined,
  key: KeyInfo,
  st: ReaderState,
  kCtx: KeypressCtx,
  repaintFn: typeof _repaint,
  schedulePaintFn: typeof _schedulePaint,
  applySelectionFn: typeof _applySelection,
): void {
  const { opts, stdout, repaintCtx, callbacks, pasteWindowMs } = kCtx;

  // Track timing for burst detection (for fallback when bracketed paste is unavailable).
  const now = Date.now();
  const inBurst = (now - st.lastKeypressAt) < pasteWindowMs;
  st.lastKeypressAt = now;

  const sequence = key?.sequence || '';

  // Bracketed paste markers.
  if (sequence === '\x1b[200~') { handlePasteStart(st); return; }
  if (sequence === '\x1b[201~') { handlePasteEnd(st, repaintCtx, repaintFn, schedulePaintFn); return; }

  // Ctrl+C
  if (key?.ctrl && key?.name === 'c') {
    if (opts.onSigint) { opts.onSigint(); } else { callbacks.onAbort(new Error('SIGINT')); }
    return;
  }

  // Ctrl+D: EOF only when buffer is empty. Resolves (not rejects) with empty text.
  if (key?.ctrl && key?.name === 'd') {
    if (st.input.buffer.length === 0) {
      writeEofOutput(st, stdout);
      callbacks.onEof();
      st.prevBufferRows = 0;
    }
    return;
  }

  // Ctrl+V: paste image from clipboard.
  if (key?.ctrl && key?.name === 'v') { handleCtrlV(st, repaintCtx, schedulePaintFn); return; }

  // Ctrl+R: reverse incremental history search.
  // If the modal is already active, `handleReverseSearchKey` cycles to the next
  // older match. If not, activate the modal now.
  if (key?.ctrl && key?.name === 'r') {
    const entries = opts.history?.getEntries?.() ?? [];
    if (!st.reverseSearch.active) {
      enterReverseSearch(st.reverseSearch, st);
    }
    // Delegate — this will cycle to the next match (or do nothing if no history).
    handleReverseSearchKey(char, key, st.reverseSearch, st, entries, repaintCtx, repaintFn);
    return;
  }

  // While reverse-search is active, route all keys through the search handler.
  // The handler returns false only for Enter (accept+submit) and Ctrl-C (abort)
  // — in those cases fall through to let the outer dispatcher handle them.
  if (st.reverseSearch.active) {
    const entries = opts.history?.getEntries?.() ?? [];
    const consumed = handleReverseSearchKey(char, key, st.reverseSearch, st, entries, repaintCtx, repaintFn);
    if (consumed) return;
    // Key was not consumed (Enter or Ctrl-C) — fall through to normal handling.
  }

  if (key?.name === 'escape') {
    if (st.ac.dropdownOpen) {
      // Pin the dismissal to the current (buffer, cursor) signature so
      // repaint() leaves the menu closed even though detectTrigger still
      // matches (e.g. `/ship ` ends in whitespace and triggers the flag
      // menu unconditionally). Any subsequent edit or cursor move
      // invalidates the signature and re-arms autocomplete.
      st.ac.suppressedSignature = `${st.input.cursor}:${st.input.buffer}`;
      st.ac.dropdownOpen = false;
      st.ac.candidates = [];
      repaintFn(st, repaintCtx);
    }
    return;
  }

  // Navigation and editing bindings (arrow keys, Ctrl+A/E/B/F/P/N/W/U/K/X/L,
  // Alt+B/F, backspace, delete). Returns true when consumed.
  if (handleNavKey(key, st, stdout, repaintCtx, repaintFn, opts.history)) return;

  // Enter/Return: submit, soft-newline, backslash-continuation, paste-through.
  if (handleReturnKey(key, sequence, st, opts, inBurst, callbacks, repaintFn, schedulePaintFn, applySelectionFn, repaintCtx)) return;

  if ((key?.shift && key?.name === 'tab') || key?.sequence === '\x1b[Z') {
    opts.onShiftTab?.();
    return;
  }

  // Tab: dropdown accept / ghost-accept for mid-sentence slash tokens.
  if (key?.name === 'tab') {
    handleTabKey(st, repaintFn, applySelectionFn, repaintCtx);
    return;
  }

  // Printable char: prefer `char` (arg 1), fall back to key.sequence.
  // isPrintableGrapheme (shared with the compositor's handlePrintable)
  // admits multi-UTF-16-unit emoji that the old `length === 1` test
  // silently dropped on this fallback path.
  const noModifier = !key?.ctrl && !key?.meta;
  const printable =
    noModifier && typeof char === 'string' && isPrintableGrapheme(char)
      ? char
      : noModifier && typeof key?.sequence === 'string' && isPrintableGrapheme(key.sequence)
        ? key.sequence
        : null;
  if (printable !== null) {
    st.input = InputCore.insert(st.input, printable);
    opts.history?.resetRecall();
    // Suppress repaint while pasting; end marker will trigger full repaint
    if (!st.pasting) {
      if (inBurst) { schedulePaintFn(st, repaintCtx); } else { repaintFn(st, repaintCtx); }
    }
  }
}
