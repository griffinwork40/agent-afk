/**
 * Resize coordinator — extracted from terminal-compositor.lifecycle.ts (#2108).
 *
 * Contains the two resize-handling paths that live inside `arm()`:
 *   1. `handleResizeImmediate` — fired synchronously on SIGWINCH (before any
 *      mid-window repaint), snapshots the pre-resize ghost footprint and marks
 *      geometry stale.
 *   2. `handleDisarmWindowResize` — called once at re-arm time to detect a
 *      SIGWINCH that arrived while disarmed and apply the same ghost-erase +
 *      stale-mark logic without a live subscriber.
 *
 * Both functions are side-effect-only (no I/O, no rendering) — the actual
 * erase/repaint happens on the next call to `repaint()`.
 */

import { resetArchivedReveal } from './terminal-compositor.archived-reveal.js';
import type { LifecycleHost } from './terminal-compositor.lifecycle.js';
import { requestCprOrMarkDirty } from './terminal-compositor.lifecycle.cpr.js';

/**
 * Synchronous SIGWINCH handler fired by ResizeBus.subscribeImmediate().
 *
 * On EXPAND: snapshots the pre-resize frame/band footprint into
 * `pendingResizeErase` AND emits a CPR request (ESC[6n) so the compositor can
 * measure the exact row-shift tmux applied when it pulled history lines back
 * onto the screen. The CPR reply arrives on stdin and is intercepted by the
 * one-shot data listener installed inside requestCprAndApplyDelta — BEFORE
 * readline's emitKeypressEvents can surface it as a keypress — so it never
 * leaks into the prompt as text. Once the reply arrives (or the 120 ms timeout
 * fires), the tracked absolute rows are translated by delta and repaint() is
 * called. While the CPR is pending, Frame.repaint() suppresses its write so
 * the stale-row repaint cannot race the delta correction.
 *
 * On SHRINK: if a CPR is already in-flight (cprPending), the existing
 * snapshot is merged (min top / max bottom) rather than discarded — the
 * pending CPR still needs it to drive the ghost-row erase on repaint.
 * When no CPR is pending, any stale EXPAND snapshot is dropped as before.
 *
 * On WIDTH-ONLY (net-zero rows): snapshots the footprint for ghost-row erase
 * (same as EXPAND) and emits a CPR to trigger a clean repaint after tmux
 * reflows any soft-wrapped lines in the changed-width pane.
 *
 * Contract: no I/O beyond the CPR emit. Must not call repaint() synchronously —
 * the subscribeImmediate channel fires inside the 'resize' event; a repaint()
 * here would race the debounced subscriber and double-paint.
 */
export function handleResizeImmediate(self: LifecycleHost): void {
  resetArchivedReveal(self);
  const newRows = self.stdout.rows ?? 24;
  if (self.lastKnownRows > 0 && newRows > self.lastKnownRows) {
    // EXPAND: snapshot the old footprint for ghost-row erase.
    const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
    const frameTop = self.logUpdate?.topRow ?? 0;
    const bandTop = self.committedBand.length > 0 ? self.committedBandTopRow : 0;
    const tops = [frameTop, bandTop].filter((r) => r > 0);
    const top = tops.length > 0 ? Math.min(...tops) : 0;
    const bottom = Math.max(1, self.lastKnownRows - 1 - extraRows);
    if (top > 0 && top <= bottom) {
      self.pendingResizeErase = { top, bottom };
    }

    // CPR-based delta correction: after each frame render, CupFrameRenderer
    // parks the cursor at the LAST content row — `targetBottomRow` = frame
    // bottom = `lastMeasuredFrameBottom`. tmux shifts the cursor downward by
    // the number of history lines it pulls back onto screen (delta). The CPR
    // reply reports the REAL cursor row after the shift; delta = reported −
    // originalExpectedRow (from the first CPR of the burst). We use frameBottom
    // as expectedRow; skip when no frame has been rendered yet (frameBottom===0).
    //
    // requestCprOrMarkDirty implements "measure until quiescent": if a CPR is
    // already in-flight, it marks the burst dirty and accumulates grow/shrink
    // totals rather than emitting a second CPR. When the in-flight CPR resolves
    // and dirty is set, a fresh CPR is emitted (up to CPR_MAX_REQUERY times)
    // until the terminal is quiescent, then the cumulative delta is applied once.
    const frameBottom = self.lastMeasuredFrameBottom;
    if (frameBottom > 0 && self.stdin.isTTY) {
      requestCprOrMarkDirty(self, frameBottom, newRows, /* rowDelta= */ newRows - self.lastKnownRows);
    }
  } else if (newRows < self.lastKnownRows) {
    // SHRINK: emit a CPR request to measure how many rows tmux pushed into
    // scrollback history.  When the pane shrinks, tmux first trims blank rows
    // below the cursor, then pushes top rows into history — shifting the cursor
    // UP by delta rows (0 ≤ |delta| ≤ shrink amount).  The CPR reply reports
    // the real cursor row; delta = reported − originalExpectedRow (negative on
    // a push).  We apply applyScrollDelta with the negative delta so tracked
    // rows shift UP with the content, preventing the stale high-row frame ghost
    // below the live frame after a shrink.  Bursts handled by
    // requestCprOrMarkDirty (same as EXPAND).
    //
    // Snapshot rule (burst safety, #3283): a WIDTH-ONLY event that precedes
    // this SHRINK in the same burst has already set pendingResizeErase AND
    // started a CPR.  Unconditionally nulling the snapshot here would discard
    // the erase footprint before the in-flight CPR calls repaint() — the ghost
    // spinner row that #3205/#3228 fixed would survive.
    //
    // Distinction:
    //   • CPR started by a WIDTH-ONLY (growTotal===0, shrinkTotal===0): the
    //     snapshot records ghost rows from a soft-wrap reflow; preserve it.
    //   • CPR started by an EXPAND (growTotal > 0): the snapshot records the
    //     pre-expand footprint; a following SHRINK makes those rows stale —
    //     drop the snapshot (existing contract, prevents erasing reflowed rows).
    //   • No CPR in-flight: drop any stale snapshot (existing contract).
    const burstFromWidthOnly =
      self.cprPending &&
      self.cprBurst !== null &&
      self.cprBurst.growTotal === 0 &&
      self.cprBurst.shrinkTotal === 0;
    if (!burstFromWidthOnly) {
      // Drop stale snapshot: no CPR in-flight, or CPR was started by an EXPAND.
      self.pendingResizeErase = null;
    }
    // burstFromWidthOnly === true: preserve the snapshot so the pending
    // CPR repaint can erase the ghost spinner row left by the soft-wrap reflow.
    const frameBottom = self.lastMeasuredFrameBottom;
    if (frameBottom > 0 && self.stdin.isTTY) {
      requestCprOrMarkDirty(self, frameBottom, newRows, /* rowDelta= */ newRows - self.lastKnownRows);
    }
  } else {
    // Net-zero (same row count) — width-only SIGWINCH (e.g. tmux side-by-side
    // split). A width-only change can reflow tmux's soft-wrapped lines, pushing
    // content into scrollback and leaving a ghost copy of the spinner row at the
    // old position. Two steps fix this:
    //
    //   1. Snapshot the pre-resize footprint for erase (same shape as EXPAND),
    //      so the ghost rows are cleared on the next repaint().
    //
    //   2. Issue a CPR request — even though rowDelta=0 (no row change), the CPR
    //      fires a repaint() once the reply arrives (or the timeout elapses),
    //      which is the only repaint path that runs while cprPending suppresses
    //      the debounced SIGWINCH repaint. Without the CPR, the debounced repaint
    //      fires immediately (no suppression) but BEFORE the erase snapshot is
    //      consumed, so the ghost can survive.  The plausibility range is [0, 0];
    //      a non-zero measured delta is discarded and the repaint still proceeds,
    //      which is safe: the worst case is a frame that did not shift at all.
    const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
    const frameTop = self.logUpdate?.topRow ?? 0;
    const bandTop = self.committedBand.length > 0 ? self.committedBandTopRow : 0;
    const tops = [frameTop, bandTop].filter((r) => r > 0);
    const top = tops.length > 0 ? Math.min(...tops) : 0;
    const bottom = Math.max(1, self.lastKnownRows - 1 - extraRows);
    if (top > 0 && top <= bottom) {
      self.pendingResizeErase = { top, bottom };
    }

    const frameBottom = self.lastMeasuredFrameBottom;
    if (frameBottom > 0 && self.stdin.isTTY) {
      requestCprOrMarkDirty(self, frameBottom, newRows, /* rowDelta= */ 0);
    }
  }
  self.logUpdate?.resetGeometry?.();
  self.bandGeometryStale = true;
}

/**
 * Detect and handle a SIGWINCH that arrived while the compositor was disarmed
 * (between turns). Called once at the start of `arm()`.
 *
 * Compares the live `stdout.rows` against the snapshot taken at disarm time
 * (`self.disarmRows`). If they differ, resets renderer geometry and — on
 * EXPAND — arms the ghost-erase snapshot so the first repaint clears the
 * frozen pre-resize frame rows.
 *
 * Side-effect-free beyond mutating `self.pendingResizeErase`,
 * `self.bandGeometryStale`, and `self.disarmRows`.
 */
export function handleDisarmWindowResize(self: LifecycleHost): void {
  const liveRows = self.stdout.rows ?? 24;
  if (self.disarmRows <= 0 || liveRows === self.disarmRows) return;

  self.logUpdate?.resetGeometry?.();
  if (liveRows > self.disarmRows) {
    // EXPAND while disarmed: frame top is unknown (logUpdate was cleared at
    // disarm); use row 1 as the conservative top so the erase covers the
    // full old footprint.
    const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
    const bottom = Math.max(1, self.disarmRows - 1 - extraRows);
    const top = 1;
    if (top <= bottom) {
      self.pendingResizeErase = { top, bottom };
    }
  }
  self.bandGeometryStale = true;
  self.disarmRows = 0;
}
