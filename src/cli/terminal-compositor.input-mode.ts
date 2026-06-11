/**
 * Input-mode state machine — `setInputMode`, `getInputMode`, `enterPickerMode`,
 * `exitPickerMode`, and `repaintPicker` — extracted from terminal-compositor.ts.
 * Follows the free-functions-on-host pattern used by the sibling
 * paste/autocomplete/render/committed-band/input-dispatch modules: the
 * TerminalCompositor owns all state; these functions read and MUTATE the narrow
 * {@link InputModeHost} slice it passes as `self`. No behavior change — bodies
 * are byte-for-byte moves with `this.` rewritten to `self.`.
 */

import { InputCore, type InputCoreState } from './input-core.js';
import type { ImageAttachment } from './input/attachments.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import * as Paste from './terminal-compositor.paste.js';
import type {
  CompositorInputMode,
  PickerController,
  SubmissionPayload,
} from './terminal-compositor.types.js';

/**
 * Narrowest TerminalCompositor state slice the input-mode functions touch.
 * Mode/flag/buffer fields are mutated in place; `repaint` is a class method
 * the functions call back into; `autocompleteState` and `onSubmit` are
 * readonly references whose objects/callbacks are invoked through the reference.
 */
export interface InputModeHost {
  /** Re-render the live frame. */
  repaint(): void;

  /** Current input mode — mutated by setInputMode and enterPickerMode/exitPickerMode. */
  inputMode: CompositorInputMode;

  /** Saved mode from before enterPickerMode; restored by exitPickerMode. */
  pickerSavedMode: CompositorInputMode;

  /** Active picker controller — non-null iff inputMode === 'picker'. */
  pickerController: PickerController | null;

  /** Autocomplete state — reset() called on certain mode transitions. */
  readonly autocompleteState?: AutocompleteState;

  /** Once-only ESC soft-stop guard. */
  softStopped: boolean;

  /** Hard-abort flag (Ctrl+C in streaming mode). */
  canceled: boolean;

  /** Once-only Ctrl+B background guard. */
  backgrounded: boolean;

  /** Whether the buffer is queued for submission. */
  queued: boolean;

  /** Live input buffer. */
  input: InputCoreState;

  /** Image attachments accumulated this compose window. */
  attachments: ImageAttachment[];

  /** Side-table for truncated pastes; cleared on submit. */
  readonly pasteRegistry: Map<string, string>;

  /** Insertion cursor snapshotted at bracketed-paste start (required by PasteHost). */
  readonly pasteStartCursor: number;

  /** Submission handler — may be absent (legacy getBuffer() path). */
  readonly onSubmit?: (payload: SubmissionPayload) => void;
}

/**
 * Rent the input region to a picker overlay — see {@link PickerController}.
 * While active, the compositor's input buffer + dropdown + hint rows are
 * hidden, and all keystrokes route to `controller.onKey`. The picker is
 * responsible for its own cancel/confirm semantics; the compositor offers
 * no Enter/Esc defaults in picker mode.
 *
 * Invariant: the autocomplete dropdown must NOT bleed into the picker frame,
 * so this method calls `autocompleteState?.reset()`. The previous `inputMode`
 * is saved and restored by {@link exitPickerMode}.
 *
 * @throws if a picker is already active (callers must `exitPickerMode`
 * before installing a new controller).
 */
export function enterPickerMode(self: InputModeHost, controller: PickerController): void {
  if (self.pickerController) {
    throw new Error('enterPickerMode: a picker is already active; call exitPickerMode first');
  }
  self.pickerSavedMode = self.inputMode;
  self.pickerController = controller;
  self.inputMode = 'picker';
  // Clear the autocomplete dropdown so its rows don't render on top
  // of the picker frame (see compositor risk #2 in the integration
  // brief — repaint composes dropdown rows from autocompleteState
  // and ignores inputMode otherwise).
  self.autocompleteState?.reset();
  self.repaint();
}

/**
 * Exit picker mode and restore the previous input mode. The picker
 * controller is cleared and the compositor resumes rendering its
 * own input buffer + dropdown rows.
 *
 * No-op when no picker is active (idempotent — safe to call from
 * cleanup paths that don't know whether `enterPickerMode` was reached).
 */
export function exitPickerMode(self: InputModeHost): void {
  if (!self.pickerController) return;
  self.pickerController = null;
  self.inputMode = self.pickerSavedMode;
  self.repaint();
}

/**
 * Force a repaint while the picker is active. The picker calls
 * this after mutating its internal selection state so the next
 * `renderRows()` invocation reflects the new state.
 *
 * No-op when no picker is active (defence-in-depth — a late repaint
 * from a cancelled picker won't double-render the input row).
 */
export function repaintPicker(self: InputModeHost): void {
  if (!self.pickerController) return;
  self.repaint();
}

/**
 * Invariant: in the `→ 'idle'` flush path with `queued && onSubmit`, fire
 * `onSubmit(buffer)` BEFORE clearing `queued` and the buffer (teardown-
 * before-setup; otherwise a reentrant onSubmit observes stale state).
 *
 * Transition input mode. Default is `'streaming'`; the persistent
 * InputSurface flips to `'idle'` between turns and back to
 * `'streaming'` at turn start.
 *
 * ## Ordered operation
 *
 * External constraint: `→ 'idle'` with `queued && onSubmit` MUST
 * fire `onSubmit(buffer)` BEFORE clearing `queued` and the buffer.
 * Otherwise a reentrant `onSubmit` handler (e.g. one that
 * synchronously calls `setInputMode('streaming')` again) would
 * observe stale state. Mirror of the teardown-before-setup
 * invariant on TUI lifecycle ops.
 *
 * ## Flush semantics (mode → idle)
 *
 * Fires on ANY transition to idle while queued + handler are both
 * set, not just `streaming → idle`. The `idle → idle` case covers
 * a race where the user types-and-Enters in the brief window
 * between a previous `readLine` resolving and the next one
 * installing a handler: the Enter falls through to the streaming-
 * queue branch (sets `queued=true`), and the next `readLine`'s
 * `setInputMode('idle')` is what fires the synthesized submission.
 * Without this widening, the queued buffer would be stranded until
 * the user pressed Enter a second time.
 */
export function setInputMode(self: InputModeHost, mode: CompositorInputMode): void {
  const prev = self.inputMode;
  self.inputMode = mode;
  // idle → streaming: clear the once-only canceled/backgrounded/softStopped
  // guards so the new turn can be interrupted (ESC/Ctrl+C) and/or
  // backgrounded (Ctrl+B). Without this reset, a Ctrl+C or ESC between two
  // turns would arm the once-only flag in the second turn, breaking
  // ESC/Ctrl+C mid-stream forever after.
  if (prev === 'idle' && mode === 'streaming') {
    self.canceled = false;
    self.backgrounded = false;
    self.softStopped = false;
    // Reset autocomplete at the idle→streaming transition so any
    // open dropdown rows are not rendered into the first streaming
    // frame. Mirrors the reset in the idle Enter handler above.
    // Both sites are needed: the Enter handler fires when onSubmit is
    // installed (persistent InputSurface path); this branch fires when
    // the caller drives mode directly (e.g. slash-command dispatcher
    // calling setInputMode('streaming') from outside readLine).
    self.autocompleteState?.reset();
    self.repaint();
    return;
  }
  // Invariant: a buffer queued during or after an ESC soft-stop MUST NOT
  // auto-flush as a phantom next turn, AND `softStopped` MUST be cleared at
  // this first →idle transition (NOT left to persist until the next arm).
  // `softStopped` is set only by ESC, and its ONLY function is the once-only
  // ESC guard during streaming (handleEscape ~line 1937); in idle, ESC
  // returns early (line ~1920) before that guard, so a lingering value has
  // no legitimate effect. We clear the queued FLAG here (buffer text +
  // attachments preserved) so the post-ESC draft stays visible + editable in
  // the idle input row and waits for an explicit Enter instead of
  // auto-submitting — a stream interruption should preserve in-progress
  // input, not fling it as a turn the user never confirmed. This fires at
  // the dispose→idle transition (streaming→idle).
  //
  // Why clear softStopped HERE (the fix): if it persists into the idle
  // period, it poisons the user's NEXT message. After an EMPTY-buffer ESC
  // (the common "just stop the agent" case) `queued` stays false, so the old
  // `&& this.queued` guard never fired and softStopped survived the dispose.
  // The user then types a new message in the brief inter-readLine window
  // (onSubmit not yet installed → Enter queues it); the following
  // readLine→idle would re-enter this guard (softStopped && queued both
  // true) and SILENTLY DE-QUEUE the message — it "looks like it sends" but
  // no turn starts, and the user must send again (a per-stop off-by-one that
  // reads as session-wide lag). Dropping the `&& this.queued` condition and
  // resetting softStopped here bounds its lifetime to the stopped turn, so
  // idle-window submissions flush normally via the branch below.
  //
  // Without this guard at all: session.interrupt() is deferred to the next
  // stream event (turn-handler.ts:236 / run-skill-dispatch-turn.ts:143), so
  // the compositor stays in streaming mode for a network-latency window. An
  // Enter pressed in that window queues the buffer; the widened any→idle
  // flush below then auto-fires it as an unconfirmed turn, and every message
  // the user types during THAT turn queues in turn — a perpetual
  // input-lag-of-one (each message submits one turn late) for the rest of
  // the session. See terminal-compositor.test.ts soft-stop drain tests.
  //
  // ESC-only: Ctrl+C intentionally uses the legacy path — handleInterrupt
  // (~line 1937) queues the buffer and fires onCancel; the widened any→idle
  // flush below auto-submits it as the next turn. ESC preserves the draft
  // for explicit (manual) submission; Ctrl+C auto-submits it. (see handleInterrupt ~line 1937-1957)
  if (mode === 'idle' && self.softStopped) {
    self.queued = false;
    self.softStopped = false;
    // Always repaint: the `[queued]` glyph must clear even on an
    // idle→idle transition (the flush branch below repaints
    // unconditionally for the same reason).
    self.repaint();
    return;
  }
  // → idle with queued buffer + handler: flush. Widened from
  // streaming→idle to any→idle to cover the inter-readLine race
  // (see jsdoc above). Buffer-empty + attachment-empty queues are
  // ignored — Enter on a fully-empty input is suppressed at the
  // keypress level (compositor.ts:1148) so this branch only fires
  // when there's something meaningful to submit.
  if (mode === 'idle' && self.queued && self.onSubmit) {
    // displayText keeps the placeholder representation (for the
    // scrollback echo); text is the expanded form (for the model).
    // When no truncation happened the two are byte-equal and
    // displayText is omitted from the payload to keep existing
    // call-sites that deep-match on { text, attachments } happy.
    const displayText = self.input.buffer;
    const expandedText = Paste.expandPastePlaceholders(self, displayText);
    const attachments = [...self.attachments];
    const handler = self.onSubmit;
    // Clear local state BEFORE invoking the handler so a reentrant
    // call back into this compositor (e.g. handler triggers another
    // setInputMode) does not double-fire on the same buffer.
    self.queued = false;
    self.input = InputCore.seed('');
    self.attachments = [];
    self.pasteRegistry.clear();
    self.repaint();
    handler(
      expandedText === displayText
        ? { text: expandedText, attachments }
        : { text: expandedText, displayText, attachments },
    );
    return;
  }
  // Other transitions (idle→idle without queue, streaming→streaming,
  // → idle without handler) just record the new mode. A → idle with
  // queued but no handler is a no-op — the buffer stays queued
  // (matches the legacy contract where the parent reads via
  // getBuffer()).
  if (prev !== mode) self.repaint();
}

/**
 * Current input mode. Surfaced for tests + the InputSurface idle
 * check; not consumed by any production code path inside the
 * compositor outside of {@link setInputMode}.
 */
export function getInputMode(self: InputModeHost): CompositorInputMode {
  return self.inputMode;
}
