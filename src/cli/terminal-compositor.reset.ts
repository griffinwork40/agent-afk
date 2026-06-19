/**
 * State reset — `resetState`, extracted from terminal-compositor.ts
 * (free-functions-on-host pattern; see sibling lifecycle/frame/paste modules).
 * The class owns all state; this function clears the narrow {@link ResetStateHost}
 * slice passed as `self` back to its armed-cycle defaults. Called by
 * {@link ./terminal-compositor.lifecycle.ts | Lifecycle.disarm} AND by internal
 * state-resets that keep the suggest engine alive. No behavior change — the body
 * is a byte-for-byte move with `this.` rewritten to `self.`.
 */

import { InputCore, type InputCoreState } from './input-core.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { ImageAttachment } from './input/attachments.js';
import type { CompositorInputMode, PickerController, SubmissionPayload } from './terminal-compositor.types.js';

/**
 * Narrowest TerminalCompositor state slice {@link resetState} clears. Spans the
 * overlay / input / paste / committed-band / resize fields that must return to
 * armed-cycle defaults between disarm and rearm. `pasteRegistry` and
 * `autocompleteState` keep a readonly reference (mutated in place via
 * `.clear()` / `.reset()`); `clearCommittedBand` is the class delegator this
 * function calls back into. Field semantics are documented authoritatively on
 * the class declarations in terminal-compositor.ts; this is a structural mirror.
 */
export interface ResetStateHost {
  clearCommittedBand(): void;

  overlay: string;
  input: InputCoreState;
  queued: boolean;
  pendingSubmissions: SubmissionPayload[];
  canceled: boolean;
  backgrounded: boolean;
  softStopped: boolean;
  paused: boolean;
  activeGhost: string | null;
  anchorRow: number | undefined;
  hasCommitted: boolean;
  commitInFlight: boolean;
  pendingResizeErase: { top: number; bottom: number } | null;
  lastKnownRows: number;
  pickerController: PickerController | null;
  inputMode: CompositorInputMode;
  attachments: ImageAttachment[];
  pasting: boolean;
  pasteStartBufferLen: number;
  pasteStartCursor: number;
  readonly pasteRegistry: Map<string, string>;
  clipboardFailureMsg: string | null;
  readonly autocompleteState?: AutocompleteState;
  resizeUnsub: (() => void) | null;
  resizeImmediateUnsub: (() => void) | null;
}

export function resetState(self: ResetStateHost): void {
  self.overlay = '';
  self.input = InputCore.seed('');
  self.queued = false;
  // Drop any queued-but-undrained messages — a disarm/rearm cycle (skill
  // dispatchers, tests, session swap) must not carry stale type-ahead into
  // the next compose window.
  self.pendingSubmissions = [];
  self.canceled = false;
  self.backgrounded = false;
  self.softStopped = false;
  self.paused = false;
  // Clear active ghost — stale suggestions must not survive a disarm/rearm
  // cycle. The engine itself is NOT disposed here (only in disarm) since
  // resetState() is called by both disarm() AND internal state-resets that
  // keep the engine alive (e.g. idle→streaming transition after submit).
  self.activeGhost = null;
  // Clear the working anchor — `repaint()` may have shifted it up during
  // eviction (e.g. declared 15 → working 11 after pushing 4 rows into
  // scrollback). The shifted value is per-cycle state; leaving it set
  // across disarm/rearm would silently under-protect the declared ceiling
  // on the next arm. `arm()` re-seeds from `declaredAnchorRow`.
  self.anchorRow = undefined;
  // Reset commit-presence flag so growthDeficit in repaint() does not fire
  // on the new arm cycle until a commit actually happens.
  self.hasCommitted = false;
  // Drop any retained above-frame committed block + the in-flight commit guard
  // so a fresh arm cycle never re-pins stale transcript from the previous one.
  self.clearCommittedBand();
  self.commitInFlight = false;
  // Drop resize ghost-erase state — a pending erase or stale row count from
  // the previous arm cycle must not leak into the next one (the first repaint
  // of a fresh arm re-seeds lastKnownRows before any resize can be detected).
  self.pendingResizeErase = null;
  self.lastKnownRows = 0;
  // Drop any active picker — a disarm during a picker would leave
  // the controller's resolve callback orphaned. The runPicker abort
  // path normally exits the picker first; this is defence-in-depth
  // for a hard disarm (process termination, swap path).
  self.pickerController = null;
  self.inputMode = 'streaming';
  // Reset attachment + paste state — between full disarm/rearm cycles
  // (skill dispatchers, tests) we must not carry stale clipboard
  // artifacts into the next session.
  self.attachments = [];
  self.pasting = false;
  self.pasteStartBufferLen = 0;
  self.pasteStartCursor = 0;
  self.pasteRegistry.clear();
  self.clipboardFailureMsg = null;
  // clipboardInFlight is NOT reset — an in-flight osascript probe is
  // tied to a Promise that will resolve/reject independently. Setting
  // the flag to false here would allow a new probe to spawn while the
  // old one's `.finally` is pending, defeating the guard.
  // Reset shared autocomplete state so stale dropdown chrome from this
  // agent turn does not leak into the next user-turn read.
  self.autocompleteState?.reset();
  if (self.resizeUnsub) {
    self.resizeUnsub();
    self.resizeUnsub = null;
  }
  if (self.resizeImmediateUnsub) {
    self.resizeImmediateUnsub();
    self.resizeImmediateUnsub = null;
  }
}
