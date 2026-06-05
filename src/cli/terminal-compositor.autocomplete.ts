/**
 * Autocomplete dropdown + inline ghost-text logic, extracted from
 * terminal-compositor.ts. Follows the free-functions-on-host pattern used by
 * src/cli/_lib/stream-renderer-*: TerminalCompositor owns the state; these
 * functions operate on the narrow {@link AutocompleteHost} slice it passes as
 * `self`. No behavior change — bodies are moves with `this.` rewritten to
 * `self.`, intra-module calls (updateAutocomplete) made direct, and the shared
 * MAX_DROPDOWN_ROWS budget co-located here.
 */

import { InputCore, type InputCoreState } from './input-core.js';
import {
  detectTrigger,
  filterFileCandidates,
  filterFlagCandidates,
  filterSlashCandidates,
} from './input/trigger.js';
import { stripGhostControlChars } from './input/suggest.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { SuggestContext, SuggestEngine } from './terminal-compositor.types.js';

/** Maximum dropdown rows to show inside the compositor frame. */
export const MAX_DROPDOWN_ROWS = 6;

/**
 * Narrowest TerminalCompositor state slice the autocomplete/ghost functions
 * touch. `input`/`queued`/`activeGhost` are mutated; `autocompleteState` is
 * mutated in-place (never reassigned, so it stays a `readonly` view).
 * `repaint` is the cross-cluster render callback (a class method on the host).
 */
export interface AutocompleteHost {
  readonly autocompleteState?: AutocompleteState;
  input: InputCoreState;
  queued: boolean;
  activeGhost: string | null;
  readonly ghostEngine: SuggestEngine | undefined;
  readonly ghostGetContext: (() => SuggestContext) | undefined;
  repaint(): void;
}

/**
 * Recompute autocomplete candidates from the current buffer/cursor and
 * store results back into the shared AutocompleteState. Called on every
 * printable keypress, backspace, and left/right so the dropdown stays
 * consistent with the buffer content during the agent turn.
 */
export function updateAutocomplete(self: AutocompleteHost): void {
  const ac = self.autocompleteState;
  if (!ac) return;

  ac.trigger = detectTrigger(self.input.buffer, self.input.cursor);
  const currentSignature = `${self.input.cursor}:${self.input.buffer}`;
  if (ac.suppressedSignature !== null && ac.suppressedSignature !== currentSignature) {
    ac.suppressedSignature = null;
  }
  if (ac.trigger && ac.suppressedSignature === null) {
    if (ac.trigger.kind === 'slash') {
      ac.candidates = filterSlashCandidates(ac.trigger.query).slice(0, 12);
    } else if (ac.trigger.kind === 'file') {
      // File candidates are bounded upstream (MAX_FILE_MATCHES) and the
      // dropdown scrolls; do NOT re-cap to 12, or entries past the 12th
      // (e.g. src/, tests/ in a typical cwd) become unreachable.
      ac.candidates = filterFileCandidates(ac.trigger.query);
    } else {
      ac.candidates = filterFlagCandidates(ac.trigger.command, ac.trigger.query);
    }
    ac.dropdownOpen = ac.candidates.length > 0;
  } else {
    ac.dropdownOpen = false;
    ac.candidates = [];
  }
  if (ac.selectedIndex >= ac.candidates.length) {
    ac.selectedIndex = Math.max(0, ac.candidates.length - 1);
  }
  if (ac.viewportStart > ac.selectedIndex) ac.viewportStart = ac.selectedIndex;
  if (ac.selectedIndex >= ac.viewportStart + MAX_DROPDOWN_ROWS) {
    ac.viewportStart = ac.selectedIndex - MAX_DROPDOWN_ROWS + 1;
  }
}

/**
 * Update the active ghost text for the current buffer state.
 *
 * Called from `applyEdit` (every buffer/cursor change) so the ghost is
 * always consistent with the current input. Never called while `pasting`
 * — the paste burst suppresses per-character repaints and a ghost mid-paste
 * would be stale by the time the paste ends.
 *
 * Invariant: MUST NOT block the keystroke path. `getDeterministicGhost` is
 * synchronous (safe). `getGhost` is fire-and-forget — its resolution only
 * stores a result when the buffer is still identical to what was requested
 * (stale-async guard captures the buffer snapshot before dispatch and
 * compares on resolve; mismatched buffer → result is silently dropped).
 * A repaint is scheduled only after the guard passes.
 *
 * Invariant: when the dropdown is open, ghost text is suppressed in
 * `renderInputLine` (ghost defers to the dropdown UI). We still eagerly
 * compute the Tier-1 ghost here so it is ready the moment the dropdown
 * closes — no additional async round-trip needed.
 */
export function updateGhost(self: AutocompleteHost): void {
  if (!self.ghostEngine || !self.ghostGetContext) return;
  const buffer = self.input.buffer;

  // Stale-invalidation: clear any ghost that no longer extends the buffer.
  if (self.activeGhost !== null && !self.activeGhost.startsWith(buffer)) {
    self.activeGhost = null;
  }

  // Tier 1: synchronous, always runs.
  const ctx = self.ghostGetContext();
  const tier1 = self.ghostEngine.getDeterministicGhost(buffer, ctx);
  if (tier1 !== null) {
    self.activeGhost = tier1;
    return;
  }

  // No Tier-1 match — clear any stale ghost and, when the dropdown is
  // closed, kick off a Tier-2 async request (fire-and-forget).
  self.activeGhost = null;
  const ac = self.autocompleteState;
  if (ac?.dropdownOpen) return;

  // Stale-async guard: snapshot the buffer BEFORE the async dispatch.
  // The resolve handler will discard the result if the buffer has changed.
  const requestedBuffer = buffer;
  self.ghostEngine.getGhost(buffer, ctx).then((result) => {
    // Contract: only store the result when the buffer is still the same
    // and the result is a strict prefix-extension (safety net against a
    // misbehaving engine returning a non-prefix string).
    if (
      result !== null &&
      self.input.buffer === requestedBuffer &&
      result.startsWith(requestedBuffer) &&
      result.length > requestedBuffer.length
    ) {
      self.activeGhost = result;
      self.repaint();
    }
  }).catch(() => { /* engine never throws, but be defensive */ });
}

/**
 * Apply the currently highlighted dropdown candidate to the buffer. Mirrors
 * `applySelection` in `src/cli/input/reader.ts` so Tab behaves identically
 * across the user-turn and agent-turn input surfaces.
 *
 * Returns `true` when a candidate was actually applied. `false` when the
 * dropdown is closed or empty (caller can fall through to a no-op without
 * spuriously closing the dropdown).
 */
export function applyDropdownSelection(self: AutocompleteHost): boolean {
  const ac = self.autocompleteState;
  if (!ac?.dropdownOpen || ac.candidates.length === 0) return false;
  const selected = ac.candidates[ac.selectedIndex];
  if (!selected) return false;

  const upToCursor = self.input.buffer.slice(0, self.input.cursor);
  const afterCursor = self.input.buffer.slice(self.input.cursor);

  let start: number;
  let text: string;
  if (ac.trigger?.kind === 'slash') {
    const match = /\/[A-Za-z_-]*$/.exec(upToCursor);
    start = match ? upToCursor.length - match[0].length : self.input.cursor;
    text = selected.value + (afterCursor.startsWith(' ') ? '' : ' ');
  } else if (ac.trigger?.kind === 'flag') {
    const match = /--[a-z0-9-]*$/.exec(upToCursor);
    start = match ? upToCursor.length - match[0].length : self.input.cursor;
    text = selected.value + (afterCursor.startsWith(' ') ? '' : ' ');
  } else {
    // File `@token`: token boundary = start of trailing non-whitespace run.
    const tokenStart = upToCursor.search(/[^\s]*$/);
    start = tokenStart >= 0 ? tokenStart : self.input.cursor;
    text = selected.value;
  }

  const next = InputCore.replaceRange(
    self.input,
    { start, end: self.input.cursor },
    text,
  );
  if (next === self.input) return false;
  self.input = next;
  // Reset dropdown viewport — same as reader.ts:303-305. The follow-up
  // updateAutocomplete() call may re-open the dropdown if the new cursor
  // position still matches a trigger (e.g. after applying `/mint ` the
  // cursor sits past the space, so `detectTrigger` returns null and the
  // dropdown stays closed). Resetting here makes that the steady state.
  ac.dropdownOpen = false;
  ac.candidates = [];
  ac.viewportStart = 0;
  ac.selectedIndex = 0;
  self.queued = false;
  updateAutocomplete(self);
  self.repaint();
  return true;
}

/**
 * Accept the current ghost text: replace the buffer with the full ghost
 * string, move the cursor to the end, clear the ghost, and repaint.
 *
 * Returns `true` when a ghost was accepted; `false` when there was no
 * active ghost to accept (or the preconditions were not met). Callers
 * check the return to decide whether to fall through to their own logic.
 *
 * Preconditions (all must hold):
 *   - `activeGhost` is set
 *   - cursor is at end-of-buffer
 *   - the ghost still strictly extends the current buffer (strict-prefix check)
 *   - the autocomplete dropdown is closed
 */
export function applyGhostAccept(self: AutocompleteHost): boolean {
  const ghost = self.activeGhost;
  if (ghost === null) return false;
  const ac = self.autocompleteState;
  if (ac?.dropdownOpen) return false;
  if (self.input.cursor !== self.input.buffer.length) return false;
  if (!ghost.startsWith(self.input.buffer) || ghost.length <= self.input.buffer.length) return false;
  // Replace buffer with the full ghost and position cursor at end. Sanitize
  // the suggested *remainder* before committing it (mirrors the render-path
  // strip in renderInputLine): the typed prefix is the user's own clean
  // input, but a Tier-1 candidate sourced from history could carry an
  // embedded newline / control char that would otherwise be injected
  // verbatim into the buffer — and then submitted — on accept.
  const sanitizedGhost =
    self.input.buffer + stripGhostControlChars(ghost.slice(self.input.buffer.length));
  const next = InputCore.seed(sanitizedGhost);
  self.input = next;
  self.queued = false;
  self.activeGhost = null;
  updateAutocomplete(self);
  self.repaint();
  return true;
}
