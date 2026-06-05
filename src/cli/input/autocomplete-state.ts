/**
 * AutocompleteState — shared dropdown state for the unified InputSurface.
 *
 * Previously these six `let` locals lived inside the Promise closure in
 * `reader.ts`. Lifting them here lets both the user-turn surface
 * (`readWithAutocompleteTty`) and the agent-turn surface
 * (`TerminalCompositor`) read/write the same dropdown state across turn
 * boundaries, so ↑/↓ history and `/` autocomplete are consistent regardless
 * of whose turn it is.
 *
 * Invariants:
 *   - `candidates` is always valid for `selectedIndex` and `viewportStart`.
 *   - `dropdownOpen` is only true when `candidates.length > 0`.
 *   - `suppressedSignature` is cleared whenever buffer or cursor changes.
 *
 * Reset semantics: `reset()` restores the state to the post-arm initial
 * values.  Call it at the start of each user-turn read so a partially-open
 * dropdown from a prior session does not leak into the next prompt.
 */

import type { Candidate, Trigger } from './types.js';

export interface AutocompleteState {
  dropdownOpen: boolean;
  candidates: Candidate[];
  selectedIndex: number;
  viewportStart: number;
  /** Non-null when the user hit Escape on an open dropdown; see reader.ts for semantics. */
  suppressedSignature: string | null;
  trigger: Trigger | null;
  /** Reset all fields to their initial (closed) values. */
  reset(): void;
}

/**
 * Create a fresh, shareable AutocompleteState.
 * Instantiate once per REPL session (in `runReplLoop`) alongside `ReplHistory`.
 */
export function createAutocompleteState(): AutocompleteState {
  const state: AutocompleteState = {
    dropdownOpen: false,
    candidates: [],
    selectedIndex: 0,
    viewportStart: 0,
    suppressedSignature: null,
    trigger: null,
    reset() {
      state.dropdownOpen = false;
      state.candidates = [];
      state.selectedIndex = 0;
      state.viewportStart = 0;
      state.suppressedSignature = null;
      state.trigger = null;
    },
  };
  return state;
}
