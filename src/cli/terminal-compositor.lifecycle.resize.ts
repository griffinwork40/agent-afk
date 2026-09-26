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

import type { LifecycleHost } from './terminal-compositor.lifecycle.js';

/**
 * Synchronous SIGWINCH handler fired by ResizeBus.subscribeImmediate().
 *
 * Snapshots the pre-resize frame/band footprint into `pendingResizeErase` on
 * EXPAND (so the next repaint() can physically erase orphaned ghost rows), and
 * resets logUpdate geometry so the renderer skips its stale erase pass and
 * paints fresh at the new geometry. On SHRINK, drops any stale EXPAND snapshot
 * that accumulated in the same pre-repaint window to prevent clamped
 * ghost-erase from wiping reflowed or status-line rows.
 *
 * Contract: no I/O, no rendering. Must not call repaint() — the subscribeImmediate
 * channel fires synchronously inside the 'resize' event; a repaint() here would
 * race the debounced subscriber and double-paint.
 */
export function handleResizeImmediate(self: LifecycleHost): void {
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
  } else {
    // SHRINK or net-zero: drop any stale EXPAND snapshot so a clamped flush
    // cannot wipe post-shrink reflowed/status rows.
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
