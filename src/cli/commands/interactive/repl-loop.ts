import type { ReadWithAutocompleteResult } from '../../input-box.js';
import { formatSubmittedEcho } from '../../input/echo.js';
import { loadHistory } from '../../input/history.js';
import { createSuggestEngine } from '../../input/suggest.js';
import { describeAttachmentSummary, type ImageAttachment } from '../../input/attachments.js';
import { InputSurface } from '../../input/input-surface.js';
import { elicitationRouter } from '../../../agent/elicitation-router.js';
import { makeReplElicitationHandler } from '../../elicitation-repl.js';
import { runPicker } from '../../render/picker.js';
import { runTextInput } from '../../render/text-input.js';
import { dispatch as dispatchSlash, parse as parseSlash } from '../../slash/registry.js';
import {
  runPreflight,
  getPreflight,
  getSkillPreflightDir,
  stitchForwardManifest,
  type SkillInvocation,
} from '../../slash/preflight/index.js';
import { renderDebugBanner } from '../../debug-banner.js';
import { isDebugEnabled, debugLog } from '../../../utils/debug.js';
import { env } from '../../../config/env.js';
import { palette } from '../../palette.js';
import { togglePlanMode } from '../../plan-mode-toggle.js';
import {
  autoRegisterPluginPassthroughs,
  getPluginShadowingNoticeLines,
} from '../../slash/plugin-skills.js';
import type { InteractiveCtx } from './shared.js';
import { formatStatusFields } from './shared.js';
import type { TranscriptHandle } from './transcript.js';
import { runTurn } from './turn-handler.js';
import { saveSession } from '../../session-store.js';
import { createContextPane } from './context-pane.js';
import { createVerdictLedger } from './verdict-ledger.js';
import { BackgroundTaskManager, type BackgroundTask } from './background.js';
import { BackgroundStatusBar } from '../../background-status-bar.js';
import { LoopStageBar } from './loop-stage.js';
import { card } from '../../render.js';
import { setBgManager } from '../../slash/commands/bg.js';
import { setTasksManager, setTasksRegistry } from '../../slash/commands/tasks.js';
import { setAttachManager } from '../../slash/commands/attach.js';
import { ShellPassthrough } from './shell-passthrough.js';
import { setShellPassthrough } from '../../slash/commands/sh.js';

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
}

async function runFirstTurnHookIfNeeded(ctx: InteractiveCtx, text: string): Promise<void> {
  // First-turn hook — awaited before any first-turn side effect that relies on
  // the session cwd. For born-named worktrees the hook creates the worktree this
  // turn will run in and points the session cwd at it, so it MUST complete
  // before plugin preflights or model tool calls compute a cwd — otherwise they
  // would run in the launch cwd (the parent repo) instead of the isolated
  // worktree.
  //
  // Single-fire: guarded on `totalTurns === 0`. Detach before awaiting so a
  // slow hook cannot re-fire if the loop is re-entered mid-await.
  if (ctx.firstTurnHook && ctx.stats.totalTurns === 0) {
    const hook = ctx.firstTurnHook;
    ctx.firstTurnHook = undefined;
    try {
      await hook(text);
    } catch (err) {
      // Defensive — hook implementations are expected to swallow their own
      // errors, but never let one break the REPL. When called before runTurn the
      // compositor is not yet armed, so completionWriter routes to a plain
      // console.log — no clear/repaint race to lose.
      ctx.completionWriter.fn(
        palette.warning('⚠ ') + 'first-turn hook failed: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

function buildPrompt(model: string, planMode: boolean): string {
  const base = palette.brand('afk') + palette.dim(` (${model})`);
  const marker = planMode ? palette.warning(' ● plan') : '';
  return base + marker + palette.dim('  › ');
}

/**
 * The main REPL loop. Reads input via the input-box, dispatches slash
 * commands, or hands user text to `runTurn`. The loop exits when a slash
 * command returns `'exit'` or the readline interface closes (which then
 * fires the caller's `rl.on('close')` handler).
 *
 * `turnState` is mutated: `runTurn` flips `turnInFlight` via its handles,
 * and the caller's SIGINT handler reads both fields.
 */
export async function runReplLoop(
  ctx: InteractiveCtx,
  transcript: TranscriptHandle,
  turnState: TurnState,
  sigintHandler: () => void,
): Promise<void> {
  // Init metadata (tools/MCP/SDK version) only resolves once the SDK
  // receives the first user message. Logging it inline from the `.then`
  // would interleave with the turn-1 spinner. Capture and defer to the
  // top of the REPL loop so it prints cleanly between turns.
  // Gated on isDebugEnabled() — the banner's tool count is SDK-advertised,
  // not the whitelisted subset, so it's misleading and noisy by default.
  let pendingInitMeta: string | null = null;
  let pendingShadowingNotices: string[] = [];
  ctx.session.current.waitForInitialization().then(async (meta) => {
    if (isDebugEnabled()) {
      pendingInitMeta = renderDebugBanner(meta);
    }
    // Hot-swap the placeholder /skills and /agents commands with the live
    // SDK-discovered lists, and install passthrough handlers for every
    // plugin skill so `/mint`, `/forge`, etc. forward straight to the SDK
    // turn loop. Without this, the slash dispatcher treats every plugin
    // skill as an unknown command until the user manually runs
    // `/reload-plugins`. Inner registrars log + swallow their own errors,
    // so this never throws in practice.
    await autoRegisterPluginPassthroughs(ctx.session.current);
    // Vendored or user skills win bare-name collisions with plugin skills —
    // surface a one-time dim notice telling the user where the shadowed
    // plugin form is still reachable (e.g. `/example-plugin:mint`).
    if (isDebugEnabled()) {
      pendingShadowingNotices = getPluginShadowingNoticeLines();
    }
  }).catch(() => { /* init / plugin discovery non-critical */ });

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
  const surface = new InputSurface({
    rl: ctx.rl,
    history,
    statusLine: ctx.statusLine,
  });

  // Slash-command submit queue: a slash handler may return
  // `{ kind: 'submit', message: '...' }` to follow itself up with a
  // user-text turn. We stash that as `seedBuffer` and fire it on the
  // next iteration via the fast-path below — the mid-stream-queue use
  // (user types + Enters mid-turn) was retired in Stage 3e because the
  // persistent compositor now handles that natively (queued buffer →
  // setInputMode('idle') flush via the surface's onSubmit handler).
  let seedBuffer: { text: string; attachments: readonly ImageAttachment[] } | undefined;

  // Hoist finally-block variables so they are in scope for cleanup even if
  // armCompositor (or the wiring that follows it) throws before assignment.
  let contextPane: ReturnType<typeof createContextPane> | undefined;
  let bgManager: BackgroundTaskManager | undefined;
  let bgStatusBar: BackgroundStatusBar | undefined;
  let loopStageBar: LoopStageBar | undefined;
  let shellPassthrough: ShellPassthrough | undefined;
  // VerdictLedger hoisted so the finally block can call verdictLedger.stop()
  // even if the wiring block throws before the assignment inside try.
  let verdictLedger: ReturnType<typeof createVerdictLedger> | undefined;
  // First-use notice for ! shell passthrough: shown once per session on the
  // first `!cmd` dispatch so users who relied on `!literal text` as model
  // input are informed of the behavior change and the opt-out flag.
  let shellPassthroughNoticePrinted = false;

  // Session-autosave failure notice. Per-turn autosave is best-effort (it must
  // never break the loop), but a PERSISTENT failure (EACCES, ENOSPC, read-only
  // FS) would silently drop ALL session persistence while the user assumes the
  // conversation is resumable. Surface the FIRST failure per session; stay
  // quiet afterwards so a broken disk doesn't spam the transcript every turn.
  let autosaveFailureLogged = false;

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
  // The try block starts here so a rejection from armCompositor still
  // reaches the finally and surface.dispose() cleans up raw-mode stdin.
  const suggestGhostEnabled = resolveSuggestGhost(env.AFK_SUGGEST_GHOST, ctx.suggestGhostConfig);
  try {
  await surface.armCompositor({
    promptFn: () => buildPrompt(ctx.stats.model, ctx.stats.planMode),
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
  // runTurn handles object below) onto SlashContext so skill-dispatch turns
  // (`/review`, `/mint`, plugin skills) drive the SAME footer rails as normal
  // turns. Without these, the LoopStageBar stays frozen at "observe" and the
  // status line stays at 0%/$0.00 for the entire skill turn — the renderer
  // built by createSkillRenderer had no callback to fire.
  ctx.slashCtx.onStageChange = (stage) => loopStageBar?.repaint(stage);
  ctx.slashCtx.onContextProgress = async () => {
    await ctx.contextSampler.refresh();
    ctx.statusLine.repaint(formatStatusFields(ctx.stats, ctx.contextSampler));
  };
  // Transcript parity for skill turns: runSkillDispatchTurn appends the
  // completed `/skill args → assistant text` exchange through this handle,
  // matching the normal-turn append at onTurnComplete below. Without it,
  // skill-turn output is absent from the autosaved markdown transcript.
  ctx.slashCtx.transcript = transcript;

  // Wire the armed surface into the elicitation handler's compositor ref so
  // ask_question suspend/resume can yield stdin raw-mode to rl.question.
  if (ctx.inputSurfaceRef) {
    ctx.inputSurfaceRef.current = surface;
  }

  // Stable live surface: todo panel is re-painted above each prompt when
  // the content changes (or after a resize). The pane reads the durable
  // store itself, so /todo slash edits propagate without explicit signals.
  contextPane = createContextPane();

  // Verdict ledger — small ring buffer of recent terminal states. Painted as
  // a pinned one-line footer row above the status line (DECSTBM-reserved),
  // coordinated with BackgroundStatusBar via the shared setExtraRows mechanism.
  //
  // Row stacking from bottom:
  //   row N                        = status line  (StatusLine)
  //   row N-1                      = verdict ledger rail (0 or 1 row; fixed)
  //   rows N-1-ledgerRows..N-2     = bg task bar (BackgroundStatusBar, 0+ rows; floats above verdict)
  //
  // Row-count accounting: bgStatusBar and verdictLedger each report their own
  // row count independently. setExtraRows receives the SUM so StatusLine only
  // needs one authority. We track each count separately to compute the sum.
  verdictLedger = createVerdictLedger();
  // Expose ledger reset to the swap path. Mirrors /clear semantics — the
  // outgoing session's trajectory must not contaminate the resumed one.
  // External constraint: the swap callback runs after the pointer flip, so
  // resetting here is safe (no in-flight turn writes to the ledger).
  ctx.clearVerdictLedger = () => verdictLedger?.reset();

  // Background task manager — tracks detached turns (Ctrl+B / /bg).
  // Wire into slash commands so /bg, /tasks, /attach can access it.
  bgManager = new BackgroundTaskManager();
  setBgManager(bgManager);
  setTasksManager(bgManager);
  setAttachManager(bgManager);
  setTasksRegistry(ctx.backgroundRegistry);

  // Row-count accounting for the three reserved footer painters that stack
  // above the status line. Each painter reports its own row count; the status
  // line receives the SUM via setExtraRows, so it has a single authority for
  // how many rows to reserve below the DECSTBM scroll region.
  //
  // Stacking, bottom → top (N = totalRows):
  //   row N                                  StatusLine
  //   row N-1                                verdict ledger rail (0 or 1 row)
  //   rows [N-1-ledgerRows-bgRows .. N-2]    BackgroundStatusBar (0+ rows)
  //   row N - extraRows (topmost reserved)   LoopStageBar (always 1 row)
  //
  //   reserved band = 1 (status) + extraRows, where
  //   extraRows = loopStageRows + bgBarRowCount + ledgerRowCount
  //
  // Each painter positions itself from the live counts: the verdict rail sits
  // at the bottom (getAdjacentRows: () => 0), the bg bar floats just above it
  // (getAdjacentRows: () => ledgerRowCount), and the loop-stage bar reads the
  // full extraRows so it always lands on the topmost reserved row.
  let bgBarRowCount = 0;
  let ledgerRowCount = 0;
  const loopStageRows = 1; // LoopStageBar always occupies exactly 1 row.
  const syncExtraRows = () =>
    ctx.statusLine.setExtraRows(loopStageRows + bgBarRowCount + ledgerRowCount);

  // Register the verdict ledger row-count handler BEFORE constructing the bg
  // bar so its getAdjacentRows closure reads a consistent ledgerRowCount.
  verdictLedger.setRowCountChangeHandler((rows) => {
    ledgerRowCount = rows;
    syncExtraRows();
    // The bars ABOVE the verdict rail (bg bar, loop-stage bar) position
    // themselves from the live counts, but they do not repaint on their own
    // when ledgerRowCount flips. Nudge them to reflow now so they don't keep a
    // stale row until their next independent repaint — critical because the
    // loop-stage bar otherwise only repaints on a stage change, which has
    // already stopped by the time an end-of-turn terminal-state verdict pushes.
    bgStatusBar?.redraw();
    loopStageBar?.redraw();
  });

  bgStatusBar = new BackgroundStatusBar(bgManager, ctx.backgroundRegistry, {
    // Rows that sit between the bg bar and the status line — i.e. the verdict
    // rail. Keeps bg-bar rows from overwriting the verdict row. (LoopStageBar
    // is ABOVE the bg bar, so it is not counted here.)
    getAdjacentRows: () => ledgerRowCount,
  });
  bgStatusBar.setRowCountChangeHandler((rows) => {
    bgBarRowCount = rows;
    syncExtraRows();
  });

  loopStageBar = new LoopStageBar({
    // LoopStageBar paints at totalRows - getExtraRows(), i.e. the topmost
    // reserved row, so it always sits above both the bg bar and the verdict
    // rail regardless of how their counts fluctuate.
    getExtraRows: () => ctx.statusLine.getExtraRows(),
  });
  loopStageBar.setRowCountChangeHandler((_rows) => {
    // LoopStageBar always occupies 1 row (loopStageRows, already in the sum).
    // Its start() fires this with 1 — establishing the base reservation — and
    // stop() with 0. Re-sync the combined total regardless of call order.
    syncExtraRows();
  });

  // Footer self-heal after a full-screen scroll. commitAbove() and
  // evictRowsToScrollback() scroll the WHOLE screen (so displaced lines reach
  // the terminal's scrollback rather than a sub-region's void) via
  // StatusLine.withFullScrollRegion. That scroll drags the reserved footer rows
  // up with it. The status row re-flushes itself inside withFullScrollRegion,
  // but these painters only otherwise repaint on ResizeBus — so without this
  // hook their scrolled-up copies orphan above the status row (#634/#641).
  // Redraw all three so they self-heal exactly like the status line. Each
  // painter brackets its own write in save/restore, so order is cosmetic; we
  // go bottom → top (verdict rail, bg bar, loop-stage bar).
  ctx.statusLine.setAfterScrollRestore(() => {
    verdictLedger?.repaint();
    bgStatusBar?.redraw();
    loopStageBar?.redraw();
  });
  bgStatusBar.start();
  // LoopStageBar must start AFTER bgStatusBar so it reads a fully-initialized
  // extraRows from StatusLine and paints at the correct row.  The bg bar may
  // start with 0 rows (no tasks yet), in which case the loop-stage bar sits
  // immediately above the status line.
  loopStageBar.start();

  // Start the verdict ledger painter. The verdict rail always occupies the
  // fixed slot immediately above the status line (row totalRows-1). The bg
  // bar floats above the verdict rail — it already accounts for the verdict
  // row via getAdjacentRows: () => ledgerRowCount above. The verdict painter
  // itself does NOT need getAdjacentRows because it is always at the bottom
  // of the reserved band, never displaced by anything below it.
  verdictLedger.start({ stream: process.stdout });

  const MAX_BG_NOTIFICATIONS = 50;
  const pendingBgNotifications: BackgroundTask[] = [];
  bgManager.on('complete', (task) => {
    if (pendingBgNotifications.length >= MAX_BG_NOTIFICATIONS) {
      pendingBgNotifications.shift();
    }
    pendingBgNotifications.push(task);
  });

  // Shell-passthrough subsystem — `!cmd` (foreground) and `!&cmd`
  // (background). Distinct from the BackgroundTaskManager above (which
  // detaches MODEL TURNS) and from the BackgroundAgentRegistry (which
  // detaches SUBAGENT DISPATCHES). Naming-collision-safe by living in a
  // separate registry. Wired into the `/sh` slash command so list/show/
  // kill/tail share the same job table.
  //
  // writeLine routes through `replRenderer.writeLine` so the persistent
  // compositor handles DECSTBM scroll-region semantics — a raw stdout
  // write here would corrupt the line tracker (Stage 3e bug class).
  // getCwd is read fresh each invocation so `--worktree` sessions land
  // commands in the worktree, not the host's process.cwd().
  shellPassthrough = new ShellPassthrough({
    writeLine: (text) => ctx.replRenderer.writeLine(text),
    getCwd: () => ctx.stats.cwd,
  });
  setShellPassthrough(shellPassthrough);
  // Expose the foreground-abort closure so the sigint handler installed
  // in `interactive.ts` can route Ctrl+C to the active shell (if any)
  // instead of the exit-cycle. Cleared in finally below.
  turnState.tryAbortShellForeground = () => shellPassthrough!.abortActiveForeground();

  while (true) {
      if (pendingInitMeta) {
        ctx.replRenderer.writeLine(pendingInitMeta);
        ctx.replRenderer.writeLine('');
        pendingInitMeta = null;
      }
      if (pendingShadowingNotices.length > 0) {
        for (const line of pendingShadowingNotices) ctx.replRenderer.writeLine(line);
        ctx.replRenderer.writeLine('');
        pendingShadowingNotices = [];
      }
      while (pendingBgNotifications.length > 0) {
        const task = pendingBgNotifications.shift()!;
        const glyph = task.status === 'succeeded' ? '✓' : '✗';
        const body: string[] = [];
        if (task.resultText) {
          const preview = task.resultText.trim().split('\n')[0]?.slice(0, 80) ?? '';
          if (preview) body.push(preview);
        }
        if (task.error) body.push(task.error.message);
        const statLine = [
          task.stats.toolUses > 0 ? `${task.stats.toolUses} tools` : '',
          task.stats.tokens > 0 ? `${Math.round(task.stats.tokens / 1000)}k tok` : '',
          task.stats.durationMs > 0 ? `${Math.round(task.stats.durationMs / 1000)}s` : '',
        ].filter(Boolean).join(' · ');
        if (statLine) body.push(statLine);
        ctx.replRenderer.writeLine(card({
          kind: task.status === 'succeeded' ? 'checkpoint' : 'diagnosis',
          title: `${glyph} ${task.id} ${task.label}`,
          body,
        }));
        ctx.replRenderer.writeLine('');
      }
      // Shell-passthrough completion notifications — one-line summary per
      // backgrounded `!&cmd` that finished since the last prompt. Kept
      // single-line (instead of `card({...})`) because shell jobs typically
      // produce dense output and a multi-line card adds vertical noise.
      // The injected output reaches the model via `pendingShellInjection`
      // below, so the human-visible notice is summary-only.
      const shellNotifications = shellPassthrough.drainNotifications();
      for (const { job, result } of shellNotifications) {
        const glyph = result.errorReason === undefined ? '✓' : '✗';
        const exitPart = result.errorReason === 'abort'
          ? 'killed'
          : result.errorReason === 'timeout'
            ? 'timed out'
            : result.errorReason === 'signal-killed'
              ? 'killed by signal'
              : `exit ${result.exitCode ?? 0}`;
        const seconds = Math.max(0, Math.round(result.durationMs / 100) / 10);
        ctx.replRenderer.writeLine(
          palette.dim(`  ${glyph} [${job.id}] ${exitPart} · ${seconds}s · `) + job.command,
        );
      }
      const paneLines = contextPane.renderIfChanged(ctx.stats.sessionId);
      if (paneLines.length > 0) {
        for (const l of paneLines) ctx.replRenderer.writeLine(l);
        ctx.replRenderer.writeLine('');
      }
      // Verdict trajectory rail — rendered as a pinned DECSTBM-reserved footer
      // row by verdictLedger itself (started above). No inline writeLine here.
      let text: string;
      let attachments: ReadWithAutocompleteResult['attachments'];

      if (seedBuffer !== undefined) {
        // Slash-command follow-up: a previous handler returned
        // { kind: 'submit', message } to chain itself with a user-text
        // turn. We auto-submit without a second Enter press — the user
        // already expressed intent by running the slash command.
        //
        // Echo routes through `ctx.replRenderer.writeLine` which, when
        // the persistent compositor is armed, commits above the live
        // overlay via compositor.commitAbove (matching the surface's
        // readLine echo path so scrollback parity holds).
        const queued = seedBuffer;
        seedBuffer = undefined;
        const prompt = buildPrompt(ctx.stats.model, ctx.stats.planMode);
        const echo = formatSubmittedEcho({
          buffer: queued.text,
          promptText: prompt,
          isTTY: Boolean(process.stdout.isTTY),
          attachmentSummary: describeAttachmentSummary([...queued.attachments]),
        });
        ctx.replRenderer.writeLine(echo);
        text = queued.text.trim();
        attachments = queued.attachments as ReadWithAutocompleteResult['attachments'];
      } else {
        // Stage 3e: surface.readLine uses the persistent compositor's
        // onSubmit path when armed (TTY); falls back to readWithAutocomplete
        // on non-TTY surfaces. Shift+Tab and onSigint are wired ONCE at
        // armCompositor time (above) — no need to re-pass per-call.
        const result = await surface.readLine({
          promptFn: () => buildPrompt(ctx.stats.model, ctx.stats.planMode),
          onSigint: sigintHandler,
          onShiftTab: () => {
            // Shift+Tab is the keyboard speed lane: a raw plan-mode flip with
            // no seeded turn. It exits plan mode WITHOUT saving or implementing
            // the plan — the manual-takeover escape hatch. (`/plan off`, by
            // contrast, flips and then seeds a save-and-implement turn.)
            togglePlanMode(ctx.slashCtx).catch(() => {});
            ctx.statusLine.rearm();
          },
        });
        text = result.text.trim();
        attachments = result.attachments;
      }
      if (!text && attachments.length === 0) continue;

      // Shell-passthrough branch — `!cmd` foreground / `!&cmd` background.
      // Runs BEFORE the slash check so `!ls /tmp` (which contains a `/`)
      // is unambiguously a shell command, not a slash dispatch. The
      // handler awaits FG to completion before returning so the next
      // prompt appears AFTER the command finishes; BG returns
      // immediately and the completion notification surfaces at the top
      // of the next loop iteration.
      if (text.startsWith('!')) {
        // Respect --no-shell-passthrough (or AFK_SHELL_PASSTHROUGH): skip
        // dispatch entirely and fall through so the model receives the literal
        // `!text` input instead of shelling it out. The env opt-out accepts any
        // common falsy spelling (0 / false / off / no, case-insensitive) so
        // env-based lockdown policies don't silently leave the feature on when
        // they set e.g. AFK_SHELL_PASSTHROUGH=false. (PR #565 review: L1.)
        const shellPassthroughEnvOptOut = /^(0|false|off|no)$/i.test(
          env.AFK_SHELL_PASSTHROUGH ?? '',
        );
        const shellPassthroughEnabled =
          ctx.options.shellPassthrough !== false && !shellPassthroughEnvOptOut;

        if (shellPassthroughEnabled) {
          // First-use notice: inform users of the behavior change on the first
          // `!cmd` dispatch in this session so those who relied on `!literal`
          // as model input discover the opt-out flag promptly.
          if (!shellPassthroughNoticePrinted) {
            shellPassthroughNoticePrinted = true;
            ctx.replRenderer.writeLine(
              palette.dim(
                '  ℹ  ! prefix shells out. Pass --no-shell-passthrough (or set AFK_SHELL_PASSTHROUGH=0) to send ! text to the model instead.',
              ),
            );
          }
          const handled = await shellPassthrough.dispatch(text);
          if (handled) {
            ctx.statusLine.rearm();
            continue;
          }
        }
        // Fall through — either shell passthrough is disabled (literal text
        // sent to the model) or the dispatcher returned false (empty `!`
        // with no body; usage hint already emitted inside the dispatcher).
      }

      // C01: track whether this turn was handled by a native slash command so
      // the preflight block below only fires on the plugin-forward path.
      let isPluginForward = false;
      if (text.startsWith('/')) {
        const res = await dispatchSlash(text, ctx.slashCtx, attachments);
        if (res.handled) {
          if (res.result === 'exit') { ctx.rl.close(); return; }
          if (text === '/clear' || text.startsWith('/clear ')) {
            await transcript.rotateOnClear();
            ctx.replRenderer.writeLine(palette.dim(`  transcript: ${transcript.path()}`));
            // The conversation has been wiped — its verdict trajectory is
            // no longer meaningful. Drop the ledger so the next prompt
            // doesn't carry stale state into a fresh session.
            verdictLedger.reset();
          }
          if (
            res.result !== null &&
            typeof res.result === 'object' &&
            'kind' in res.result &&
            res.result.kind === 'submit'
          ) {
            seedBuffer = { text: res.result.message, attachments: attachments ?? [] };
            ctx.statusLine.rearm();
            continue;
          }
          ctx.statusLine.rearm();
          continue;
        }
        // dispatchSlash returned handled: false. This happens for two reasons:
        //   (a) `forward` — the plugin-skill passthrough: we should run the preflight.
        //   (b) Unrecognized command — falls through to the agent as plain text.
        // In both cases we are in the plugin-forward branch, not a native handler.
        isPluginForward = true;
      }


      // Persist to history ring (slash commands excluded — they're meta, not prompts).
      history.push(text);

      await runFirstTurnHookIfNeeded(ctx, text);

      // SkillPreflight — plugin-forward path only (C01).
      // When a slash command falls through `dispatchSlash` as `forward` —
      // the plugin-skill passthrough — we don't get a chance to mutate the
      // message via buildSkillInvocationMessage. Instead, run any
      // registered preflight here and *prepend* the manifest to the user
      // text. The plugin-skill body still expands from the `/<skill>` line
      // at the tail, so the manifest reads as preceding context that the
      // model has already seen by the time it dispatches the skill.
      //
      // Failure isolation: no preflight registered, or preflight returns
      // null/throws → text passes through verbatim, identical to today.
      // No working-tree mutation, no model round-trip.
      //
      // NOTE: native commands that `dispatchSlash` handles fully always
      // `continue` above and never reach this block — the `isPluginForward`
      // guard is belt-and-suspenders to make the constraint machine-checkable.
      let runText = text;
      if (isPluginForward) {
        const parsed = parseSlash(text);
        if (parsed) {
          // Strip leading '/' and any '<plugin>:' namespace → bare name.
          const bare = parsed.name.replace(/^\//, '').split(':').pop() ?? '';
          // M5: only create the artifact dir (mkdirSync) when a preflight is
          // actually registered for this skill — avoids filesystem noise on the
          // dominant no-preflight path.
          if (bare && getPreflight(bare)) {
            const inv: SkillInvocation = {
              skillName: bare,
              rawArgs: parsed.args,
              // Forward path is plugin-only today — user/project slash commands
              // are handled before this block and never reach the preflight path.
              // If user/project sources are ever forwarded here, derive source
              // from the skill registry origin (cf. builtin-skills.ts#originToSource).
              source: 'plugin',
              capabilities: { compose: true, subagents: true },
            };
            const sessionIdMaybe = ctx.session.current.sessionId;
            const artifactDir = getSkillPreflightDir(sessionIdMaybe);
            // P04: emit a structured debug trace event before/after runPreflight
            // so hot-path duration and success/failure are observable without a
            // full trace writer. Gated on isDebugEnabled() — no overhead in prod.
            // External constraint: debugLog is a no-op unless AFK_DEBUG=1.
            const preflightStart = Date.now();
            debugLog(`[afk trace] preflight.start commandName=${bare}`);
            let preflightSuccess = false;
            const pre = await runPreflight(
              inv,
              // Honor the session's effective cwd so preflights that shell
              // out to `git status` / file globs operate on the worktree,
              // not the Node host's process.cwd() (the parent repo when
              // launched with `afk i --worktree`). `stats.cwd` is stamped
              // at bootstrap.ts:328 with the same `process.cwd()` fallback.
              { cwd: ctx.stats.cwd ?? process.cwd(), artifactDir },
              (err) => {
                // Surface preflight errors in debug mode; swallow in production
                // so a failing context-gather never blocks the skill from running.
                if (isDebugEnabled()) {
                  ctx.replRenderer.writeLine(
                    palette.warning(`⚠ preflight(${bare}) failed: `) +
                      (err instanceof Error ? err.message : String(err)),
                  );
                }
              },
            );
            preflightSuccess = pre !== null;
            debugLog(
              `[afk trace] preflight.end commandName=${bare} durationMs=${Date.now() - preflightStart} success=${preflightSuccess}`,
            );
            // C03: `pre?.manifestBlock` may be undefined (preflight returned null or
            // didn't produce a manifest). stitchForwardManifest is a no-op on
            // undefined/empty — it returns `text` unchanged in that case.
            // Manifest precedes the slash line at the tail so the
            // plugin-skill body expansion still fires. See
            // stitchForwardManifest for the <system-reminder> wrap
            // rationale — this path concatenates into a single user-text
            // payload so it needs an explicit structural marker.
            runText = stitchForwardManifest(pre?.manifestBlock, text);
          }
        }
      }

      // Prepend any pending shell-passthrough output blocks so the model
      // sees `!cmd` output as context for the next user message. Matches
      // Claude Code's transcript-injection semantics: shell output sits
      // between user messages, model reads it on the next turn. The
      // drain clears the buffer atomically — a single message carries
      // every output accumulated since the previous user turn.
      const shellInjection = shellPassthrough.drainInjections();
      if (shellInjection.length > 0) {
        runText = shellInjection + runText;
      }


      await runTurn({ text: runText, attachments }, ctx.session.current, ctx.stats, {
        setInFlight(v: boolean) { turnState.turnInFlight = v; },
        async onTurnComplete(userInput, assistantText) {
          await transcript.appendTurn(userInput, assistantText);
          // Per-turn session autosave → ~/.afk/state/sessions/<sessionId>.json.
          // recordTurn (turn-handler) already folded this turn into ctx.stats
          // and set the auto-name, so persist the live snapshot now. Keyed by
          // sessionId (no override) → one file updated in place, never a
          // duplicate. Crash-safe: a non-graceful exit no longer loses the
          // resumable session — only the markdown transcript was per-turn before.
          //
          // Guard on sessionId: saveSession falls back to a fresh
          // session-<now>.json filename when it's absent, which would spawn a
          // NEW file every turn. The provider sets sessionId by the first
          // turn's recordTurn in the common case; rare providers that emit none
          // fall back to the single on-exit save instead of forking sidecars.
          if (ctx.stats.sessionId) {
            try {
              saveSession(ctx.stats);
            } catch (err) {
              // Best-effort — autosave must never break the REPL loop. But
              // surface the FIRST failure per session (autosaveFailureLogged)
              // so a persistent EACCES/ENOSPC isn't silently swallowed every
              // turn while the user assumes the conversation is resumable.
              if (!autosaveFailureLogged) {
                autosaveFailureLogged = true;
                ctx.replRenderer.writeLine(
                  palette.warning('⚠ ') +
                    'session autosave failed — this conversation may not be resumable: ' +
                    (err instanceof Error ? err.message : String(err)),
                );
              }
            }
          }
        },
        async onAfterTurn() {
          await ctx.contextSampler.onTurn(ctx.stats.totalTurns);
          ctx.statusLine.rearm();
          // Reset the loop-stage bar to 'observing' so the footer rail shows
          // a clean "waiting" state between turns rather than the last active
          // stage from the completed turn (which could be any of the five).
          loopStageBar?.repaint('observing');
        },
        rearmStatus: () => ctx.statusLine.rearm(),
        onTerminalState: (state) => verdictLedger?.push(state),
        setActiveCompositor: (c) => {
          // Publish the active compositor for the SIGINT handler (which
          // routes the interrupt notice through `commitAbove` when an
          // overlay is live). Do NOT call `ctx.replRenderer.setCompositor(c)`
          // here — the persistent compositor was already wired onto
          // `replRenderer` once at `armCompositor` time above, and
          // toggling it to `null` in turn-handler's finally would re-
          // expose the original Stage-3e bug: top-of-loop `writeLine`
          // calls would fall through to raw stdout.write while the
          // persistent compositor stays armed, corrupting log-update's
          // line tracker.
          turnState.activeCompositor = c;
        },
        setInterruptNotifier: (fn) => {
          turnState.notifyInterrupting = fn;
        },
        // The StatusLine doubles as a DECSTBM scroll-region guard so that
        // mid-turn `commitAbove` writes (tool labels, agent banners, etc.)
        // enter terminal scrollback instead of being silently clipped by
        // the persistent sub-region scroll.
        scrollRegion: ctx.statusLine,
        // Stage 3e: expose the surface's persistent compositor + per-turn
        // background/soft-stop handler swaps to the turn handler. All are
        // no-ops on non-TTY surfaces (surface.getCompositor() returns null;
        // set*Handler calls are benign mutations of null refs).
        getCompositor: () => surface.getCompositor(),
        setBackgroundHandler: (handler) => surface.setBackgroundHandler(handler),
        setSoftStopHandler: installSoftStop,
        async onContextProgress() {
          await ctx.contextSampler.refresh();
          ctx.statusLine.repaint(formatStatusFields(ctx.stats, ctx.contextSampler));
        },
        // Repaint the LoopStageBar footer row whenever the agent's loop stage
        // transitions.  The bar is a per-session singleton; the callback is
        // safe to call on non-TTY (LoopStageBar.repaint() TTY-gates itself).
        ...(loopStageBar ? { onStageChange: (stage) => loopStageBar!.repaint(stage) } : {}),
      }, ctx.options.thinkingUi, ctx.completionWriter, bgManager,
        // Surface refs threaded into the per-turn StreamRenderer for the
        // legacy non-borrow path (non-TTY, when surface.getCompositor()
        // is null and the renderer constructs its own compositor). In
        // the persistent-compositor path, these refs are already wired
        // by armCompositor and the renderer's borrow skips this branch
        // — passing them anyway is a defensive belt-and-suspenders for
        // surfaces that haven't armed (e.g. a future test path).
        surface.toRunTurnRefs(buildPrompt(ctx.stats.model, ctx.stats.planMode)),
      );
    }
  } finally {
    // Drain BackgroundTaskManager: bgManager is local to runReplLoop and is
    // never attached to ctx, so the session teardown's registerCleanup
    // handler in interactive.ts (which calls ctx.backgroundRegistry.cancelAll())
    // operates on a different registry object. Any Ctrl+B tasks still
    // 'running' at REPL exit would otherwise stay that way permanently in the
    // manager's Map — a data-integrity violation that the planned unified
    // ActiveWorkRegistry would inherit. cancel() is synchronous and
    // idempotent; drain before bgStatusBar.stop() so the bar's 'complete'
    // listener is still active when the final state transitions fire.
    if (bgManager !== undefined) {
      for (const t of bgManager.running()) {
        bgManager.cancel(t.id);
      }
    }
    // Drain ShellPassthrough — kills every `!&cmd` background shell that
    // is still running. Same lifecycle rationale as bgManager above: the
    // shell jobs are owned by this loop, must not outlive it. Clear the
    // sigint hook BEFORE the drain so a Ctrl+C during shutdown doesn't
    // race a half-torn-down passthrough into killing nothing.
    turnState.tryAbortShellForeground = null;
    shellPassthrough?.drainOnExit();
    // Stop the footer painters top → bottom so each clears the exact row it
    // painted before the counts below it change. LoopStageBar positions from
    // the full extraRows, so it must clear before bgStatusBar/verdictLedger
    // shrink their counts. The bg bar's clear row depends on the verdict count
    // (its getAdjacentRows), so it must clear before the verdict ledger drops
    // ledgerRowCount to 0. The verdict rail sits at the bottom (row N-1),
    // independent of the others.
    loopStageBar?.stop();
    bgStatusBar?.stop();
    verdictLedger?.stop();
    contextPane?.dispose();
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
