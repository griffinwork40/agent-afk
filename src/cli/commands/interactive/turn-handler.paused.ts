/**
 * Usage-limit pause handler for the interactive turn loop.
 *
 * Extracted from turn-handler.ts to keep that file within the baseline
 * code-line ceiling. Handles the `paused` event emitted by the provider
 * layer when an OAuth subscription limit is hit — either showing an
 * interactive picker (TTY + autoResume) or a passive info card (non-TTY /
 * autoResume=false).
 */

import type { OutputEvent } from '../../../agent/types.js';
import type { AgentSession } from '../../../agent/session.js';
import type { CompletionWriter } from './shared.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';
import { palette } from '../../palette.js';
import { isDebugEnabled } from '../../../utils/debug.js';
import { usageLimitBox } from '../../render.js';
import { runPicker } from '../../render/picker.js';

/** Narrowed event type for the `paused` output event. */
export type PausedEvent = Extract<OutputEvent, { type: 'paused' }>;

/**
 * Mutable ref that tracks the AbortController for any open usage-limit
 * picker. Stored as an object so TypeScript's control-flow narrowing does
 * not collapse the type in the `finally` block after async `.then()` writes.
 */
export interface PausedPickerRef {
  abort: AbortController | null;
}

/**
 * Parameters for {@link handlePausedEvent}.
 *
 * Invariant: every value must be cheap to pass — no closures over turn-local
 * state; mutations are communicated back via callbacks (`onPauseInterrupt`,
 * `setPausedState`) so the caller retains ownership of the interrupted flag.
 */
export interface HandlePausedEventParams {
  /** The `paused` output event. */
  event: PausedEvent;
  /** The session — used only to fire `interrupt()` on user choice. */
  session: AgentSession;
  /**
   * The REPL's persistent compositor when available (TTY path). When null
   * the interactive picker is not shown and the passive card is rendered
   * instead (non-TTY / legacy path).
   */
  borrowedCompositor: TerminalCompositor | null;
  /**
   * Mutable ref for the open picker's AbortController. The caller creates
   * this object; this function writes `abort` into it when a picker is shown
   * and clears it when the `.then()` resolves (whether aborted or not).
   */
  pickerRef: PausedPickerRef;
  /**
   * Optional completion writer — routes output through the compositor's
   * `commitAbove` when armed, or falls back to `console.log` when null.
   */
  completionWriter: CompletionWriter | undefined;
  /**
   * Async cleanup: disarm the current renderer before any raw console
   * output so the "Usage paused" panel doesn't tear the live overlay.
   */
  disposeRendererOnce: () => Promise<void>;
  /**
   * Mark the compositor as paused so a submitted line ends the wait (via
   * the pause-interrupt handler + input-dispatch Enter path) instead of
   * sitting queued behind the auto-resume. Must be cleared on resumed /
   * turn-end (caller's responsibility).
   */
  setPausedState: ((paused: boolean) => void) | undefined;
  /**
   * Callback fired when the user chooses "Switch model / Stop waiting" in
   * the interactive picker. Sets the caller's `pauseInterruptRequested`
   * flag so the for-await loop breaks and `recordTurn` is skipped.
   */
  onPauseInterrupt: () => void;
}

// Option labels — defined at module scope so the `.then()` match is
// co-located with the definition and can never drift apart.
const KEEP_LABEL_BASE = 'Keep waiting — auto-resume in progress';
const SWITCH_MODEL_LABEL = 'Switch model / provider  (type /model after)';
const STOP_LABEL = 'Stop waiting';

/**
 * Handle a `paused` event from the interactive turn stream.
 *
 * Contract: the interactive picker REPLACES the passive card when a TTY
 * compositor is armed (`borrowedCompositor != null`) AND `autoResume === true`
 * — i.e. there is a live wait to make a decision about. The two are mutually
 * exclusive: showing both would duplicate the same options (prose card + menu).
 * Non-TTY surfaces and `autoResume=false` fall through to the passive card,
 * which is the only possible surface there.
 *
 * Invariant: the renderer must be disposed BEFORE raw console output so the
 * card doesn't tear the live overlay. The caller's `disposeRendererOnce` is
 * awaited first.
 */
export async function handlePausedEvent(params: HandlePausedEventParams): Promise<void> {
  const {
    event,
    session,
    borrowedCompositor,
    pickerRef,
    completionWriter,
    disposeRendererOnce,
    setPausedState,
    onPauseInterrupt,
  } = params;

  // Mark the compositor paused so a submitted line ends the wait (via
  // the pause-interrupt handler + input-dispatch Enter path) instead of
  // sitting queued behind the auto-resume. Cleared on resumed / finally.
  setPausedState?.(true);

  // Disarm before raw console output so the card doesn't tear the
  // live overlay. Auto-resume path continues — the provider is now
  // waiting; the stream will deliver a 'resumed' event when ready,
  // at which point we rebuild a fresh renderer for the replayed turn.
  await disposeRendererOnce();

  if (borrowedCompositor && event.autoResume === true) {
    const ac = new AbortController();
    pickerRef.abort = ac;

    const resetsAtStr = event.resetsAt
      ? event.resetsAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : null;

    // Keep label incorporates the reset time when available so the user
    // can see at a glance how long they'll be waiting.
    const keepLabel = resetsAtStr
      ? `Keep waiting — auto-resumes at ${resetsAtStr}`
      : KEEP_LABEL_BASE;

    // Contract: the picker header carries the context the passive card
    // would have shown (limit + reset time) plus the out-of-band
    // account-switch tip — "switch account" is NOT a selectable option
    // because it happens via `claude login` in another terminal during
    // the wait, which the keychain hot-swap picks up automatically.
    // Options are ordered by increasing disruption so the safe default
    // (keep waiting) is first and pre-selected.
    const header = [
      palette.warning('  ⏳ Usage limit reached.') +
        (resetsAtStr ? palette.dim(`  Auto-resumes at ${resetsAtStr}.`) : ''),
      palette.dim('  Tip: run `claude login` in another terminal to switch account — this turn resumes on it automatically.'),
      '',
    ];

    void runPicker(borrowedCompositor, {
      header,
      options: [keepLabel, SWITCH_MODEL_LABEL, STOP_LABEL],
      signal: ac.signal,
      initialIndex: 0,
    }).then((result) => {
      // Picker resolved — null means aborted (resumed/turn-end tore it
      // down); any result means the user made an explicit choice.
      pickerRef.abort = null;
      if (!result) return; // aborted — no action needed

      const choice = result[0];
      if (choice === undefined || choice === keepLabel) {
        // Keep waiting (or a defensive undefined): the auto-resume path
        // continues unchanged; Enter-during-pause path stays live.
        return;
      }

      // Switch model / Stop waiting: end the wait via the pause-interrupt
      // path (same mechanism as Enter-during-pause). session.interrupt()
      // ends the stream; pauseInterruptRequested breaks the for-await loop
      // so recordTurn is skipped and the queued buffer flushes next turn.
      onPauseInterrupt();
      if (choice === SWITCH_MODEL_LABEL) {
        // Cannot pre-fill the input buffer (no public buffer-set API on
        // the compositor), so guide with a printed hint instead.
        (completionWriter ?? { fn: console.log }).fn(
          palette.dim('  Hint: type /model <name> to switch, then send your message again.'),
        );
      }
      session.interrupt().catch((err) => {
        if (isDebugEnabled()) {
          console.error('  ' + palette.error('picker pause-interrupt session.interrupt() failed:'), err);
        }
      });
    }).catch((err) => {
      // Defensive: runPicker never rejects, but the .then() body calls
      // completionWriter.fn (→ compositor.commitAbove), which can throw
      // mid-teardown. Swallow outside debug so a throw here can't surface
      // as an unhandled rejection (the REPL has no process-level handler).
      if (isDebugEnabled()) {
        console.error('  ' + palette.error('picker promise rejected:'), err);
      }
    });
  } else {
    // Passive card — the only surface when no interactive picker applies
    // (non-TTY, or autoResume=false where there is no wait to decide on).
    (completionWriter ?? { fn: console.log }).fn(usageLimitBox({
      reason: event.reason,
      ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}),
      ...(event.accountId !== undefined ? { accountId: event.accountId } : {}),
      ...(event.autoResume !== undefined ? { autoResume: event.autoResume } : {}),
    }));
  }
}
