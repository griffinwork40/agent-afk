/**
 * ReaderState — mutable per-read locals for readWithAutocompleteTty.
 *
 * Previously these lived as scattered `let` bindings inside the Promise
 * closure. Grouping them into an explicit object lets the module-level
 * helpers (`repaint`, `schedulePaint`, `applySelection`, `handleKeypress`)
 * accept them as an explicit parameter rather than closing over the
 * enclosing scope.
 *
 * Invariant: all fields are written ONLY by the exported helper functions;
 * `readWithAutocompleteTty` constructs and seeds the bag, then delegates
 * all mutations to the helpers.
 */

import type { InputCoreState } from '../input-core.js';
import type { AutocompleteState } from './autocomplete-state.js';
import type { ImageAttachment } from './attachments.js';

export interface ReaderState {
  /** Current text buffer + cursor position. */
  input: InputCoreState;
  /** Shared autocomplete dropdown state (candidates, selection, etc.). */
  ac: AutocompleteState;
  /** Number of dropdown rows currently drawn below the input line. */
  rowsBelow: number;
  /** Whether we are inside a bracketed-paste sequence. */
  pasting: boolean;
  /** Guard against concurrent osascript spawns on rapid Cmd+V / Ctrl+V. */
  clipboardInFlight: boolean;
  /** Buffer length at bracketed-paste start — detects empty image pastes. */
  pasteStartBufferLen: number;
  /** Visual rows occupied by the previous buffer render. */
  prevBufferRows: number;
  /** Status-line rows occupied by the previous render (0 or 1). */
  prevStatusRows: number;
  /** Ephemeral clipboard-error notice; cleared on next repaint. */
  clipboardFailureMsg: string | null;
  /** Ordered list of image attachments queued for this turn. */
  attachments: ImageAttachment[];
  /** Maximum dropdown rows to display at once. */
  maxDropdownRows: number;
  /** Timestamp of the last keypress (ms). Used for burst detection. */
  lastKeypressAt: number;
  /** Whether a repaint has been scheduled via setImmediate. */
  repaintPending: boolean;
  /**
   * COR-1 settled flag: set to true by cleanup() to prevent setImmediate
   * repaints from firing after the promise has resolved or rejected.
   */
  settled: boolean;
}
