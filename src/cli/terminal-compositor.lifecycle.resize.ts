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
import { noteResizeForReflow } from './terminal-compositor.reflow-shift.js';

/**
 * Compute the inflated physical-row count of the pre-resize painted footprint
 * after a NARROWING resize (EXPAND or WIDTH-ONLY). SHRINK never calls this.
 *
 * With AFK_CENTER_CONTENT the compositor paints each row as `margin + content`,
 * where `margin` = `floor((oldCols - measure) / 2)` spaces. The painted width
 * of each row is therefore up to `oldCols` columns (margin always fills to the
 * content boundary). When the terminal narrows to `newCols < oldCols`, DECAWM
 * autowrap reflows each old row that exceeds `newCols` into
 * `ceil(paintedWidth / newCols)` physical rows — expanding the on-screen
 * footprint above the `pendingResizeErase.top` anchor.
 *
 * Without this inflation the ghost-erase range only covers the LOGICAL row
 * count ([top, lastKnownRows-1]), leaving the extra physical rows above `top`
 * as duplicates of the oldest visible rows.
 *
 * When centering is OFF (default) or when the terminal WIDENS, each row is at
 * most `oldCols` wide and already fits in `newCols` ≥ `oldCols`, so the factor
 * is 1 and this is a no-op.
 *
 * @param logicalRows  Number of logical (model) rows in the footprint.
 * @param oldCols      Terminal width as of the last repaint (`lastKnownCols`).
 * @param newCols      New terminal width (post-SIGWINCH `stdout.columns`).
 * @returns            Physical row count, always >= logicalRows.
 */
function reflowedPhysicalRows(logicalRows: number, oldCols: number, newCols: number): number {
  if (newCols <= 0 || oldCols <= newCols) return logicalRows; // widen or no-op
  // The maximum painted width per row: margin + content = oldCols (the
  // compositor wraps content at `band.width = oldCols - marginCols`, so
  // `margin + content` always fits exactly `oldCols` in the worst case).
  // Using `oldCols` here is conservative but correct: it over-estimates at
  // most by `marginCols` columns, which only inflates the erase range
  // harmlessly (erasing blank rows is a no-op on terminal output).
  const paintedWidth = oldCols;
  const rowsPerOldRow = Math.ceil(paintedWidth / newCols);
  return logicalRows * rowsPerOldRow;
}

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
 * On SHRINK: while CPR is in-flight, keep a WIDTH-ONLY snapshot so the
 * pending repaint can erase the ghost rows. Snapshot provenance is independent
 * of burst origin: an intervening EXPAND replaces it with a stale footprint
 * that SHRINK must drop. With no pending CPR, drop any stale snapshot.
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
    const logicalBottom = Math.max(1, self.lastKnownRows - 1 - extraRows);
    // With AFK_CENTER_CONTENT the compositor paints `margin + content` per row,
    // where the painted width equals `lastKnownCols` in the worst case.
    // On an EXPAND that also narrows (e.g. tmux adding rows while reducing cols),
    // DECAWM autowrap reflows each old row wider than the new terminal width into
    // ceil(oldCols / newCols) physical rows — the same ghost-row erase undercount
    // that WIDTH-ONLY fixed for issue #3763. Without inflation the erase range
    // covers only logical rows, leaving extra physical rows as duplicates.
    const newCols = self.stdout.columns ?? 80;
    const logicalRows = Math.max(0, logicalBottom - top + 1);
    const physicalRows = reflowedPhysicalRows(logicalRows, self.lastKnownCols, newCols);
    // bottom may exceed newRows after inflation; flushResizeGhostErase clamps it.
    // Symmetric with the WIDTH-ONLY branch: no top===0 fallback needed because
    // the if-guard below already blocks the top===0 case.
    const bottom = top + physicalRows - 1;
    if (top > 0 && top <= bottom) {
      self.pendingResizeErase = { top, bottom, origin: 'expand' };
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
      noteResizeForReflow(self, newCols, !self.cprPending);
      requestCprOrMarkDirty(self, frameBottom, newRows, /* rowDelta= */ newRows - self.lastKnownRows);
    }
  } else if (newRows < self.lastKnownRows) {
    // Invariant: SHRINK must not erase an EXPAND footprint after reflow.
    // Emit a CPR request to measure how many rows tmux pushed into
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
    //   • Latest snapshot from WIDTH-ONLY: preserve soft-wrap ghost rows
    //     regardless of how many SHRINKs accumulate in the burst (#3283).
    //   • Latest snapshot from EXPAND: drop the pre-expand footprint because
    //     SHRINK makes its rows stale, even in a WIDTH-ONLY-originated burst.
    //   • No CPR in-flight: drop any stale snapshot (existing contract).
    const preserveWidthSnapshot =
      self.cprPending && self.pendingResizeErase?.origin === 'width-only';
    if (!preserveWidthSnapshot) {
      // Drop stale snapshot: no CPR in-flight, or not a WIDTH-ONLY footprint.
      self.pendingResizeErase = null;
    }
    // preserveWidthSnapshot === true: preserve the snapshot so the pending
    // CPR repaint can erase the ghost spinner row left by the soft-wrap reflow.
    const frameBottom = self.lastMeasuredFrameBottom;
    if (frameBottom > 0 && self.stdin.isTTY) {
      noteResizeForReflow(self, self.stdout.columns ?? 80, !self.cprPending, /* rowShrink= */ true);
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
    //      consumed, so the ghost can survive.  The plausibility range is [0, N]
    //      where N is the predicted tmux reflow (0 outside tmux); an implausible
    //      delta is discarded and the repaint still proceeds.
    const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
    const frameTop = self.logUpdate?.topRow ?? 0;
    const bandTop = self.committedBand.length > 0 ? self.committedBandTopRow : 0;
    const tops = [frameTop, bandTop].filter((r) => r > 0);
    const top = tops.length > 0 ? Math.min(...tops) : 0;
    const logicalBottom = Math.max(1, self.lastKnownRows - 1 - extraRows);
    // With AFK_CENTER_CONTENT the compositor paints `margin + content` per row,
    // where the painted width equals `lastKnownCols` in the worst case.
    // On a WIDTH-ONLY narrowing resize (e.g. 200→120 cols) DECAWM autowrap
    // reflows each old row that is wider than the new terminal width into
    // ceil(oldCols / newCols) physical rows, expanding the on-screen footprint
    // above the logical `top` anchor. Without this inflation the ghost-erase
    // range covers only logical rows, leaving the extra physical rows as
    // duplicate copies of the oldest visible rows (issue #3763).
    const newCols = self.stdout.columns ?? 80;
    const logicalRows = Math.max(0, logicalBottom - top + 1);
    const physicalRows = reflowedPhysicalRows(logicalRows, self.lastKnownCols, newCols);
    // bottom may exceed newRows after inflation; flushResizeGhostErase clamps it.
    // Note: the `top > 0` guard on the if-branch below already blocks the
    // top===0 case, so `logicalBottom` as a fallback here is unreachable.
    const bottom = top + physicalRows - 1;
    if (top > 0 && top <= bottom) {
      self.pendingResizeErase = { top, bottom, origin: 'width-only' };
    }

    const frameBottom = self.lastMeasuredFrameBottom;
    if (frameBottom > 0 && self.stdin.isTTY) {
      // Predict tmux's cursor-pinned reflow shift (terminal-compositor.reflow-shift.ts).
      noteResizeForReflow(self, newCols, !self.cprPending);
      requestCprOrMarkDirty(self, frameBottom, newRows, /* rowDelta= */ 0);
    }
  }
  self.logUpdate?.resetGeometry?.();
  self.bandGeometryStale = true;
  // Resize-specific staleness flag: set ONLY here (and in handleDisarmWindowResize)
  // so frame-preserve's legacy deficit eviction can distinguish mid-burst
  // stale geometry from the suspend/resume path (which also sets bandGeometryStale).
  self.resizeGeometryStale = true;
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
 * `self.bandGeometryStale`, `self.resizeGeometryStale`, and `self.disarmRows`.
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
    const logicalBottom = Math.max(1, self.disarmRows - 1 - extraRows);
    const top = 1;
    const logicalRows = Math.max(0, logicalBottom - top + 1);
    // Apply the same reflowedPhysicalRows inflation as the armed EXPAND path:
    // if the EXPAND also narrowed columns (e.g. tmux adding rows while reducing
    // cols), DECAWM autowrap reflows old rows wider than newCols into
    // ceil(oldCols / newCols) physical rows — under-erasing ghost rows without
    // this inflation. `disarmCols` is the column count snapshotted at disarm
    // (parallel to disarmRows); `lastKnownCols` is zeroed by resetState() and
    // cannot be used here.
    const newCols = self.stdout.columns ?? 80;
    const physicalRows = reflowedPhysicalRows(logicalRows, self.disarmCols, newCols);
    // bottom may exceed liveRows after inflation; flushResizeGhostErase clamps.
    const bottom = top + physicalRows - 1;
    if (top <= bottom) {
      self.pendingResizeErase = { top, bottom, origin: 'expand' };
    }
  }
  self.bandGeometryStale = true;
  self.resizeGeometryStale = true; // mirrors handleResizeImmediate — SIGWINCH-only flag (#3212)
  self.disarmRows = 0;
}
