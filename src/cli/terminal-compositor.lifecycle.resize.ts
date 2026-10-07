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
import { requestCprAndApplyDelta } from './terminal-compositor.lifecycle.cpr.js';

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
 * On SHRINK: drops any stale EXPAND snapshot.
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
    // reply reports the REAL cursor row after the shift; delta = reported -
    // lastMeasuredFrameBottom. We use frameBottom as expectedRow; skip when no
    // frame has been rendered yet (frameBottom===0) — nothing to correct.
    const frameBottom = self.lastMeasuredFrameBottom;
    if (frameBottom > 0 && self.stdin.isTTY) {
      requestCprAndApplyDelta(self, frameBottom, newRows);
    }
  } else if (newRows < self.lastKnownRows) {
    // SHRINK: drop any stale EXPAND snapshot (existing contract), then emit a
    // CPR request to measure how many rows tmux pushed into scrollback history.
    // When the pane shrinks, tmux first trims blank rows below the cursor, then
    // pushes top rows into history — shifting the cursor UP by delta rows
    // (0 ≤ |delta| ≤ shrink amount). The CPR reply reports the real cursor row;
    // delta = reported - lastMeasuredFrameBottom (negative on a push). We apply
    // applyScrollDelta with the negative delta so tracked rows shift UP with the
    // content, preventing the stale high-row frame ghost that appears below the
    // live frame after a shrink. The CPR suppress guard (cprPending) is the same
    // as on EXPAND so no stale-row repaint races the correction.
    self.pendingResizeErase = null;
    const frameBottom = self.lastMeasuredFrameBottom;
    if (frameBottom > 0 && self.stdin.isTTY) {
      requestCprAndApplyDelta(self, frameBottom, newRows);
    }
  } else {
    // Net-zero (same row count): drop any stale EXPAND snapshot.
    self.pendingResizeErase = null;
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
