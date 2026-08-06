import type { InteractiveCtx } from './shared.js';
import { createContextPane } from './context-pane.js';
import { createVerdictLedger } from './verdict-ledger.js';
import { BackgroundStatusBar } from '../../background-status-bar.js';
import { LoopStageBar } from './loop-stage.js';
import { LiveMascot } from './mascot-live.js';
import { ShellPassthrough } from './shell-passthrough.js';
import { BgResultNotifier } from './bg-result-notifier.js';
import { setShellPassthrough } from '../../slash/commands/sh.js';
import type { TurnState } from './repl-loop-shared.js';

/**
 * The persistent footer subsystems owned by a single `runReplLoop`. Returned
 * by {@link setupFooterSubsystems} so the loop body can read them (dispatch
 * shell, repaint stage rail, push verdicts) and the orchestrator's `finally`
 * can tear them down in the inverse order they were started.
 */
export interface FooterSubsystems {
  contextPane: ReturnType<typeof createContextPane>;
  bgStatusBar: BackgroundStatusBar;
  loopStageBar: LoopStageBar;
  liveMascot: LiveMascot;
  verdictLedger: ReturnType<typeof createVerdictLedger>;
  shellPassthrough: ShellPassthrough;
  bgResultNotifier: BgResultNotifier;
}

/**
 * Phase 2 of the REPL loop — footer subsystems.
 *
 * Builds the context pane, verdict ledger, background status bar (subagent
 * jobs only), loop-stage bar, and shell-passthrough subsystem, wires their
 * reserved DECSTBM row accounting, and starts the painters.
 *
 * Mutates `ctx` (clearVerdictLedger, slash-command registry singletons via the
 * `set*` calls) and `turnState` (tryAbortShellForeground). Must run AFTER
 * {@link setupSurface} so the persistent compositor already owns stdout before
 * any reserved-row painter starts.
 *
 * Teardown is the orchestrator's responsibility (the `finally` block): it must
 * stop the painters top → bottom (bgStatusBar → verdictLedger) so each clears
 * the exact row it painted before the counts below it change. The loop-stage
 * rail and the live mascot own no rows — they are frame content pulled by the
 * compositor — so they stop ahead of the reserved painters, silencing their
 * tickers before the frame they feed goes away.
 */
export function setupFooterSubsystems(
  ctx: InteractiveCtx,
  turnState: TurnState,
): FooterSubsystems {
  // Stable live surface: todo panel is re-painted above each prompt when
  // the content changes (or after a resize). The pane reads the durable
  // store itself, so /todo slash edits propagate without explicit signals.
  const contextPane = createContextPane();

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
  const verdictLedger = createVerdictLedger();
  // Expose ledger reset to the swap path. Mirrors /clear semantics — the
  // outgoing session's trajectory must not contaminate the resumed one.
  // External constraint: the swap callback runs after the pointer flip, so
  // resetting here is safe (no in-flight turn writes to the ledger).
  ctx.clearVerdictLedger = () => verdictLedger.reset();

  // Row-count accounting for the two reserved footer painters that stack above
  // the status line. Each reports its own row count; the status line receives
  // the SUM via setExtraRows, so it has a single authority for how many rows to
  // reserve below the DECSTBM scroll region.
  //
  // Stacking, bottom → top (N = totalRows):
  //   row N                                  StatusLine
  //   row N-1                                verdict ledger rail (0 or 1 row)
  //   rows [N-1-ledgerRows-bgRows .. N-2]    BackgroundStatusBar (0+ rows)
  //   row N-1-extraRows                      input line  ─┐ compositor frame,
  //   row N-2-extraRows                      loop rail   ─┘ NOT reserved rows
  //
  //   reserved band = 1 (status) + extraRows, where
  //   extraRows = bgBarRowCount + ledgerRowCount
  //
  // Each reserved painter positions itself from the live counts: the verdict
  // rail sits at the bottom (getAdjacentRows: () => 0) and the bg bar floats
  // just above it (getAdjacentRows: () => ledgerRowCount).
  //
  // History: the loop-stage rail and the goblin sprite used to be reserved
  // tenants here too (1 row and 3 rows). That forced the bottom-pinned input
  // frame four rows up, so the prompt rendered ABOVE its own stage rail with
  // three mostly-blank rows beneath it — the sprite is right-aligned, so their
  // left two-thirds was dead space directly under the typing line. Both are
  // compositor frame content now: the rail is the line above the input, and the
  // sprite is composited onto the right edge of the frame's last rows. They
  // contribute 0 to extraRows, which also removes them from the DECSTBM churn
  // behind the #634/#641 "vanished rail" regressions.
  let bgBarRowCount = 0;
  let ledgerRowCount = 0;
  const syncExtraRows = () =>
    ctx.statusLine.setExtraRows(bgBarRowCount + ledgerRowCount);

  /**
   * Ask the persistent compositor to repaint.
   *
   * Both inline footer tenants — the loop-stage rail and the goblin sprite —
   * are compositor FRAME content now rather than reserved rows, so a stage
   * change or an animation tick only reaches the screen when the frame is
   * redrawn. Resolved lazily through the surface ref because the compositor is
   * armed one phase earlier (setupSurface) and may be disarmed before us.
   */
  const requestCompositorRepaint = (): void => {
    ctx.inputSurfaceRef?.current?.getCompositor()?.repaint();
  };

  // Hoisted so the verdict-ledger row-count handler (registered before the
  // bars are constructed) can reference them via closure. Both are assigned
  // unconditionally below — the `?.` in the handler guards the window before
  // assignment (the handler only fires once a count actually changes).
  let bgStatusBar: BackgroundStatusBar | undefined;
  let loopStageBar: LoopStageBar | undefined;
  let liveMascot: LiveMascot | undefined;

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
  });

  bgStatusBar = new BackgroundStatusBar(ctx.backgroundRegistry, {
    // Rows that sit between the bg bar and the status line — i.e. the verdict
    // rail. Keeps bg-bar rows from overwriting the verdict row. (LoopStageBar
    // is ABOVE the bg bar, so it is not counted here.)
    getAdjacentRows: () => ledgerRowCount,
  });
  bgStatusBar.setRowCountChangeHandler((rows) => {
    bgBarRowCount = rows;
    syncExtraRows();
    // Nothing above the bg bar owns a reserved row any more — the rail and the
    // sprite are compositor frame content, and the frame re-derives its own
    // bottom row from getExtraRows() on its next repaint. The stale-row nudges
    // that used to live here are structurally unnecessary.
  });

  // Reacting goblin sprite (issue #336) — opt-in via AFK_GOBLIN_MASCOT=1, inert
  // otherwise. `LiveMascot` owns the state machine, the alert dwell and the
  // frame clock; it owns no rows and no stream. Its frames reach the screen by
  // being PULLED into the compositor frame (surface-setup's `getMascotLines`),
  // so a sprite change can never become a geometry change — the property the
  // reserved band enforced by convention is now structural.
  liveMascot = new LiveMascot({ requestRepaint: requestCompositorRepaint });

  loopStageBar = new LoopStageBar({
    // Inline: the rail is a frame line directly above the input, so the prompt
    // renders BELOW its own stage rail. `getExtraRows` is still supplied
    // because the reserved-row path remains the default for other callers.
    getExtraRows: () => ctx.statusLine.getExtraRows(),
    inline: true,
    requestRepaint: requestCompositorRepaint,
  });
  loopStageBar.setRowCountChangeHandler((_rows) => {
    // Inline mode always publishes 0. Re-sync unconditionally so the
    // accumulator keeps a single authority regardless of the bar's mode.
    syncExtraRows();
  });

  // Footer self-heal after a full-screen scroll. commitAbove() and
  // evictRowsToScrollback() scroll the WHOLE screen (so displaced lines reach
  // the terminal's scrollback rather than a sub-region's void) via
  // StatusLine.withFullScrollRegion. That scroll drags the reserved footer rows
  // up with it. The status row re-flushes itself inside withFullScrollRegion,
  // but these painters only otherwise repaint on ResizeBus — so without this
  // hook their scrolled-up copies orphan above the status row (#634/#641).
  // Redraw the two remaining reserved painters so they self-heal exactly like
  // the status line. Each brackets its own write in save/restore, so order is
  // cosmetic; we go bottom → top (verdict rail, bg bar). The rail and the
  // sprite are deliberately absent: they are compositor frame content now, and
  // the compositor repaints the frame as part of the same scroll — which is
  // exactly the orphaning this hook was added to paper over.
  ctx.statusLine.setAfterScrollRestore(() => {
    verdictLedger.repaint();
    bgStatusBar?.redraw();
  });
  bgStatusBar.start();
  // Arm the mascot state machine before the rail. Neither reserves rows, so
  // this ordering is no longer load-bearing for geometry — but the mascot's
  // start() requests a compositor repaint, and doing that first means the
  // frame's first paint already carries the resting sprite.
  liveMascot.start();
  loopStageBar.start();

  // Start the verdict ledger painter. The verdict rail always occupies the
  // fixed slot immediately above the status line (row totalRows-1). The bg
  // bar floats above the verdict rail — it already accounts for the verdict
  // row via getAdjacentRows: () => ledgerRowCount above. The verdict painter
  // itself does NOT need getAdjacentRows because it is always at the bottom
  // of the reserved band, never displaced by anything below it.
  verdictLedger.start({ stream: process.stdout });

  // Shell-passthrough subsystem — `!cmd` (foreground) and `!&cmd`
  // (background). Distinct from the BackgroundAgentRegistry (which
  // detaches SUBAGENT DISPATCHES). Naming-collision-safe by living in a
  // separate registry. Wired into the `/sh` slash command so list/show/
  // kill/tail share the same job table.
  //
  // writeLine routes through `replRenderer.writeLine` so the persistent
  // compositor handles DECSTBM scroll-region semantics — a raw stdout
  // write here would corrupt the line tracker (Stage 3e bug class).
  // getCwd is read fresh each invocation so `--worktree` sessions land
  // commands in the worktree, not the host's process.cwd().
  const shellPassthrough = new ShellPassthrough({
    writeLine: (text) => ctx.replRenderer.writeLine(text),
    getCwd: () => ctx.stats.cwd,
  });
  setShellPassthrough(shellPassthrough);
  // Expose the foreground-abort closure so the sigint handler installed
  // in `interactive.ts` can route Ctrl+C to the active shell (if any)
  // instead of the exit-cycle. Cleared in the orchestrator's finally.
  turnState.tryAbortShellForeground = () => shellPassthrough.abortActiveForeground();

  // Background-subagent auto-delivery — buffers settled jobs' results for
  // next-turn injection + one-line completion notices, mirroring the
  // ShellPassthrough drain contract. Subscribed here (with the other
  // registry-driven subsystems); unsubscribed by the orchestrator's finally
  // via dispose() so a swapped/late-settling job can't touch a dead buffer.
  const bgResultNotifier = new BgResultNotifier(ctx.backgroundRegistry);
  // Expose buffer reset to the /resume swap path (mirrors clearVerdictLedger):
  // jobs settled under the outgoing session must not inject into the resumed
  // session's first turn.
  ctx.clearBgResultBuffer = () => bgResultNotifier.reset();

  return {
    contextPane,
    bgStatusBar,
    loopStageBar,
    liveMascot,
    verdictLedger,
    shellPassthrough,
    bgResultNotifier,
  };
}
