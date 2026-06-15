import { loadHistory } from '../../input/history.js';
import { InputSurface } from '../../input/input-surface.js';
import { env } from '../../../config/env.js';
import type { InteractiveCtx } from './shared.js';
import type { TranscriptHandle } from './transcript.js';
import { setupSurface } from './surface-setup.js';
import { setupFooterSubsystems, type FooterSubsystems } from './footer-subsystems.js';
import { runInputLoop } from './loop-iteration.js';
import type { TurnState } from './repl-loop-shared.js';

// Re-export so existing importers keep their `import { ..., type TurnState }
// from './repl-loop.js'` paths working (interactive.ts, repl-loop-wiring.test.ts).
export type { TurnState };

/**
 * Resolve the ghost-text master toggle.
 * Precedence: env > JSON config > default-on.
 * Uses a DENYLIST (not allowlist) because the default is ON.
 */
export function resolveSuggestGhost(
  envRaw: string | undefined,
  jsonVal: boolean | undefined,
): boolean {
  if (envRaw !== undefined) {
    const lowered = envRaw.toLowerCase();
    return !(lowered === '0' || lowered === 'false' || lowered === 'off' || lowered === 'no');
  }
  if (typeof jsonVal === 'boolean') return jsonVal;
  return true; // default-on
}

/**
 * The main REPL loop — a thin orchestrator over three phase modules:
 *
 *   1. {@link setupSurface}          — arm the persistent compositor, install
 *                                       the elicitation handler, wire the
 *                                       renderer/slashCtx/completionWriter +
 *                                       soft-stop bridge.
 *   2. {@link setupFooterSubsystems} — context pane, verdict ledger, bg
 *                                       manager + status bar, loop-stage bar,
 *                                       shell passthrough.
 *   3. {@link runInputLoop}          — the `while (true)` body: notification
 *                                       drain, seed-buffer fast-path, readLine,
 *                                       shell dispatch, slash dispatch,
 *                                       preflight, runTurn.
 *
 * The loop exits when a slash command returns `'exit'` (which closes the
 * readline interface, firing the caller's `rl.on('close')` handler) or when
 * readline closes on its own.
 *
 * `turnState` is mutated by the phases: `runTurn` flips `turnInFlight` via its
 * handles, the surface/footer setup publish soft-stop and shell-abort closures,
 * and the caller's SIGINT handler reads those fields.
 */
export async function runReplLoop(
  ctx: InteractiveCtx,
  transcript: TranscriptHandle,
  turnState: TurnState,
  sigintHandler: () => void,
): Promise<void> {
  // History ring — load from disk before the loop (ordered-operation invariant:
  // disk I/O must complete before the first prompt, not inside turn/cleanup).
  // External constraint: JSONL file is append-only; errors are swallowed so a
  // missing or corrupt file never blocks startup.
  const history = await loadHistory();

  // Long-lived input surface — owns the shared autocomplete dropdown state
  // (instantiated inside the surface, accessible via `surface.autocompleteState`).
  // Both the user-turn surface (surface.readLine) and the agent-turn surface
  // (TerminalCompositor, via surface.getCompositor() / toRunTurnRefs()) read/
  // write the same state, so ↑/↓ history navigation and `/` autocomplete
  // are consistent regardless of whose turn it is.
  //
  // Constructed BEFORE the try block so the `finally` can always
  // `surface.dispose()` it, even if setupSurface's armCompositor rejects.
  const surface = new InputSurface({
    rl: ctx.rl,
    history,
    statusLine: ctx.statusLine,
  });

  // Ghost-text master toggle (precedence: env > JSON config > default-on).
  // Resolved before the try (pure, never throws) and handed to setupSurface,
  // which gates the entire compositor `suggest` block on it.
  const suggestGhostEnabled = resolveSuggestGhost(env.AFK_SUGGEST_GHOST, ctx.suggestGhostConfig);

  // Footer subsystems — hoisted so the `finally` can tear them down even if
  // setupSurface (or footer construction) throws before assignment. Undefined
  // until setupFooterSubsystems returns; the `getLoopStageBar` getter passed to
  // setupSurface reads it lazily (the loop-stage callback only fires mid-turn,
  // long after this is assigned).
  let footer: FooterSubsystems | undefined;

  // External constraint: the try starts here (not earlier) so a rejection from
  // setupSurface's armCompositor still reaches the finally and surface.dispose()
  // cleans up raw-mode stdin.
  try {
    const { installSoftStop } = await setupSurface(
      ctx,
      surface,
      turnState,
      transcript,
      sigintHandler,
      suggestGhostEnabled,
      { getLoopStageBar: () => footer?.loopStageBar },
    );

    footer = setupFooterSubsystems(ctx, turnState);

    await runInputLoop(
      ctx,
      transcript,
      turnState,
      sigintHandler,
      surface,
      installSoftStop,
      footer,
      history,
    );
  } finally {
    // Drain ShellPassthrough — kills every `!&cmd` background shell that
    // is still running. Same lifecycle rationale as bgManager above: the
    // shell jobs are owned by this loop, must not outlive it. Clear the
    // sigint hook BEFORE the drain so a Ctrl+C during shutdown doesn't
    // race a half-torn-down passthrough into killing nothing.
    turnState.tryAbortShellForeground = null;
    footer?.shellPassthrough.drainOnExit();
    // Stop the footer painters top → bottom so each clears the exact row it
    // painted before the counts below it change. LoopStageBar positions from
    // the full extraRows, so it must clear before bgStatusBar/verdictLedger
    // shrink their counts. The bg bar's clear row depends on the verdict count
    // (its getAdjacentRows), so it must clear before the verdict ledger drops
    // ledgerRowCount to 0. The verdict rail sits at the bottom (row N-1),
    // independent of the others.
    footer?.loopStageBar.stop();
    footer?.bgStatusBar.stop();
    footer?.verdictLedger.stop();
    footer?.contextPane.dispose();
    // Reset completionWriter to console.log BEFORE disposing the
    // compositor. After surface.dispose() the persistent compositor is
    // gone; any post-dispose write through `commitAbove` would target a
    // dead object. The goodbye banner in interactive.ts writes via
    // `console.log` directly, but defensive: any plugin teardown that
    // routes through completionWriter is now safe.
    const resetToConsole = (line: string) => console.log(line);
    ctx.completionWriter.fn = resetToConsole;
    ctx.completionWriter.idleFn = resetToConsole;
    // Stage 3e: disarm the persistent compositor on REPL exit. Best-
    // effort — surface.dispose() is idempotent and swallows raw-mode
    // teardown errors so a corrupt terminal state doesn't mask the
    // original failure that triggered REPL exit. Goodbye-banner output
    // happens AFTER this call in interactive.ts (line 240, `console.log(formatter.formatInfo('Goodbye!'))`)
    // so the banner correctly lands in raw stdout, not above the just-
    // disarmed overlay.
    await surface.dispose();
    // Clear the elicitation compositor ref so any in-flight ask_question
    // prompts that outlive the surface skip suspend/resume cleanly.
    if (ctx.inputSurfaceRef) {
      ctx.inputSurfaceRef.current = null;
    }
  }
}
