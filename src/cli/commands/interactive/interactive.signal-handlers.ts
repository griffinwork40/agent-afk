/**
 * Signal-handler factories for the interactive REPL.
 *
 * Extracted from `interactive.cleanup.ts` (issue #2900) to keep that file
 * under the 350-line ceiling.  Contains:
 *   - `makeSigintHandler`   — SIGINT (idle double-Ctrl+C exit, soft-stop,
 *                             interrupt-picker).
 *   - `makeTermHupHandler`  — shared SIGTERM / SIGHUP teardown.
 *   - `installSignalHandlers` — wires all three handlers; returns disposer.
 *
 * Shared parameter types and `ExitReasonRef` are co-located here and
 * re-exported from `interactive.cleanup.ts` so existing importers are
 * unaffected.
 */

import { runCleanupFunctions } from '../../../utils/cleanupRegistry.js';
import { palette } from '../../palette.js';
import { launchInterruptPicker } from './interrupt-picker.js';
import type { StoredSession } from '../../session-store.js';
import type { InteractiveCtx } from './shared.js';
import type { TurnState } from './repl-loop.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Mutable ref that signal handlers write before calling rl.close(), so the
 *  session saver captures the reason. Typed to the `exitReason` union so
 *  callers get a type error if they pass an unrecognised string. */
export type ExitReasonRef = { current: StoredSession['exitReason'] };

export interface SignalHandlerDeps {
  ctx: InteractiveCtx;
  turnState: TurnState;
  pickerAbort: AbortController;
  /** Written before rl.close() so the session saver can record exitReason. */
  exitReasonRef: ExitReasonRef;
}

export interface SignalHandlerDisposers {
  removeListeners: () => void;
}

// ---------------------------------------------------------------------------
// SIGINT
// ---------------------------------------------------------------------------

/**
 * Build the SIGINT handler. Handles three cases:
 *   1. Foreground `!cmd` shell in flight → abort the shell.
 *   2. Turn in flight → soft-stop or show the interrupt picker.
 *   3. Idle → double-Ctrl+C within SIGINT_EXIT_WINDOW_MS exits.
 */
export function makeSigintHandler(deps: SignalHandlerDeps): () => void {
  const { ctx, turnState, exitReasonRef } = deps;
  const SIGINT_EXIT_WINDOW_MS = 1500;
  return () => {
    const now = Date.now();
    // Priority 1 — foreground `!cmd` shell. Set by the REPL while a
    // FG shell is in flight; the closure kills the shell's process
    // group and clears its FG slot, returning true. We swallow the
    // signal so the exit-cycle below doesn't also fire.
    if (turnState.tryAbortShellForeground && turnState.tryAbortShellForeground()) {
      turnState.lastSigintAt = now;
      return;
    }
    if (turnState.turnInFlight) {
      turnState.lastSigintAt = now;
      const c = turnState.activeCompositor;

      // Second Ctrl+C while the picker is open: abort the picker and hard-
      // cancel immediately (safety hatch — the user must never be stuck).
      if (turnState.interruptPickerAbort) {
        turnState.interruptPickerAbort.abort();
        turnState.interruptPickerAbort = null;
        ctx.session.current?.abort('sigint');
        exitReasonRef.current = 'sigint';
        ctx.rl.close();
        return;
      }

      // First Ctrl+C + armed compositor → show the interrupt picker
      // so the user can choose Stop (soft) vs Cancel (hard).
      if (c && c.isArmed()) {
        const doStop = () => {
          if (turnState.requestSoftStop) { turnState.requestSoftStop(); }
          else { ctx.session.current.interrupt().catch(() => { /* teardown */ }); }
          turnState.notifyInterrupting?.(true);
        };
        launchInterruptPicker({
          compositor: c,
          turnState,
          onStop: doStop,
          onCancel: () => { ctx.session.current?.abort('sigint'); exitReasonRef.current = 'sigint'; ctx.rl.close(); },
        });
        return;
      }

      // Fallback (non-TTY / compositor not armed): first Ctrl+C = soft-stop,
      // same as ESC. Prints exit affordance so 2nd Ctrl+C is discoverable.
      if (turnState.requestSoftStop) { turnState.requestSoftStop(); }
      else { ctx.session.current.interrupt().catch(() => { /* swallow during teardown */ }); }
      turnState.notifyInterrupting?.(true);
      const msg = '\n' + palette.info('ℹ ') + 'Press Ctrl+C again to exit.';
      if (c && c.isArmed()) { try { c.commitAbove(msg); } catch { console.log(msg); } }
      else { console.log(msg); }
      return;
    }
    if (now - turnState.lastSigintAt < SIGINT_EXIT_WINDOW_MS) {
      // Pre-abort before rl.close() so deriveClosureReason sees 'sigint'
      // (a non-'closed' reason) and returns 'abort' instead of 'model_end_turn'.
      ctx.session.current?.abort('sigint');
      exitReasonRef.current = 'sigint';
      ctx.rl.close();
      return;
    }
    turnState.lastSigintAt = now;
    console.log('\n' + palette.info('ℹ ') + 'Press Ctrl+C again (or /exit) to quit.');
  };
}

// ---------------------------------------------------------------------------
// SIGTERM / SIGHUP shared teardown
// ---------------------------------------------------------------------------

export function makeTermHupHandler(
  deps: SignalHandlerDeps,
  signal: 'sigterm' | 'sighup',
): () => void {
  const { ctx, pickerAbort, exitReasonRef } = deps;
  let inFlight = false;
  const GRACE_MS = 2000;
  return (): void => {
    if (inFlight) return;
    inFlight = true;
    // Pre-abort before rl.close() so deriveClosureReason sees the signal
    // name (a non-'closed' reason) and returns 'abort' rather than 'model_end_turn'.
    ctx.session.current?.abort(signal);
    // Record the exit reason BEFORE rl.close() so the session saver captures it.
    exitReasonRef.current = signal;
    // Ordering constraint: cancel the quit-time picker BEFORE closing
    // readline, so it releases raw stdin and settles its promise while the
    // terminal is still intact. Reversing this strands the awaited
    // disposition in the cleanup closure.
    pickerAbort.abort();
    try { ctx.rl.close(); } catch { /* best-effort */ }
    // Belt-and-suspenders: if rl.on('close') doesn't reach the exit
    // path within a short window (e.g. when the REPL loop is awaiting
    // a long-running turn), run cleanups directly and exit.
    // .unref()'d so this timer does not by itself keep the event loop
    // alive — if rl.close() drains and nothing else holds the loop, the
    // process exits naturally before the timer fires. When something DOES
    // keep the loop alive (e.g. an in-flight MCP disconnect promise), the
    // timer fires after GRACE_MS and forces exit regardless.
    setTimeout(() => {
      runCleanupFunctions().finally(() => process.exit(0));
    }, GRACE_MS).unref();
  };
}

// ---------------------------------------------------------------------------
// Public: installSignalHandlers
// ---------------------------------------------------------------------------

/**
 * Register SIGINT, SIGTERM, and SIGHUP handlers.
 *
 * Returns the SIGINT handler (so the caller can pass it to `runReplLoop`) and
 * a `removeListeners` disposer (to register with `registerCleanup`).
 */
export function installSignalHandlers(deps: SignalHandlerDeps): {
  handleSigint: () => void;
  removeListeners: () => void;
} {
  const handleSigint = makeSigintHandler(deps);
  const handleSigterm = makeTermHupHandler(deps, 'sigterm');
  const handleSighup = makeTermHupHandler(deps, 'sighup');

  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);
  process.on('SIGHUP', handleSighup);

  const removeListeners = (): void => {
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
    process.removeListener('SIGHUP', handleSighup);
  };

  return { handleSigint, removeListeners };
}
