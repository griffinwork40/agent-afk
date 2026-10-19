import { createSuggestEngine } from '../../input/suggest.js';
import type { InputSurface } from '../../input/input-surface.js';
import { debugLog } from '../../../utils/debug.js';
import { cyclePermissionMode } from '../../permission-mode-cycle.js';
import type { InteractiveCtx } from './shared.js';
import type { TranscriptHandle } from './transcript.js';
import type { LoopStageBar } from './loop-stage.js';
import type { MascotBar } from './mascot-bar.js';
import { buildPrompt, type TurnState } from './repl-loop-shared.js';
import { installHistorySubmissionTracker } from './surface-setup.history-tracking.js';
import { buildSuggestConfig } from './surface-setup.suggest-config.js';
import { buildSuggestionJournalRecorder } from './surface-setup.suggest-record.js';
import { buildOutputViewerCallback } from './surface-setup.viewer-callback.js';
import {
  buildOpenEditorCallback,
  installElicitationHandler,
  wireCompositorIntoCtx,
  wireSlashCtxCallbacks,
} from './surface-setup.wiring.js';

/**
 * Dependencies surface-setup needs from phases that have not been
 * constructed yet at call time. `getLoopStageBar` is read lazily by the
 * `ctx.slashCtx.onStageChange` closure: surface setup runs BEFORE the footer
 * subsystems exist, but the closure is only ever INVOKED during a turn (long
 * after the footer bar is built), so the deferred getter resolves to the live
 * bar — mirroring the original hoisted-`let` closure semantics.
 */
export interface SurfaceSetupDeps {
  getLoopStageBar: () => LoopStageBar | undefined;
  /** Same lazy-getter contract as {@link getLoopStageBar} (issue #336). */
  getMascotBar: () => MascotBar | undefined;
}

export interface SurfaceSetupResult {
  /**
   * Installs a per-turn soft-stop handler on the surface (so ESC works) AND
   * publishes it to `turnState.requestSoftStop` so the SIGINT handler can fire
   * the SAME soft-stop on the first Ctrl+C of a turn. Passed into `runTurn`
   * (and `runSkillDispatchTurn` via `ctx.slashCtx.setSoftStopHandler`) by the
   * loop. `null` clears both refs between turns.
   */
  installSoftStop: (handler: (() => void) | null) => void;
}

/**
 * Phase 1 of the REPL loop — surface setup.
 *
 * Arms the persistent TerminalCompositor on `surface`, installs the REPL
 * elicitation handler, wires the compositor into the ReplRenderer and
 * SlashContext, routes the idle-mode completionWriter through the compositor,
 * installs the soft-stop bridge, and mirrors the skill-dispatch UI callbacks
 * onto SlashContext.
 *
 * Mutates `ctx` (replRenderer, slashCtx, completionWriter, inputSurfaceRef),
 * `turnState` (via the returned installSoftStop), and the global
 * elicitationRouter. Returns the `installSoftStop` helper for the loop +
 * teardown to reuse.
 *
 * Must be awaited BEFORE the first `surface.readLine()` (so readLine picks the
 * persistent-compositor path) and BEFORE the footer subsystems start (so the
 * compositor owns stdout before any reserved-row painter writes).
 */
export async function setupSurface(
  ctx: InteractiveCtx,
  surface: InputSurface,
  turnState: TurnState,
  transcript: TranscriptHandle,
  sigintHandler: () => void,
  suggestGhostEnabled: boolean,
  deps: SurfaceSetupDeps,
): Promise<SurfaceSetupResult> {
  // Ghost-text suggestion engine — one per REPL session, disposed with the
  // compositor in the finally block (compositor.disarm() calls engine.dispose).
  // Created here (before armCompositor) so the engine is ready when the first
  // keystroke fires. The context closure reads live stats (model, cwd) and
  // the surface's history/autocompleteState lazily at each suggestion call —
  // captures the mutable refs (not snapshot values) so mid-session /model
  // swaps are reflected automatically.
  //
  // Tier-2 (LLM fallback) is gated by `AFK_SUGGEST_ENABLED`. When disabled,
  // `llmEnabled()` returns false and the engine runs Tier-1 only (synchronous
  // history/dropdown prefix match) — zero extra latency, zero API traffic.
  // The engine resolves its own credential per suggestion model; the session
  // credential is deliberately never handed to it (see suggest-credential.ts).
  const suggestEngine = createSuggestEngine({
    // Surface Tier-2 failures (auth, network, 404 model, unreachable shim)
    // under AFK_DEBUG=1; a no-op otherwise so normal sessions stay silent and
    // the compositor's stdout frame is never disturbed.
    onError: (err) => debugLog('[afk suggest] Tier-2 completion failed:', err),
    // Persist AI suggestions (generated + accepted/dismissed) to the session
    // journal as `suggestion` marks; see surface-setup.suggest-record.ts.
    onRecord: buildSuggestionJournalRecorder(ctx.session),
  });

  // Session-scoped submission tracker (see surface-setup.history-tracking.ts).
  const historyTracker = installHistorySubmissionTracker(surface);

  // Stage 3e — arm the surface's persistent TerminalCompositor before the
  // first prompt. Lives across all turns; disarmed in the finally below.
  // No-op on non-TTY surfaces (daemon, pipe, tests) — readLine falls back
  // to readWithAutocomplete.
  //
  // External constraint: armCompositor must complete BEFORE the first
  // surface.readLine() call so the readLine() picks the persistent path
  // (compositor.isArmed() === true). Awaited here to honor that ordering.
  // The caller's try block wraps this call so a rejection from armCompositor
  // still reaches the finally and surface.dispose() cleans up raw-mode stdin.
  await surface.armCompositor({
    promptFn: (buffer) => buildPrompt(ctx.stats.permissionMode, buffer),
    // Stable cancel handler for both idle (between turns) and streaming
    // (mid-turn). handleSigint internally dispatches on `turnInFlight`:
    //   - In flight: session.interrupt() + arm "press Ctrl+C again to exit".
    //   - Idle: "Press Ctrl+C again to quit" cycle.
    // No per-turn swap needed — the dispatch is mode-aware via turnState.
    onCancel: sigintHandler,
    onShiftTab: () => {
      // Replicated from the user-turn onShiftTab handler below — the
      // persistent compositor uses ONE onShiftTab across both phases
      // (the permission-mode cycle is REPL-global, not turn-scoped). Shift+Tab
      // advances the ring default → plan → bypass → default (AFK stays on
      // /afk); cf. `/plan off`, which saves the plan + implements it.
      cyclePermissionMode(ctx.slashCtx).catch(() => {});
      ctx.statusLine.rearm();
    },
    // Ctrl+O → open $EDITOR seeded with the input buffer, mirroring the
    // /editor slash command. See buildOpenEditorCallback in surface-setup.wiring.ts.
    onOpenEditor: buildOpenEditorCallback(surface, ctx),
    onOpenOutputViewer: buildOutputViewerCallback(ctx.capturePathRef, () => surface.getCompositor()),
    // StatusLine doubles as DECSTBM scroll-region guard so commitAbove
    // writes survive the persistent bottom-row reservation.
    scrollRegion: ctx.statusLine,
    // Forward the anchor row captured by `commands/interactive.ts` during
    // its pre-arm print block (banner + update notice + boot-prune notice).
    // When set, the compositor protects rows 1..anchorRow-1 from being
    // overwritten by the live frame's CUP-positioned upward growth, and
    // evicts the deficit into scrollback if the frame would otherwise
    // climb above. Undefined on daemons / non-bootstrap callers — defaults
    // the compositor to pre-fix behavior (no protection).
    ...placementArmOpts(ctx.preArmAnchorRow),
    // Ghost-text wiring — context factory extracted to surface-setup.suggest-config.ts.
    // Returns `{ suggest: { engine, getContext } }` when enabled, `{}` when disabled.
    ...buildSuggestConfig({
      enabled: suggestGhostEnabled,
      engine: suggestEngine,
      surface,
      stats: ctx.stats,
      baseUrl: ctx.suggestBaseUrl,
      historyTracker,
    }),
  });

  // Invariant: install the REPL elicitation handler AFTER armCompositor
  // resolves so it routes through the persistent compositor's onSubmit
  // path (single stdin consumer) rather than through `rl.question()`.
  // (also enforced structurally by StdinClaim — see src/cli/input/stdin-claim.ts)
  //
  // Arrow-key picker dependency is wired ONLY when a compositor is armed
  // (TTY mode). Non-TTY surfaces (daemon/pipe/headless tests) leave it
  // undefined and the elicitation handler's `renderAgentQuestion` falls
  // back to the numbered-text path — preserving the pre-picker behaviour
  // for surfaces that can't render a live frame.
  const armedCompositor = surface.getCompositor();
  const stdinElicitationHandler = installElicitationHandler(ctx, surface, armedCompositor);

  // Stage 3e fix — wire the persistent compositor into the ReplRenderer
  // and SlashContext ONCE, here, immediately after the surface arms.
  // See wireCompositorIntoCtx in surface-setup.wiring.ts for the full
  // constraint commentary (ordered-operation sequence, stacked-prompt bug).
  wireCompositorIntoCtx(ctx, surface);

  // Install a per-turn soft-stop handler on the surface (so ESC works) AND
  // publish it to turnState so the SIGINT handler can fire the SAME soft-stop
  // on the first Ctrl+C of a turn (Ctrl+C-once == ESC). Both the normal-turn
  // host hook and the /skill dispatch path route through here, so a single
  // helper keeps the surface ref and the turnState ref in lockstep — including
  // the teardown call (handler === null) that clears both between turns.
  const installSoftStop = (handler: (() => void) | null): void => {
    surface.setSoftStopHandler(handler);
    turnState.requestSoftStop = handler;
  };
  // Expose setSoftStopHandler so `runSkillDispatchTurn` can install its
  // per-dispatch closure (same wiring as TurnHandles.setSoftStopHandler
  // below). Without this, ESC during a /skill turn is silently dropped at
  // the compositor's onSoftStop because the surface's softStopHandler ref
  // stays null.
  ctx.slashCtx.setSoftStopHandler = installSoftStop;

  // Mirror TurnHandles callbacks onto SlashContext, wire transcript, Telegram
  // swap, inputSurfaceRef, git sampler, and quota repaint.
  // See wireSlashCtxCallbacks in surface-setup.wiring.ts for full commentary.
  const maxTurnsNum = (() => { const mt = parseInt(ctx.options.maxTurns, 10); return mt > 0 ? mt : undefined; })();
  wireSlashCtxCallbacks(ctx, surface, transcript, deps, maxTurnsNum, stdinElicitationHandler);

  return { installSoftStop };
}

/**
 * Frame-placement options for the REPL compositor: the pre-arm anchor row
 * (when the bootstrap measured one) plus content-hug placement, so the live
 * frame follows committed output and a frame shrink never leaves a blank gap
 * between content and the prompt or in scrollback
 * (terminal-compositor.content-hug.ts).
 */
function placementArmOpts(preArmAnchorRow: number | undefined): { anchorRow?: number; contentHug: boolean } {
  return { ...(preArmAnchorRow !== undefined ? { anchorRow: preArmAnchorRow } : {}), contentHug: true };
}
