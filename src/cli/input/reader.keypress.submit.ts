/**
 * Submit and completion-acceptance key handlers for readWithAutocompleteTty.
 *
 * Handles Enter (submit / soft-newline / backslash-continuation / paste-through)
 * and Tab (dropdown accept / ghost-accept for mid-sentence slash tokens).
 *
 * Extracted from {@link ./reader.keypress.ts} to keep the main dispatcher
 * under the 200-line function ceiling.
 *
 * Invariant: no closure over `let` bindings from readWithAutocompleteTty.
 */

import { list as listSlashCommands, aliasEntries } from '../slash/registry.js';
import { InputCore } from '../input-core.js';
import { isSoftNewlineEnter, endsWithBackslashContinuation } from './enter-decision.js';
import type { ReaderState } from './reader.state.js';
import type { RepaintCtx, repaint as _repaint, schedulePaint as _schedulePaint } from './reader.repaint.js';
import type { applySelection as _applySelection } from './reader.selection.js';
import type { KeyInfo, ReadWithAutocompleteOpts } from './types.js';

/** Callbacks wired to the promise resolution / rejection paths. */
interface SubmitCallbacks {
  onSubmit(): void;
}

/**
 * Handle the Enter/Return key.
 *
 * Returns `true` when the key was consumed (caller should `return`).
 * The ordering of sub-cases matters — see inline comments.
 */
export function handleReturnKey(
  key: KeyInfo,
  sequence: string,
  st: ReaderState,
  opts: ReadWithAutocompleteOpts,
  inBurst: boolean,
  callbacks: SubmitCallbacks,
  repaintFn: typeof _repaint,
  schedulePaintFn: typeof _schedulePaint,
  applySelectionFn: typeof _applySelection,
  repaintCtx: RepaintCtx,
): boolean {
  if (key?.name !== 'return') return false;

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
    return true;
  }

  // While pasting: add literal newline, do NOT submit
  if (st.pasting) {
    st.input = InputCore.insert(st.input, '\n');
    // Do NOT repaint per-char while pasting; end marker will trigger full repaint
    return true;
  }

  // Burst detection: treat rapid 'return' as part of pasted multi-line content
  if (inBurst) {
    st.input = InputCore.insert(st.input, '\n');
    schedulePaintFn(st, repaintCtx);
    return true;
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
  return true;
}

/**
 * Handle the Tab key (dropdown accept / ghost-accept for slash tokens).
 *
 * Tab is always terminal in the keypress dispatcher, so this handler does not
 * need to return a consumed discriminant.
 */
export function handleTabKey(
  st: ReaderState,
  repaintFn: typeof _repaint,
  applySelectionFn: typeof _applySelection,
  repaintCtx: RepaintCtx,
): void {
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
}
