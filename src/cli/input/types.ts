/**
 * Shared types for the raw-mode input box and its helpers.
 *
 * Kept in a leaf module so the trigger/dropdown/echo/raw-mode pieces of
 * `readWithAutocomplete` can import without inducing a cycle through the
 * orchestrator. Do NOT import from `./history.js` here — that would create
 * a cycle (history.ts → paths.ts; types.ts is a leaf). Use the structural
 * interface `IHistoryRing` instead.
 */

import type { Interface as ReadlineInterface } from 'readline';
import type { ImageAttachment } from './attachments.js';
import type { AutocompleteState } from './autocomplete-state.js';

/**
 * Structural interface for the history ring. Defined here (in the leaf
 * module) instead of importing `ReplHistory` directly so that this module
 * stays dependency-free and cycle-safe (COMPAT-1).
 *
 * `ReplHistory` satisfies this interface via TypeScript structural typing —
 * no explicit `implements` declaration is required.
 */
export interface IHistoryRing {
  back(draft: string): string | null;
  forward(): string | null;
  resetRecall(): void;
  readonly inRecall: boolean;
}

/**
 * Trigger kind for autocomplete: slash command, file path, or long flag.
 * Discriminated union so narrowing on `kind` gives the right payload.
 */
export type Trigger =
  | { kind: 'slash'; query: string }
  | { kind: 'file'; query: string }
  | { kind: 'flag'; command: string; query: string };

/**
 * Dropdown candidate with optional summary.
 */
export interface Candidate {
  value: string;
  summary?: string;
  /**
   * Optional "when to reach for this" guidance rendered as a tooltip row
   * beneath the dropdown when this candidate is selected. Longer than
   * `summary`; absent for file and flag candidates.
   */
  hint?: string;
}

export interface ReadWithAutocompleteOpts {
  rl: ReadlineInterface;
  promptFn: () => string;
  /**
   * Invoked when the user presses Ctrl+C.
   *
   * - On TTY: replaces the default abort behavior — the prompt stays open.
   * - On non-TTY: a process-level SIGINT handler is installed for the
   *   duration of the read so the contract holds across both surfaces.
   */
  onSigint?: () => void;
  /**
   * Pre-seeds the input buffer. Used by the REPL to carry a queued-during-
   * streaming message into the next prompt so the user can review/edit it
   * and then submit with Enter.
   */
  initialBuffer?: string;
  /**
   * Invoked when the user presses Shift+Tab (sequence `\x1b[Z` or
   * `{ shift: true, name: 'tab' }`). Used by the REPL to toggle plan mode
   * without requiring the user to type a slash command.
   *
   * Only fires on the TTY path — non-TTY input never generates keypresses.
   */
  onShiftTab?: () => void;
  /**
   * History ring loaded at REPL bootstrap. When provided, ↑/Ctrl+P and
   * ↓/Ctrl+N recall/forward through previous submissions. Optional so
   * existing callers (tests, non-REPL surfaces) are unaffected.
   *
   * Typed as the structural `IHistoryRing` interface (not the concrete
   * `ReplHistory` class) to keep `types.ts` cycle-free (COMPAT-1).
   */
  history?: IHistoryRing;

  /**
   * When provided and `isArmed()` returns true, `enterRawMode` is skipped
   * — the compositor already owns raw mode. Defensive guard; in practice
   * the compositor is always disarmed during between-turn reads.
   */
  compositor?: { isArmed(): boolean };

  /**
   * Shared autocomplete dropdown state. When provided, `readWithAutocompleteTty`
   * reads and writes this object instead of its own `let` locals, so dropdown
   * state (candidates, selectedIndex, suppressedSignature, etc.) is consistent
   * across user-turn and agent-turn surfaces. `reset()` is called at the start
   * of each user-turn read so stale state from the compositor turn does not leak.
   *
   * When absent, a fresh local state is used (backward-compatible).
   */
  autocompleteState?: AutocompleteState;

  /**
   * When provided, `setExtraRows(prior + 1)` is called before the read and
   * restored to `prior` in the finally block, reserving the bottom row for
   * the composer prompt via DECSTBM scroll-region. The optional
   * `withFullScrollRegion` is consulted when `onSubmit` writes the echo
   * line — temporarily resetting DECSTBM so the `\n` produces a
   * scrollback-bound full-screen scroll rather than a sub-region scroll
   * (which on xterm-derived terminals would discard displaced lines).
   */
  statusLine?: {
    getExtraRows(): number;
    setExtraRows(n: number): void;
    withFullScrollRegion?<T>(fn: () => T): T;
  };
}

export interface ReadWithAutocompleteResult {
  text: string;
  attachments: ImageAttachment[];
}

/** Shape of a `keypress` event payload from `readline.emitKeypressEvents`. */
export interface KeyInfo {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}
