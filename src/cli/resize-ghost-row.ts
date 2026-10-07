/**
 * Pre-resize ghost-row tracker for single-row footer bars.
 *
 * ## Problem
 *
 * When the terminal grows (SIGWINCH), a reserved footer row moves DOWN to the
 * new bottom. Without this helper the old copy remains on-screen as a "ghost"
 * above the new position — the next repaint writes to the new row but nothing
 * clears the old one.
 *
 * ## Pattern
 *
 * Four footer components (StatusLine, LoopStageBar, HealthRail, and the
 * single-row variant in future bars) share the same three-step fix:
 *
 *   1. **Subscribe** — on `start()`, register an immediate-channel handler
 *      (`ResizeBus.subscribeImmediate`) that snapshots `lastPaintedRow` into
 *      `preResizePaintedRow` synchronously at SIGWINCH time, before any
 *      debounced repaint mutates `lastPaintedRow`.
 *   2. **Consume** — at the TOP of the next `repaint()`, call
 *      `consumeGhostRow()`. It reads the snapshot, clears the pointer, and
 *      returns the old row number (or `null` when no resize was pending). The
 *      caller then decides whether to emit `CUP + EL` for that row.
 *   3. **Unsubscribe** — on `stop()`, call `unsubscribe()` to remove the
 *      immediate handler and null the snapshot.
 *
 * ## BackgroundStatusBar
 *
 * The bg-bar tracks a *span* of rows (`preResizeStartRow + preResizeRowCount`)
 * rather than a single row, and it has dedicated `clearPreResizeRows()` logic
 * that handles viewport-boundary clamping for multi-row erases. Forcing that
 * into this single-row helper would muddy the contract; the bg-bar is left
 * unmodified.
 *
 * @module cli/resize-ghost-row
 */

import { ResizeBus } from './terminal-size.js';

/**
 * Tracks the pre-SIGWINCH painted row for a single-row footer bar.
 *
 * Typical usage:
 *
 * ```ts
 * class MyBar {
 *   private lastPaintedRow: number | null = null;
 *   private readonly ghostRow = new ResizeGhostRow(() => this.lastPaintedRow);
 *
 *   start(): void {
 *     this.ghostRow.subscribe();
 *   }
 *
 *   stop(): void {
 *     this.ghostRow.unsubscribe();
 *     // clear your row...
 *   }
 *
 *   private repaint(): void {
 *     const paintRow = computePaintRow();
 *     const totalRows = stream.rows ?? 24;
 *     this.stream.write('\x1b[s');
 *     const old = this.ghostRow.consumeGhostRow();
 *     if (old !== null && old !== paintRow && old >= 1 && old <= totalRows) {
 *       this.stream.write(`\x1b[${old};1H`);
 *       this.stream.write('\x1b[2K');
 *     }
 *     // ... paint at paintRow ...
 *     this.lastPaintedRow = paintRow;
 *   }
 * }
 * ```
 */
export class ResizeGhostRow {
  /**
   * Returns the caller's current `lastPaintedRow` so the immediate-channel
   * handler can snapshot it at SIGWINCH time without needing a direct reference
   * to the caller's private field.
   */
  private readonly getLastPaintedRow: () => number | null;
  /**
   * Snapshot of the caller's `lastPaintedRow` captured synchronously by the
   * `ResizeBus.subscribeImmediate` handler — the only moment the true
   * pre-SIGWINCH address is still recoverable.
   */
  private preResizePaintedRow: number | null = null;
  private unsub: (() => void) | null = null;

  constructor(getLastPaintedRow: () => number | null) {
    this.getLastPaintedRow = getLastPaintedRow;
  }

  /**
   * Register the immediate-channel handler with `ResizeBus`. Call from the
   * owning bar's `start()` method. Idempotent — safe to call when already
   * subscribed.
   *
   * @param afterSnapshot Optional owner hook run in the SAME immediate handler,
   *   strictly after the snapshot is taken. Use it for work that must observe
   *   the snapshot ordering (e.g. StatusLine nulls `lastPaintedRow` here), so
   *   correctness never depends on the registration order of two separate
   *   ResizeBus subscribers.
   * @returns Unsubscribe function (also stored internally for `unsubscribe()`).
   */
  subscribe(afterSnapshot?: () => void): () => void {
    if (this.unsub !== null) return this.unsub;
    this.unsub = ResizeBus.subscribeImmediate(() => {
      this.preResizePaintedRow = this.getLastPaintedRow();
      afterSnapshot?.();
    });
    return this.unsub;
  }

  /**
   * Unregister the immediate-channel handler and clear any pending snapshot.
   * Call from the owning bar's `stop()` method.
   */
  unsubscribe(): void {
    if (this.unsub !== null) {
      this.unsub();
      this.unsub = null;
    }
    this.preResizePaintedRow = null;
  }

  /**
   * Return the pending ghost-row address and clear the snapshot. Call at the
   * TOP of `repaint()`, before writing the new row. The caller should emit
   * `CUP + EL` for the returned row when it is non-null, differs from the new
   * paint row, and falls within `[1, totalRows]`.
   *
   * Returns `null` when no resize snapshot is pending (non-resize repaint).
   */
  consumeGhostRow(): number | null {
    const row = this.preResizePaintedRow;
    this.preResizePaintedRow = null;
    return row;
  }
}
