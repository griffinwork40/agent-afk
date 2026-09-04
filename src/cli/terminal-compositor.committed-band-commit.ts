/**
 * Committed-band lifecycle — `commitAbove` (the above-frame / scrollback commit
 * pipeline), band clear/reset, resize ghost-erase, and band repositioning —
 * extracted from terminal-compositor.ts. Follows the free-functions-on-host
 * pattern used by the sibling paste/autocomplete/render modules: the
 * TerminalCompositor owns all band state; these functions read and MUTATE the
 * narrow {@link CommittedBandHost} slice it passes as `self`. No behavior
 * change — bodies are byte-for-byte moves with `this.` rewritten to `self.`
 * and the intra-cluster `clearCommittedBand` call made a direct module call.
 *
 * The band fields stay on the class (not lifted into a sub-object) because the
 * resize / scrollback test suite reaches into them directly; this module only
 * borrows them through the host interface.
 */

import type { LogUpdateFn, CompositorScrollRegionGuard, BandRowMeta } from './terminal-compositor.types.js';
import type { BandReflowCache } from './terminal-compositor.band-reflow.js';
import {
  reflowCommittedBandToWidth,
} from './terminal-compositor.band-reflow.js';
import { boundLineToTerminal } from './render/bounded-line.js';
import { writeWithScrollGuard } from './terminal-compositor.commit-guard.js';
import { decomposeCommitText } from './terminal-compositor.commit-text.js';
import { snapshotCommitGeometry } from './terminal-compositor.commit-geometry.js';
import { routeCommit } from './terminal-compositor.commit-route.js';
import { commitPhase1Teardown } from './terminal-compositor.commit-phase1.js';
import { commitPhase3Hold, commitPhase3HoldStore } from './terminal-compositor.commit-phase3-hold.js';
import { commitPhase3Band } from './terminal-compositor.commit-phase3-band.js';

/**
 * Narrowest TerminalCompositor state slice the committed-band functions touch.
 * The band-tracking fields, commit-state flags, and `pendingResizeErase` are
 * mutated in place; `scrollRegion`/`stdout` are read-only collaborators; and
 * `repaint`/`debugLog` are class methods the functions call back into.
 */
export interface CommittedBandHost {
  /** Re-render the live frame (Phase 2 of commitAbove). */
  repaint(): void;
  /** Structured debug tracer (no-op unless compositor debugging is enabled). */
  debugLog(stage: string, extra?: Record<string, unknown>): void;
  /** The full contiguous on-screen committed run adjacent to the frame top. */
  committedBand: string[];
  /** Per-physical-row logical provenance, index-aligned 1:1 with committedBand (#540). */
  committedBandMeta: BandRowMeta[];
  committedBandTopRow: number;
  committedBandBottomRow: number;
  /** Real unpadded frame top from the last repaint's measure() — see the field
   *  doc on the class. Routing (prevTopRow) trusts this over logUpdate.topRow. */
  lastMeasuredFrameTop: number;
  /** How many of committedBand's rows (its bottom suffix) are painted on screen. */
  committedBandPaintedRows: number;
  /** Memoization for reflowCommittedBandToWidth — see the field doc on the class. */
  bandReflowCache: BandReflowCache | null;
  /** Re-entrancy guard: suppresses a repaint during the clear→write window. */
  committing: boolean;
  /** Suppresses the shrink re-pin (repositionCommittedBand) for a commit. */
  commitInFlight: boolean;
  /** Whether any commit has happened this arm cycle (guards growthDeficit). */
  hasCommitted: boolean;
  /** Stale-guard for endTurnFlush: true when committed-band state has changed
   *  since the last flush. Cleared by clearCommittedBand(); mirrors bandGeometryStale. */
  lifecycleStateDirty: boolean;
  /** Pre-resize on-screen footprint to physically erase on the next repaint. */
  pendingResizeErase: { top: number; bottom: number } | null;
  /**
   * F2: true from the SIGWINCH-immediate handler until the next debounced
   * repaint re-establishes real frame geometry. See the field doc on the
   * class (terminal-compositor.ts) for the full failure mode this guards.
   */
  bandGeometryStale: boolean;
  /** Pre-arm content ceiling — committed text never lands above this row. */
  anchorRow: number | undefined;
  /** Whether the compositor currently holds raw mode + the keypress listener. */
  armed: boolean;
  /** The single log-update region tracker; null when not armed. */
  logUpdate: LogUpdateFn | null;
  /** DECSTBM scroll-region guard; absent when no status line is active. */
  readonly scrollRegion?: CompositorScrollRegionGuard;
  readonly stdout: NodeJS.WriteStream;
}

export function commitAbove(self: CommittedBandHost, text: string): void {
  self.debugLog('commitAbove:enter', { textLen: text.length, anchorRow: self.anchorRow ?? null, committing: self.committing, topRow: self.logUpdate?.topRow ?? null });

  if (!self.armed || !self.logUpdate) {
    // Disarmed: no frame, no band, no reflow — this is a raw terminal write,
    // so it is bounded here. The armed path below hard-wraps to `cols` as part
    // of its row accounting (line-count math depends on it) and must not be
    // pre-wrapped by this call.
    const bounded = boundLineToTerminal(text, self.stdout);
    writeWithScrollGuard(self, () => {
      self.stdout.write(bounded + '\n');
    });
    return;
  }
  // Invariant: logUpdate.clear() → scrollback write → repaint() must be
  //   atomic w.r.t. re-entrant repaint(); the `committing` flag enforces self.
  //
  // log-update tracks the overlay+input region. clear() erases it and
  // returns the cursor to the top of that region. stdout.write(text+'\n')
  // then injects text into the scrollback, pushing the cursor below it.
  // repaint() re-tracks a fresh frame from the new cursor position.
  //
  // The `committing` guard suppresses any re-entrant repaint() that fires
  // synchronously during the clear→write window (e.g. a resize event flushed
  // mid-stack, or any future caller that triggers repaint via setOverlay
  // while commitAbove is in flight). Without it, a second frame would be
  // drawn on top of the just-cleared region and the spinner row would be
  // stranded in scrollback. `try/finally` guarantees the flag is reset even
  // if logUpdate.clear() or stdout.write() throws (e.g. TTY closed
  // mid-session) — otherwise the compositor would go permanently deaf to
  // repaint() for the rest of the session.
  //
  // Ordering note: logUpdate.clear() walks the cursor up to the top of
  // the previous frame, then writeWithGuard wraps ONLY the
  // scrollback-bound `stdout.write(text + '\n')`. We don't wrap the
  // clear() because (a) its erase-line ANSI doesn't interact with
  // DECSTBM scroll semantics, and (b) wrapping it would also flush the
  // status line mid-commit, producing visible flicker on every
  // commitAbove during a turn.

  // Compute line count from the text (each newline delimits a row;
  // trailing \n is the line terminator, not its own row).
  const rows = Math.max(1, self.stdout.rows ?? 24);
  const cols = Math.max(1, self.stdout.columns ?? 80);

  // F1 (retained-logical-source re-wrap): the prior band was hard-wrapped at
  // WHATEVER width was current when IT was committed — possibly a resize or
  // several ago. Re-wrap it to the CURRENT `cols` before any of the geometry
  // below reads `self.committedBand`/`committedBandBottomRow` (the merge
  // contiguity check, decideCommitMode's overflowRun, and Phase 3's merge all
  // read the band) — see terminal-compositor.band-reflow.ts's module doc for
  // why a stale-width row can never be trusted verbatim again. No-op (and
  // free) when nothing has resized since the band was last reflowed.
  reflowCommittedBandToWidth(self, cols);

  const t = decomposeCommitText(text, cols);
  const geo = snapshotCommitGeometry(self, t.contentLineCount, rows, cols);
  const route = routeCommit(self, t, geo);

  // Suppress the shrink re-pin for the whole commit; Phase 3 sets the band.
  // Re-armed at the top of every commitAbove, so a throw on a dying TTY (the
  // only realistic escape — Phase 3's stdout.write under writeWithGuard) that
  // skips the Phase-3 reset only suppresses a visual nicety for a session
  // that is already ending; the next commit re-arms it. No try/finally needed.
  self.commitInFlight = true;
  self.committing = true;
  // Rows Phase 1 scrolls into scrollback this commit (set inside the guard).
  // The whole screen — banner included — scrolls up by this many rows, so the
  // anchor floor must drop to match (see the decrement after the finally).
  let scrolledRows = 0;
  try {
    self.logUpdate.clear(geo.extraRows);
    scrolledRows = commitPhase1Teardown(self, geo, route);
  } finally {
    self.committing = false;
    self.debugLog('commitAbove:finally');
  }

  // Invariant (floor follows the scroll): Phase 1 scrolled `scrolledRows` rows
  // off the top of the screen. The banner occupying rows [1, anchorRow-1]
  // scrolled up with everything else, so the protected ceiling shrinks by the
  // same amount — exactly as the evict path in preserveRowsBeforeFrameRender
  // does (anchorRow -= deficit). Without this the floor goes stale, the
  // above-frame room never grows, committed content orphans in the vacated
  // banner rows, and a later overlay collapse loses it. Clamp at 1; once the
  // banner is fully in scrollback the path matches the no-banner case.
  if (scrolledRows > 0 && self.anchorRow !== undefined && self.anchorRow > 1) {
    self.anchorRow = Math.max(1, self.anchorRow - scrolledRows);
  }
  // Mark that a commit has happened this arm cycle so growthDeficit in
  // repaint() knows there is transcript content above the frame to protect.
  self.hasCommitted = true;
  // Mark the compositor state as dirty so endTurnFlush (lifecycle.ts) knows
  // a redraw is warranted. Mirrors the bandGeometryStale setter pattern.
  self.lifecycleStateDirty = true;

  // Phase 2: repaint the live frame at its normal bottom-anchored
  // position. The repaint() does its own erase+paint via render(),
  // landing the new frame at `newTopRow..rows-1` regardless of how
  // big the previous frame was.
  self.debugLog('commitAbove:phase2:repaint');
  self.repaint();
  self.debugLog('commitAbove:phase2:done', { newTopRow: self.logUpdate.topRow ?? null });

  // Phase 3: write the committed text at rows `newTopRow -
  // lineCount..newTopRow - 1` (immediately above the live frame) so it's
  // visible without scrolling.
  //
  // In the fitsAboveFrame case this is the SOLE copy of the block — Phase 1
  // scrolled only the band overflow (oldest lines that no longer fit) into
  // scrollback, never the new block itself. The copy stays visible and is
  // kept durable across a later overlay growth by repaint()'s evict-on-growth
  // (which scrolls it into scrollback rather than letting the taller frame
  // overwrite it); it also flows into scrollback on its own as later commits
  // evict it.
  //
  // In the overflow case Phase 1 already archived the whole block at
  // anchorFloor, so this paints only the top lines that fit.
  //
  // Edge cases:
  // - `topRow` is 0 or 1: no above-frame area exists, skip phase 3.
  // - `lineCount > newTopRow - anchorFloor`: only the lines that fit between
  //   anchorFloor and the frame are painted; in the overflow path the rest
  //   are already in scrollback (Phase 1) — never CUP-written below
  //   anchorFloor.
  const newTopRow = self.logUpdate.topRow ?? 0;
  if (newTopRow > 1) {
    // Measure room against the POST-scroll floor: the anchorRow decrement above
    // lowered the ceiling by `scrolledRows`, so the newly-vacated banner rows
    // are now legitimately available to the band. Using the stale pre-scroll
    // anchorFloor would keep maxRun pinned and re-trigger the cap-to-one-row bug.
    const postScrollFloor = Math.max(self.anchorRow ?? 1, 1);
    const maxRun = Math.max(0, newTopRow - postScrollFloor);
    if (route.useBandHold) {
      commitPhase3Hold(self, geo, route, newTopRow, maxRun);
    } else {
      commitPhase3Band(self, geo, route, newTopRow, maxRun, postScrollFloor);
    }
  } else if (route.useBandHold) {
    commitPhase3HoldStore(self, geo, route);
  } else {
    clearCommittedBand(self);
  }

  self.commitInFlight = false;
  self.debugLog('commitAbove:phase3:done');
}

export function clearCommittedBand(self: CommittedBandHost): void {
  self.committedBand = [];
  self.committedBandMeta = [];
  self.committedBandTopRow = 0;
  self.committedBandBottomRow = 0;
  self.committedBandPaintedRows = 0;
  // Explicit reset (also self-invalidates via reflowCommittedBandToWidth's
  // reference check once committedBand is reassigned above, but an empty band
  // never needs a cache entry either way).
  self.bandReflowCache = null;
  // Clear the stale-guard so the next endTurnFlush call (after the next commit)
  // does not skip its redraw on an already-flushed band.
  self.lifecycleStateDirty = false;
}

/**
 * Drop the retained above-frame committed band + commit-presence flags
 * WITHOUT tearing down the arm cycle (input core, autocomplete, paste and
 * resize state all stay live). Called from the REPL `/clear` path
 * (clearScreen, bootstrap.ts) so a physical screen wipe also discards the
 * stale transcript band.
 *
 * Invariant: must run BEFORE the `\x1b[3J\x1b[2J\x1b[H` wipe. A band that
 * survives the clear is CUP-painted back onto the freshly-cleared screen by
 * repositionCommittedBand() on the next shrink repaint — e.g. when a
 * slash-command menu opens (overlay grows) then collapses (overlay shrinks),
 * resurrecting the previous session's transcript. Mirrors the band-reset
 * trio in resetState(); see that method for the full disarm semantics.
 */
export function resetCommittedBand(self: CommittedBandHost): void {
  self.hasCommitted = false;
  clearCommittedBand(self);
  self.commitInFlight = false;
}
