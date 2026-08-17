/**
 * handleKeypress — key-event dispatcher for readWithAutocompleteTty.
 *
 * Routes over the full key taxonomy in priority order:
 *   bracketed-paste markers → control sequences → navigation/editing →
 *   submit/abort → printable characters.
 *
 * Sub-concerns extracted into sibling modules:
 *   - Paste / clipboard:   {@link ./reader.keypress.paste.ts}
 *   - Navigation/editing:  {@link ./reader.keypress.nav.ts}
 *
 * Invariant: no closure over `let` bindings from readWithAutocompleteTty.
 * All mutable state is threaded through `ReaderState`; all immutable
 * dependencies come through `KeypressCtx`.
 */

import { list as listSlashCommands, aliasEntries } from '../slash/registry.js';
import { InputCore } from '../input-core.js';
import { isPrintableGrapheme } from './printable.js';
import { isSoftNewlineEnter, endsWithBackslashContinuation } from './enter-decision.js';
import { handlePasteStart, handlePasteEnd, handleCtrlV } from './reader.keypress.paste.js';
import { handleNavKey, writeEofOutput } from './reader.keypress.nav.js';
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

  if (key?.name === 'return') {
    // shift+enter / alt+enter: insert newline without submitting.
    //
    // Detection order:
    //   1. Node readline keypress: key.shift === true on return in most
    //      terminals (xterm, iTerm2 with default profile, kitty).
    //   2. Kitty keyboard protocol fallback: `\x1b[13;2u` (shift+enter).
    //   3. Alt+enter: key.meta === true on return.
    //
    // Known gap: terminals that do not report shift-state on Enter (e.g.,
    // some tmux configurations, PuTTY, older macOS Terminal.app profiles)
    // will not insert a newline — plain Enter will submit as usual. Users
    // can always use trailing `\` as an escape hatch (preserved below).
    if (isSoftNewlineEnter(key, sequence)) {
      st.input = InputCore.insert(st.input, '\n');
      opts.history?.resetRecall();
      repaintFn(st, repaintCtx);
      return;
    }

    // While pasting: add literal newline, do NOT submit
    if (st.pasting) {
      st.input = InputCore.insert(st.input, '\n');
      // Do NOT repaint per-char while pasting; end marker will trigger full repaint
      return;
    }

    // Burst detection: treat rapid 'return' as part of pasted multi-line content
    if (inBurst) {
      st.input = InputCore.insert(st.input, '\n');
      schedulePaintFn(st, repaintCtx);
      return;
    }

    if (st.ac.dropdownOpen) {
      // Slash commands: one Enter finalizes the choice AND submits.
      // File refs (`@path`): only accept the path — the user is
      // likely mid-sentence and still typing a prompt, so submitting
      // here would send a bare path by mistake. Tab still accepts-
      // only for either kind (see below).
      //
      // COR-2: only submit after a slash completion if applySelection()
      // actually applied a candidate (returns true). If no candidate was
      // selected, applySelection() is a no-op and we must NOT submit the
      // raw partial slash text.
      const kind = st.ac.trigger?.kind;
      const applied = applySelectionFn(st, repaintCtx, repaintFn);
      if (kind === 'slash' && applied) { callbacks.onSubmit(); }
    } else if (endsWithBackslashContinuation(st.input.buffer)) {
      // Trailing backslash escapes Enter → convert to a real newline.
      st.input = InputCore.replaceRange(
        st.input,
        { start: st.input.buffer.length - 1, end: st.input.buffer.length },
        '\n',
      );
      repaintFn(st, repaintCtx);
    } else {
      callbacks.onSubmit();
    }
    return;
  }

  if ((key?.shift && key?.name === 'tab') || key?.sequence === '\x1b[Z') {
    opts.onShiftTab?.();
    return;
  }

  if (key?.name === 'tab') {
    if (st.ac.dropdownOpen) {
      applySelectionFn(st, repaintCtx, repaintFn);
    } else {
      // Ghost-accept for mid-sentence skill token (non-compositor path).
      // Mirrors the source (c) logic in getDeterministicGhost (suggest.ts).
      // The compositor path handles its own ghost-accept via applyGhostAccept();
      // this branch covers reader.ts-only surfaces (non-TTY fallback).
      const upToCursor = st.input.buffer.slice(0, st.input.cursor);
      const ghostMatch = /\s+\/([A-Za-z][A-Za-z0-9_:-]*)$/.exec(upToCursor);
      if (ghostMatch) {
        const partial = ghostMatch[1]!;
        const slashPartial = '/' + partial;
        const allNames = [
          ...listSlashCommands().map(c => c.name),
          ...aliasEntries().map(e => e.alias),
        ];
        const bestMatch = allNames
          .filter(n => n.startsWith(slashPartial))
          .sort((a, b) => a.localeCompare(b))[0];
        if (bestMatch) {
          const afterCursor = st.input.buffer.slice(st.input.cursor);
          const start = st.input.cursor - slashPartial.length;
          const replacement = bestMatch + (afterCursor.startsWith(' ') ? '' : ' ');
          st.input = InputCore.replaceRange(st.input, { start, end: st.input.cursor }, replacement);
          repaintFn(st, repaintCtx);
        }
      }
    }
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
