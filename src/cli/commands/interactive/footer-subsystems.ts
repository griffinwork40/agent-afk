import type { InteractiveCtx } from './shared.js';
import { createContextPane } from './context-pane.js';
import { createVerdictLedger } from './verdict-ledger.js';
import { BackgroundStatusBar } from '../../background-status-bar.js';
import { LoopStageBar } from './loop-stage.js';
import { MascotBar } from './mascot-bar.js';
import { HealthRail } from '../../health-rail.js';
import { ShellPassthrough } from './shell-passthrough.js';
import { BgResultNotifier } from './bg-result-notifier.js';
import type { PeerInboxNotifier } from './peer-inbox-notifier.js';
import { buildAndWirePeerNotifier } from './footer-subsystems.peer.js';
import { setShellPassthrough } from '../../slash/commands/sh.js';
import type { TurnState } from './repl-loop-shared.js';
import { startFooterPainters } from './footer-painters.js';

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
  mascotBar: MascotBar;
  healthRail: HealthRail;
  verdictLedger: ReturnType<typeof createVerdictLedger>;
  shellPassthrough: ShellPassthrough;
  bgResultNotifier: BgResultNotifier;
  peerNotifier: PeerInboxNotifier;
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
 * stop the painters top → bottom (loopStageBar → mascotBar → bgStatusBar →
 * verdictLedger)
 * so each clears the exact row it painted before the counts below it change.
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

  // Row-count accounting for the reserved footer painters that stack above the
  // status line. Each painter reports its own row count; the status line
  // receives the SUM via setExtraRows, so it has a single authority for how
  // many rows to reserve below the DECSTBM scroll region.
  //
  // Stacking, bottom → top (N = totalRows):
  //   row N                                  StatusLine
  //   row N-1                                verdict ledger rail (0 or 1 row)
  //   rows [N-1-ledgerRows-bgRows .. N-2]    BackgroundStatusBar (0+ rows)
  //   rows above those                       MascotBar (0 or 3 rows, transient)
  //   row N - extraRows (topmost loop-stage) LoopStageBar (always 1 row)
  //   row N - extraRows + 1                  HealthRail (always 1 row; below loop-stage)
  //
  //   reserved band = 1 (status) + extraRows, where
  //   extraRows = healthRailRows + loopStageRows + mascotRowCount
  //             + bgBarRowCount + ledgerRowCount
  //
  // HealthRail paints at totalRows - getExtraRows() + 1 (one row below the
  // loop-stage bar). Both bars' rows are already counted in extraRows, so
  // both paint within the reserved band without touching the scroll region.
  const { bgStatusBar, loopStageBar, mascotBar, healthRail } = startFooterPainters(ctx, verdictLedger);

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
  // Expose buffer reset so the /resume swap path can drop outgoing-session jobs.
  ctx.clearBgResultBuffer = () => bgResultNotifier.reset();
  return {
    contextPane,
    bgStatusBar,
    loopStageBar,
    mascotBar,
    healthRail,
    verdictLedger,
    shellPassthrough,
    bgResultNotifier,
    // buildAndWirePeerNotifier also wires ctx.resetPeerNotifier for /resume.
    peerNotifier: buildAndWirePeerNotifier(ctx),
  };
}
