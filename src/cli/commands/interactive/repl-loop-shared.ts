import { palette } from '../../palette.js';
import type { PermissionMode } from '../../../agent/types/sdk-types.js';

/**
 * Cross-phase state + helpers shared by the repl-loop orchestrator and its
 * phase modules (surface-setup, footer-subsystems, loop-iteration).
 *
 * Lives in its own module so both `surface-setup.ts` (which arms the
 * compositor with a `buildPrompt` closure) and `loop-iteration.ts` (which
 * rebuilds the prompt for the readLine / echo / toRunTurnRefs calls) can
 * import `buildPrompt` and the `TurnState` type without a circular import
 * back through `repl-loop.ts` (which imports both phase modules).
 *
 * `TurnState` is re-exported from `repl-loop.ts` so existing importers
 * (`interactive.ts`, `repl-loop-wiring.test.ts`) keep their
 * `import { ..., type TurnState } from './repl-loop.js'` paths working.
 */
export interface TurnState {
  turnInFlight: boolean;
  lastSigintAt: number;
  /**
   * Active TerminalCompositor for the in-flight turn, when one exists.
   * The SIGINT handler routes the interrupt notice through this
   * compositor's `commitAbove` so the message commits to scrollback above
   * the live overlay rather than racing log-update's clear/repaint cycle.
   * Set by `runTurn` at arm; cleared at dispose. Null between turns and
   * on non-TTY surfaces.
   */
  activeCompositor?: import('../../terminal-compositor.js').TerminalCompositor | null;
  /**
   * Closure that kills the in-flight `!cmd` foreground shell, if any.
   * Set by the REPL once the ShellPassthrough subsystem arms; returns
   * `true` when a foreground shell was killed (so the sigint handler
   * can swallow the signal) and `false` when no foreground shell was
   * active. The signal priority order in `handleSigint` (interactive.ts)
   * is: foreground shell > in-flight model turn > exit-cycle. Without
   * this branch, Ctrl+C during `!sleep 10` would fall through to the
   * exit-cycle path and surprise the user.
   */
  tryAbortShellForeground?: (() => boolean) | null;
  /**
   * Notifier published by the turn handler at arm time: toggles the live
   * "interrupting…" overlay affordance on the active renderer. The SIGINT
   * handler calls it on Ctrl+C mid-turn. Null between turns.
   */
  notifyInterrupting?: ((active: boolean) => void) | null;
  /**
   * In-turn soft-stop trigger — the SAME closure ESC fires
   * (sets the turn's `softStopRequested` + interrupts the session). The
   * SIGINT handler calls it on the FIRST Ctrl+C during a turn so Ctrl+C
   * stops as gracefully as ESC (keeps completed work, preserves the draft)
   * rather than a bare interrupt. Published whenever a soft-stop handler is
   * installed (normal turn or /skill dispatch) and cleared (null) between
   * turns. Null → the SIGINT handler falls back to a plain interrupt.
   */
  requestSoftStop?: (() => void) | null;
  /**
   * AbortController for the in-flight interrupt-and-steer picker. Set by
   * `handleSigint` when the picker is shown; aborted on the second Ctrl+C
   * (hard-cancel safety hatch) and automatically when the compositor clears
   * at turn end (so the picker dismisses when the turn completes). Null when
   * no picker is open.
   */
  interruptPickerAbort?: AbortController | null;
  /**
   * Steer message injected by the interrupt-and-steer picker's "Steer" path.
   * Set after the pending steer read resolves with a redirect message; drained
   * at the top of the `runInputLoop` while-body and
   * promoted to `seedBuffer` so it takes the same fast-path as slash-command
   * submit results. Null once drained.
   */
  pendingSteerText?: string | null;
  /**
   * The redirect read started by the Steer picker. The loop awaits this before
   * opening its ordinary turn-boundary prompt, preserving InputSurface's
   * single-pending-reader invariant when a stopped turn winds down quickly.
   */
  pendingSteerRead?: Promise<string | null> | null;
  /**
   * Accessor published by `runInputLoop` once the InputSurface is constructed.
   * Enables the `onSteer` closure in `interactive.ts` to call
   * `surface.readLine(...)` without holding a direct reference to the surface.
   * Cleared to null in `runInputLoop`'s finally block so no dangling closure
   * holds a reference to the disposed surface.
   */
  steerReadLine?: ((signal?: AbortSignal) => Promise<string>) | null;
}

export function buildPrompt(mode: PermissionMode): string {
  // The model name AND the worded mode chip (`○ default`, `● plan`, `◐ AFK`,
  // `⚡ bypass`) live only in the persistent status line (status-line.ts) —
  // the caret carries just the brand + a compact echo of the non-default
  // permission mode. That echo stays here (rather than moving entirely to
  // the status line) because the status row is carved out of the scroll
  // region (see status-line.ts's writeScrollRegion) and never enters
  // scrollback or piped logs: the prompt is the ONLY mode signal that
  // survives into the linear transcript. Default mode adds no marker — its
  // absence is itself the "contained" signal, mirrored at the caret. Plan and
  // AFK stay glyph-only, but bypass ALSO keeps a short ASCII tag (`bp`): it is
  // the security-sensitive mode, and an ASCII token is what lets a post-hoc
  // `grep` of a piped transcript locate the windows where permissions were off
  // (a bare glyph is not reliably searchable). A post-hoc transcript scan
  // should grep the spaced token `⚡ bp` (not a bare `bp`), because bare `bp`
  // also matches unrelated substrings like "subprocess".
  const base = palette.brand('afk');
  const marker =
    mode === 'plan' ? palette.warning(' ●') :
    mode === 'autonomous' ? palette.info(' ◐') :
    mode === 'bypassPermissions' ? palette.bypass(' ⚡ bp') :
    '';
  // Caret is brand-toned (not dim) so the input point reads as a deliberate
  // affordance rather than receding chrome — matches the "the caret carries the
  // brand" intent above. Glyph unchanged (`›`) so piped/stripped transcripts and
  // the strip-based buildPrompt tests are unaffected.
  return base + marker + palette.brand('  › ');
}
