/**
 * Interrupt-and-steer picker — shown on the FIRST Ctrl+C during an active
 * turn, giving the user a deliberate choice instead of an immediate stop.
 *
 * UX contract:
 *   - 1st Ctrl+C → show this picker (Stop / Steer / Cancel)
 *   - 2nd Ctrl+C while picker is open → hard-cancel immediately (safety hatch)
 *   - Picker dismisses cleanly if the turn completes while it is open
 *   - Esc inside the picker = "Cancel" (dismiss without action)
 *
 * The picker runs entirely through the compositor's existing picker-mode
 * machinery so no second stdin listener is ever installed (single-consumer
 * stdin invariant, #511).
 *
 */

import { runPicker } from '../../render/picker.js';
import { palette } from '../../palette.js';
import type { TerminalCompositor } from '../../terminal-compositor.js';
import type { TurnState } from './repl-loop-shared.js';

/** Possible outcomes of the interrupt picker. */
export type InterruptChoice = 'stop' | 'cancel' | 'steer' | 'dismissed';

/**
 * Options for {@link showInterruptPicker}. All callbacks are called
 * synchronously on the SAME microtask where the choice resolves —
 * the compositor has already exited picker mode before any callback fires.
 */
export interface InterruptPickerOptions {
  /** The active turn's compositor (must be armed in streaming mode). */
  compositor: TerminalCompositor;
  /**
   * Abort signal — fired by the caller when the picker should dismiss
   * automatically (turn completed, renderer disposed, session ended).
   * Resolves with 'dismissed'.
   */
  signal: AbortSignal;
  /**
   * Called when the user selects "Stop" (soft-stop, keeps completed work).
   * Mirrors the existing ESC soft-stop path.
   */
  onStop: () => void;
  /**
   * Called when the user selects "Cancel" (hard-cancel, exits immediately).
   * Mirrors the existing double-Ctrl+C path.
   */
  onCancel: () => void;
  /**
   * Called when the user selects "Steer" (redirect the agent mid-turn).
   * `onStop()` fires first (soft-stop), then `onSteer()` — so even if the
   * steer readline is abandoned, the turn is already gracefully stopped.
   * Fire-and-forget: this callback may initiate async readline work.
   */
  onSteer?: () => void;
}

// Option labels (visible in the picker UI).
const LABEL_STOP = 'Stop  — keep work so far, return to prompt';
const LABEL_CANCEL = 'Cancel — hard-cancel (same as Ctrl+C again)';
const LABEL_STEER = 'Steer  — redirect the agent mid-turn';

const HEADER = [
  palette.warning('⚠ ') + palette.bold('Turn interrupted — what would you like to do?'),
  palette.dim('  (Ctrl+C again = immediate cancel)'),
];

const OPTIONS = [LABEL_STOP, LABEL_STEER, LABEL_CANCEL];

/**
 * Display the interrupt-and-steer picker and handle the chosen action.
 *
 * Returns the chosen action:
 * - `'stop'`      — user selected Stop (soft-stop fired via `onStop`)
 * - `'steer'`     — user selected Steer (`onStop()` fired first for soft-stop,
 *                    then `onSteer?.()` fires to initiate the redirect readline)
 * - `'cancel'`    — user selected Cancel (hard-cancel fired via `onCancel`)
 * - `'dismissed'` — picker aborted externally (turn ended while open)
 *
 * Contract: never rejects. On any exception the picker aborts silently and
 * 'dismissed' is returned so the SIGINT handler degrades to its prior behavior.
 *
 * Steer path:
 *   1. `onStop()` fires synchronously first (soft-stop: keeps completed work,
 *      returns to prompt on completion).
 *   2. `onSteer?.()` fires next (fire-and-forget): the callback reads a redirect
 *      message from the user and sets `turnState.pendingSteerText`, which the
 *      `runInputLoop` while-body drains on the next iteration.
 *   3. An empty redirect message (ESC or empty Enter) degrades to pure Stop
 *      behavior — the turn was already soft-stopped in step 1.
 */
export async function showInterruptPicker(
  opts: InterruptPickerOptions,
): Promise<InterruptChoice> {
  const { compositor, signal, onStop, onCancel, onSteer } = opts;

  if (signal.aborted) return 'dismissed';

  // Commit a blank line above the overlay before entering picker mode so the
  // picker header has visual breathing room from the last streamed line.
  try {
    compositor.commitAbove('');
  } catch {
    // commitAbove can throw if the compositor just got disposed — treat as
    // 'dismissed' (the turn ended before we could show the picker).
    return 'dismissed';
  }

  let result: readonly string[] | null;
  try {
    result = await runPicker(compositor, {
      header: HEADER,
      options: OPTIONS,
      signal,
      // Ctrl+C inside the picker fires hard-cancel immediately (safety hatch).
      // Without this, Ctrl+C would resolve null and be indistinguishable from
      // Esc — the hard-cancel path would be unreachable while the picker is open.
      onCtrlC: onCancel,
    });
  } catch {
    // runPicker should never reject, but be defensive.
    return 'dismissed';
  }

  if (result === null) {
    // Esc / Ctrl+C / abort signal / external dismiss — no further action needed
    // (onCtrlC already fired hard-cancel synchronously for the Ctrl+C case).
    return 'dismissed';
  }

  const chosen = result[0];

  if (chosen === LABEL_STOP) {
    onStop();
    return 'stop';
  }
  if (chosen === LABEL_STEER) {
    // Soft-stop first so the turn starts winding down regardless of what the
    // user types in the steer readline — even an abandoned or empty steer
    // degrades to pure Stop behavior.
    onStop();
    // Fire-and-forget: the steer readline runs asynchronously; the caller
    // (launchInterruptPicker / interactive.ts onSteer) owns the async chain.
    onSteer?.();
    return 'steer';
  }
  if (chosen === LABEL_CANCEL) {
    onCancel();
    return 'cancel';
  }

  // Unknown label (shouldn't happen) — dismiss.
  return 'dismissed';
}

/**
 * Options for {@link launchInterruptPicker}. Callers supply the minimal
 * surface they own (compositor, turnState, action callbacks) and the launcher
 * handles AbortController lifecycle, picker display, and cleanup.
 */
export interface LaunchInterruptPickerOptions {
  /** The active turn's compositor (must be armed in streaming mode). */
  compositor: TerminalCompositor;
  /**
   * The REPL's mutable turn state. The launcher sets and clears
   * `turnState.interruptPickerAbort` to track whether a picker is open.
   */
  turnState: TurnState;
  /**
   * Fire the soft-stop action (mirrors ESC: keep work so far, return to prompt).
   * Called when the user selects "Stop" in the picker.
   */
  onStop: () => void;
  /**
   * Fire the hard-cancel action (same as double-Ctrl+C: abort + close rl).
   * Called when the user selects "Cancel" in the picker.
   */
  onCancel: () => void;
  /**
   * Fire the steer action (redirect the agent mid-turn). `onStop()` fires
   * first (soft-stop) before this callback is invoked. Fire-and-forget:
   * this callback may initiate async readline work.
   *
   * IMPORTANT: The `onSteer` callback is responsible for clearing
   * `turnState.interruptPickerAbort` AFTER the steer readline settles —
   * the `.then()` cleanup in `launchInterruptPicker` defers the clear for
   * the `'steer'` path so the abort controller remains live throughout the
   * readline (second-Ctrl+C safety hatch).
   */
  onSteer?: () => void;
}

/**
 * Launch the interrupt-and-steer picker asynchronously.
 *
 * Creates an AbortController, stores it on `turnState.interruptPickerAbort`
 * (so a second Ctrl+C can abort the picker), shows the picker, fires the
 * chosen action callback, and clears the stored controller when done.
 *
 * Contract: synchronous return — SIGINT handlers must never await. The picker
 * runs in the background via a `void`-dispatched promise chain; the chosen
 * action fires on the microtask where `runPicker` resolves.
 */
export function launchInterruptPicker(opts: LaunchInterruptPickerOptions): void {
  const { compositor, turnState, onStop, onCancel, onSteer } = opts;
  const pickerAbort = new AbortController();
  turnState.interruptPickerAbort = pickerAbort;

  void showInterruptPicker({
    compositor,
    signal: pickerAbort.signal,
    onStop,
    onCancel,
    onSteer,
  }).then((choice) => {
    // For the 'steer' path, defer clearing interruptPickerAbort to the
    // onSteer callback itself (after the readline settles). This keeps the
    // abort controller live throughout the steer readline so a second Ctrl+C
    // can hard-cancel during the readline (safety hatch).
    //
    // For all other paths (stop, cancel, dismissed), clear immediately.
    if (choice !== 'steer') {
      if (turnState.interruptPickerAbort === pickerAbort) {
        turnState.interruptPickerAbort = null;
      }
    }
  });
}
