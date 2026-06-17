import { createSuggestEngine } from '../../input/suggest.js';
import type { InputSurface } from '../../input/input-surface.js';
import { elicitationRouter } from '../../../agent/elicitation-router.js';
import { makeReplElicitationHandler } from '../../elicitation-repl.js';
import { runPicker } from '../../render/picker.js';
import { runTextInput } from '../../render/text-input.js';
import { debugLog } from '../../../utils/debug.js';
import { env } from '../../../config/env.js';
import { togglePlanMode } from '../../plan-mode-toggle.js';
import type { InteractiveCtx } from './shared.js';
import { formatStatusFields } from './shared.js';
import type { TranscriptHandle } from './transcript.js';
import type { LoopStageBar } from './loop-stage.js';
import { buildPrompt, type TurnState } from './repl-loop-shared.js';

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
  // Tier-2 (LLM fallback) is gated by `AFK_SUGGEST_ENABLED` and `apiKey`.
  // When neither is set, `llmEnabled()` returns false and the engine runs
  // Tier-1 only (synchronous history/dropdown prefix match) — zero extra
  // latency, zero API traffic.
  const suggestEngine = createSuggestEngine({
    // Surface Tier-2 failures (auth, network, 404 model, unreachable shim)
    // under AFK_DEBUG=1; a no-op otherwise so normal sessions stay silent and
    // the compositor's stdout frame is never disturbed.
    onError: (err) => debugLog('[afk suggest] Tier-2 completion failed:', err),
  });

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
    promptFn: () => buildPrompt(ctx.stats.model, ctx.stats.permissionMode),
    // Stable cancel handler for both idle (between turns) and streaming
    // (mid-turn). handleSigint internally dispatches on `turnInFlight`:
    //   - In flight: session.interrupt() + arm "press Ctrl+C again to exit".
    //   - Idle: "Press Ctrl+C again to quit" cycle.
    // No per-turn swap needed — the dispatch is mode-aware via turnState.
    onCancel: sigintHandler,
    onShiftTab: () => {
      // Replicated from the user-turn onShiftTab handler below — the
      // persistent compositor uses ONE onShiftTab across both phases
      // (plan-mode toggle is REPL-global, not turn-scoped). Shift+Tab is a
      // raw flip with no seeded turn: the "exit plan mode without saving or
      // implementing" escape hatch (cf. `/plan off`, which saves + implements).
      togglePlanMode(ctx.slashCtx).catch(() => {});
      ctx.statusLine.rearm();
    },
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
    ...(ctx.preArmAnchorRow !== undefined ? { anchorRow: ctx.preArmAnchorRow } : {}),
    // Ghost-text wiring: inject the engine + a lazy context closure.
    // The closure re-reads live config on each call so /model swaps and
    // any runtime env changes take effect without restarting the REPL.
    // When `suggestGhostEnabled` is false (AFK_SUGGEST_GHOST=0 or JSON
    // interactive.suggestGhost:false), the entire suggest block is omitted
    // so the compositor runs with no ghost-text at all (Tier-1 + Tier-2 off).
    ...(suggestGhostEnabled
      ? {
          suggest: {
            engine: suggestEngine,
            getContext: () => ({
              model: ctx.stats.model as string,
              apiKey: ctx.suggestApiKey,
              baseUrl: ctx.suggestBaseUrl,
              cwd: ctx.stats.cwd ?? process.cwd(),
              getHistory: () => {
                // `surface.history` is always a `ReplHistory` at runtime — the
                // InputSurface constructor calls `loadHistory()` which returns one.
                // We narrow to `ReplHistory` via duck-typing (`getEntries` method)
                // so we never import `ReplHistory` directly (avoids a circular-ish
                // dep and keeps the interface boundary clean).
                const ring = surface.history as { getEntries?: () => readonly string[] };
                return ring.getEntries ? [...ring.getEntries()] : [];
              },
              getDropdownTopCandidate: (buffer: string) => {
                const ac = surface.autocompleteState;
                const top = ac.candidates[0];
                if (!top) return null;
                // Only return the candidate's value if it starts with the buffer
                // (strict-prefix check mirrors getDeterministicGhost's own guard).
                return top.value.startsWith(buffer) && top.value.length > buffer.length
                  ? top.value
                  : null;
              },
              getTranscriptTail: () => '',
              getRecentCommands: () => [],
              // Parse as a boolean, not raw truthiness: only the documented
              // activations (1/true/yes/on — see docs/env-registry.md) enable the
              // Tier-2 LLM. A non-empty falsy value like `0` or `false` must keep
              // suggestions off, otherwise typing would start firing provider calls
              // despite the user explicitly disabling them.
              llmEnabled: () => /^(1|true|yes|on)$/i.test(env.AFK_SUGGEST_ENABLED ?? ''),
            }),
          },
        }
      : {}),
  });

  // Invariant: install the REPL elicitation handler AFTER armCompositor
  // resolves so it routes through the persistent compositor's onSubmit
  // path (single stdin consumer) rather than through `rl.question()`.
  // (also enforced structurally by StdinClaim — see src/cli/input/stdin-claim.ts)
  //
  // External constraint (single-consumer stdin): when the TerminalCompositor
  // is armed, it owns a raw-mode `keypress` listener on process.stdin and
  // consumes every keystroke into its internal input buffer. A parallel
  // `rl.question()` on a `terminal: false` readline ALSO consumes the same
  // keystrokes. Both resolve — the agent receives the answer via rl.question
  // AND the compositor buffer fills with the same digits + sets `queued =
  // true` on Enter. The next `surface.readLine()` idle-flush then fires the
  // stale queued buffer as a phantom user turn (terminal-compositor.ts ~508).
  //
  // The fix is substitution, not suppression: remove the rl.question
  // consumer entirely so the compositor is the sole stdin consumer. The
  // compositor's keypress listener stays live throughout — its onSubmit
  // handler is one-shot and re-wired per `surface.readLine()` call.
  //
  // Non-TTY fallback (daemon, pipe, tests): `surface.getCompositor()`
  // returns null and `surface.readLine()` falls back to readWithAutocomplete
  // (input-surface.ts:386). The install block is unconditional — readLine
  // works in both modes; only the `writer.line` target needs a fallback
  // when there is no compositor to commitAbove through.
  // Arrow-key picker dependency is wired ONLY when a compositor is armed
  // (TTY mode). Non-TTY surfaces (daemon/pipe/headless tests) leave it
  // undefined and the elicitation handler's `renderAgentQuestion` falls
  // back to the numbered-text path — preserving the pre-picker behaviour
  // for surfaces that can't render a live frame.
  const armedCompositor = surface.getCompositor();
  elicitationRouter.install(makeReplElicitationHandler({
    readLine: (prompt) =>
      surface.readLine({ promptFn: () => prompt }).then((r) => r.text),
    writer: {
      line: (text = '') => {
        // Route the question header through the compositor so it commits
        // ABOVE the persistent input row (and survives the DECSTBM repaint
        // cycle). A raw `process.stdout.write` here would race log-update's
        // clear/repaint tick and either get clipped or strand the question
        // mid-frame. Falls back to raw stdout when no compositor is armed
        // (non-TTY) — log-update is not live, so the race does not exist.
        const c = surface.getCompositor();
        if (c) {
          c.commitAbove(text);
        } else {
          process.stdout.write(text + '\n');
        }
      },
    },
    pendingCount: () => elicitationRouter.pendingCount(),
    ...(armedCompositor ? {
      pickFromList: (opts) => runPicker(armedCompositor, opts),
      readTextOverlay: (opts) => runTextInput(armedCompositor, opts),
    } : {}),
  }));

  // Stage 3e fix — wire the persistent compositor into the ReplRenderer
  // and SlashContext ONCE, here, immediately after the surface arms.
  //
  // External constraint (ordered-operation sequence): the compositor's
  // lifetime is REPL-startup → REPL-exit. Any code path that writes to
  // stdout between turns (verdict ledger, context pane, bg-notifications
  // at the top of the loop; slash-skill dispatch via `/<skill>`) MUST
  // route through `compositor.commitAbove` so log-update's tracked-line
  // count stays consistent with the actual terminal content. A raw
  // stdout write shifts the cursor without updating the line count;
  // the next repaint then clears too few lines and the previous frame
  // strands above the new one (the "stacked prompt" duplication bug).
  //
  // BEFORE this Stage-3e fix:
  //   - The per-turn `setActiveCompositor` callback toggled
  //     `replRenderer.setCompositor(c)` (mid-turn) and then `null`
  //     (in turn-handler's finally). Between turns the renderer's
  //     `compositor` ref was null, so `writeLine` fell through to raw
  //     stdout.write — even though the persistent TerminalCompositor
  //     was still armed and tracking the terminal via log-update.
  //   - Built-in TS skills constructed a `StreamRenderer` with no
  //     `compositor` option, so their `arm()` took the own-compositor
  //     path and instantiated a SECOND log-update on the same stdout.
  //
  // The fix is two-pronged: (1) hold the persistent compositor ref on
  // `replRenderer` for the lifetime of the surface (so writeLine never
  // falls through to raw stdout while the compositor is armed), and
  // (2) expose the compositor via `SlashContext.getCompositor` so the
  // built-in-skills bridge can borrow it (see slash/builtin-skills.ts).
  ctx.replRenderer.setCompositor(surface.getCompositor());
  ctx.slashCtx.getCompositor = () => surface.getCompositor();
  // Invariant: Stage 3e idle-mode completionWriter wiring. The persistent
  // compositor is armed for the lifetime of this REPL, so between-turn
  // slash output (e.g. `/model foo` → "Unknown model" warning routed via
  // `ctx.out.warn` → `completionWriter.fn`) MUST commit above the live
  // idle overlay rather than write raw at the input row's current cursor
  // position. Without this, a between-turn warning overlays directly onto
  // the just-echoed user input (e.g. the original `/model claude-opus-4-8`
  // repro: warning rendered inline at the tail of the echoed input row).
  //
  // Enforcing peer: turn-handler.ts's finally block resets
  // `completionWriter.fn := completionWriter.idleFn` after every turn
  // (NOT `console.log`). Setting `idleFn` here is what keeps the
  // borrowed-compositor wiring alive across turn boundaries.
  //
  // Non-TTY surfaces (daemon, pipe, tests): `surface.getCompositor()`
  // returns `null` and both slots stay at their bootstrap default
  // (`console.log`) — the legacy path is preserved.
  const persistentCompositor = surface.getCompositor();
  if (persistentCompositor) {
    const writeIdle = (line: string) => persistentCompositor.commitAbove(line);
    ctx.completionWriter.fn = writeIdle;
    ctx.completionWriter.idleFn = writeIdle;
  }
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
  // Mirror the TurnHandles.onStageChange / onContextProgress wiring (see the
  // runTurn handles object in loop-iteration.ts) onto SlashContext so
  // skill-dispatch turns (`/review`, `/mint`, plugin skills) drive the SAME
  // footer rails as normal turns. Without these, the LoopStageBar stays frozen
  // at "observe" and the status line stays at 0%/$0.00 for the entire skill
  // turn — the renderer built by createSkillRenderer had no callback to fire.
  //
  // `getLoopStageBar` is read lazily: the footer subsystems are constructed
  // AFTER this phase, but this closure only fires during a turn — long after
  // the bar exists. Matches the original hoisted-`let loopStageBar` capture.
  ctx.slashCtx.onStageChange = (stage) => deps.getLoopStageBar()?.repaint(stage);
  ctx.slashCtx.onContextProgress = async () => {
    await ctx.contextSampler.refresh();
    ctx.statusLine.repaint(formatStatusFields(ctx.stats, ctx.contextSampler));
  };
  // Transcript parity for skill turns: runSkillDispatchTurn appends the
  // completed `/skill args → assistant text` exchange through this handle,
  // matching the normal-turn append at onTurnComplete in the loop. Without it,
  // skill-turn output is absent from the autosaved markdown transcript.
  ctx.slashCtx.transcript = transcript;

  // Wire the armed surface into the elicitation handler's compositor ref so
  // ask_question suspend/resume can yield stdin raw-mode to rl.question.
  if (ctx.inputSurfaceRef) {
    ctx.inputSurfaceRef.current = surface;
  }

  return { installSoftStop };
}
