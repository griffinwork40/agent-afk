/**
 * MascotBand — the reacting goblin's reserved footer band: three rows, always
 * on, right-aligned.
 *
 * Issue #336, third shape. The first band reserved rows when a tool started and
 * released them at idle; that made the transcript jump twice per tool call, and
 * it painted the sprite into the left gutter, directly in the reading path. The
 * second shape fixed both by giving up the rows — but two pixel rows cannot
 * carry a cap, a hatband and a face, so the goblin stopped being a goblin.
 *
 * This shape keeps the 13×3 sprite and pays for its rows differently:
 *
 *   - **Constant, not transient.** The reservation is established once in
 *     `start()` and released once in `stop()`. Between them the row count
 *     changes only when `visibleRows()` crosses its headroom floor, which takes
 *     a geometry change: a resize, or a co-tenant below us (bg bar / verdict
 *     rail) growing enough to squeeze the floor. Sprite CONTENT can never move
 *     it — `visibleRows()` reads only `stream.rows`, `stream.columns` and
 *     `getAdjacentRows()`, never `getLines()` — so an enabled mascot shifts the
 *     transcript exactly as often as the loop-stage rail does, which is never.
 *   - **Right-aligned, not left.** The sprite sits at the row's right edge, out
 *     of the reading path where the eye is not tracking prose.
 *   - **Content is somebody else's job.** `LiveMascot` (mascot-live.ts) owns the
 *     state machine, the alert dwell, and the frame clock; this class asks it
 *     for the current frame and never asks whether the mascot should exist.
 *
 * Band stacking, bottom → top (N = totalRows), with this band a tenant:
 *   row N                    StatusLine
 *   row N-1                  verdict ledger rail (0 or 1)
 *   rows above that          BackgroundStatusBar (0+)
 *   rows above that          MascotBand           (0 or MASCOT_BAND_ROWS)  ← here
 *   row N - extraRows        LoopStageBar (always 1, always topmost)
 *
 * Lifecycle: construct → `start()` → (`redraw()` per frame/stage change, driven
 * by LiveMascot's ticker) → `stop()` before exit.
 */

import { ResizeBus } from '../../terminal-size.js';
import { isPlainOutputRequested } from '../../../config/env.js';
import { mascotSuppressed } from '../../mascot.js';
import { MINI_MASCOT_HEIGHT, MINI_MASCOT_WIDTH } from '../../mascot-mini.js';
import { detectGoblinMascot } from '../../_lib/capture-mode.js';

/** Rows the band occupies whenever it is armed and the terminal has room. */
export const MASCOT_BAND_ROWS = MINI_MASCOT_HEIGHT;

/**
 * Transcript rows that must survive below the reserved band before the mascot
 * is allowed to claim any. A 3-row sprite on a 12-row terminal would eat the
 * conversation; on anything roomy it is free.
 */
export const MASCOT_BAND_MIN_CONTENT_ROWS = 8;

/**
 * Columns left blank to the right of the sprite.
 *
 * Invariant (DECAWM): never write the terminal's final column. Writing the last
 * cell of a row arms the pending-wrap flag, and the next write — the status
 * line's, one row below — then emits its first character on a *new* line, which
 * scrolls the reserved band. One spare column costs nothing and makes the class
 * of bug impossible.
 */
const RIGHT_MARGIN = 1;

export class MascotBand {
  private readonly stream: NodeJS.WriteStream;
  private readonly getLines: () => readonly string[];
  private readonly getAdjacentRows: () => number;
  private started = false;
  private rowCount = 0;
  /** Geometry of the last paint, so a moved band can erase its old rows. */
  private lastStartRow = 0;
  private lastRowCount = 0;
  private resizeUnsub: (() => void) | null = null;
  private onRowCountChange?: (rows: number) => void;

  /**
   * @param opts.getLines - The frame to paint: one ANSI-styled string per
   *   character row, each MINI_MASCOT_WIDTH display columns wide. `[]` (an inert
   *   mascot) paints blank rows without releasing the reservation — releasing is
   *   `stop()`'s job alone, which is what keeps the band constant.
   * @param opts.getAdjacentRows - Rows owned by painters BETWEEN this band and
   *   the status line (background-task bar + verdict rail). Used to compute the
   *   absolute paint row, exactly as `BackgroundStatusBar` does.
   * @param opts.stream - Write stream (defaults to `process.stdout`).
   */
  constructor(opts: {
    getLines: () => readonly string[];
    getAdjacentRows: () => number;
    stream?: NodeJS.WriteStream;
  }) {
    this.stream = opts.stream ?? process.stdout;
    this.getLines = opts.getLines;
    this.getAdjacentRows = opts.getAdjacentRows;
  }

  setRowCountChangeHandler(handler: (rows: number) => void): void {
    this.onRowCountChange = handler;
  }

  /**
   * Release the band and go inert. Idempotent.
   *
   * External constraint (DECSTBM): the painted rows must be erased BEFORE the
   * reservation shrinks. `clearBand` derives its target rows from the geometry
   * it last painted at, and the rows below it move the instant the reservation
   * drops — so releasing first would leave the sprite orphaned above the status
   * line. Teardown is written above `start()` here so the inverse of every setup
   * step stays visible next to it.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    this.clearBand();
    this.rowCount = 0;
    this.onRowCountChange?.(0);
  }

  /**
   * Arm the painter and claim the band.
   *
   * Invariant (DECSTBM): the reservation is published BEFORE the first paint —
   * the rows must already be outside the scroll region, or the next line of
   * transcript scrolls the sprite away. This is the only growth event in the
   * band's life; every later repaint finds the count unchanged.
   *
   * Opt-in: `AFK_GOBLIN_MASCOT=1`. Four independent inert gates —
   * `AFK_PLAIN_OUTPUT`/`--plain` (full render opt-out, mirroring the
   * status-line/compositor/loop-stage gates), `AFK_BANNER_PLAIN=1` (pixel art
   * suppressed everywhere), non-TTY (nothing to position against), and the flag
   * itself — because a band tenant that starts must also be able to reserve
   * rows, and a phantom reservation on a dumb pipe would shrink the scroll
   * region for output nobody can see.
   */
  start(): void {
    if (this.started) return;
    if (!detectGoblinMascot()) return;
    if (isPlainOutputRequested()) return;
    if (mascotSuppressed()) return;
    if (!this.stream.isTTY) return;
    this.started = true;
    this.resizeUnsub = ResizeBus.subscribe(() => this.repaint());
    this.repaint();
  }

  /**
   * Re-assert the band at the mascot's current frame. Idempotent. Called by
   * LiveMascot on every animation tick and state change, and after anything that
   * scrolls the reserved rows off their home without a ResizeBus tick — chiefly
   * a full-screen scroll inside commitAbove / evictRowsToScrollback, wired via
   * `StatusLine.setAfterScrollRestore`.
   */
  redraw(): void {
    this.repaint();
  }

  /** Rows the band currently occupies (0 when inert or too cramped). */
  getRowCount(): number {
    return this.rowCount;
  }

  // ---- painting -----------------------------------------------------------

  /**
   * Erase the rows this band last painted, using the geometry it painted them
   * at (NOT freshly-computed geometry — after a resize those differ, and the
   * stale rows are the ones that need erasing).
   */
  private clearBand(): void {
    if (!this.stream.isTTY || this.lastRowCount <= 0) return;
    const totalRows = this.stream.rows ?? 24;
    this.stream.write('\x1b[s');
    for (let i = 0; i < this.lastRowCount; i++) {
      const row = this.lastStartRow + i;
      if (row < 1 || row > totalRows) continue;
      this.stream.write(`\x1b[${row};1H`);
      this.stream.write('\x1b[2K');
    }
    this.stream.write('\x1b[u');
    this.lastRowCount = 0;
    this.lastStartRow = 0;
  }

  /**
   * Recompute geometry, reconcile the reservation, and paint.
   *
   * Invariant (DECSTBM ordering): a GROWING reservation must be published before
   * the paint (the rows must already be outside the scroll region), and a
   * SHRINKING one must be published after the old rows are erased (the erase
   * targets rows described by the outgoing reservation). Both directions
   * therefore route through `clearBand()` → `onRowCountChange` → write, in that
   * order, and the reservation is pushed only when the count actually changes so
   * a per-frame repaint does not thrash `setExtraRows`/DECSTBM. Unlike the
   * band's transient ancestor, the only count changes here are start, stop, and
   * a resize crossing the headroom threshold.
   */
  private repaint(): void {
    if (!this.started || !this.stream.isTTY) return;
    const desired = this.visibleRows();
    const totalRows = this.stream.rows ?? 24;
    const columns = this.stream.columns ?? 80;
    const adjacent = this.getAdjacentRows();
    const startRow = Math.max(1, totalRows - desired - adjacent);
    const startCol = Math.max(1, columns - MINI_MASCOT_WIDTH);

    // Erase first whenever the band is shrinking or moving; a same-geometry
    // repaint skips it because every row is overwritten with \x1b[2K below.
    if (this.lastRowCount > 0 && (desired !== this.lastRowCount || startRow !== this.lastStartRow)) {
      this.clearBand();
    }
    if (desired !== this.rowCount) {
      this.rowCount = desired;
      this.onRowCountChange?.(desired);
    }
    if (desired === 0) return;

    const lines = this.getLines();
    this.stream.write('\x1b[s');
    for (let i = 0; i < desired; i++) {
      const row = startRow + i;
      if (row < 1 || row > totalRows) continue;
      this.stream.write(`\x1b[${row};1H`);
      this.stream.write('\x1b[2K');
      const line = lines[i];
      // A blank row is a legitimate frame (inert mascot mid-teardown): keep the
      // reservation, paint nothing into it.
      if (!line) continue;
      this.stream.write(`\x1b[${row};${startCol}H`);
      this.stream.write(line);
    }
    this.stream.write('\x1b[u');
    this.lastStartRow = startRow;
    this.lastRowCount = desired;
  }

  /**
   * Rows the band may claim right now: all of them, or none. Partial sprites are
   * worse than no sprite, so the band collapses entirely — never truncates,
   * never wraps — when the terminal cannot spare MASCOT_BAND_ROWS on top of the
   * status line, the rows below us (bg bar + verdict rail), the loop-stage rail,
   * and a floor of readable transcript, or when the row is too narrow to hold
   * the sprite plus its right-margin guard column.
   */
  private visibleRows(): number {
    const totalRows = this.stream.rows ?? 24;
    const columns = this.stream.columns ?? 80;
    if (columns < MINI_MASCOT_WIDTH + RIGHT_MARGIN) return 0;
    const headroom =
      totalRows - 1 - this.getAdjacentRows() - 1 - MASCOT_BAND_MIN_CONTENT_ROWS;
    return headroom >= MASCOT_BAND_ROWS ? MASCOT_BAND_ROWS : 0;
  }
}
