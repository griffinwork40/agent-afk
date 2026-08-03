/**
 * MascotBar — the reacting goblin mini-sprite as a reserved footer band.
 *
 * Issue #336. The 1-row spinner cannot carry a multi-row sprite (the
 * compositor's `fixedRows` accounting budgets the spinner at exactly one
 * physical row, so a newline in spinner output corrupts the DECSTBM scroll
 * math). So the live mascot gets its own painter in the `extraRows` band,
 * alongside the loop-stage rail, the background-task bar, and the verdict
 * ledger — the same DECSTBM reservation mechanism, the same CUP-inside-
 * save/restore paint technique, the same ResizeBus self-healing.
 *
 * Band stacking, bottom → top (N = totalRows), once this bar is a tenant:
 *   row N                    StatusLine
 *   row N-1                  verdict ledger rail (0 or 1)
 *   rows above that          BackgroundStatusBar (0+)
 *   rows above that          MascotBar            (0 or MASCOT_BAR_ROWS)  ← here
 *   row N - extraRows        LoopStageBar (always 1, always topmost)
 *
 * Unlike the other tenants this one is *transient*: it reserves rows only
 * while the agent is mid-tool (`working`/`alert`) and releases them at `idle`,
 * so a resting REPL pays no rows and no timer ticks.
 *
 * Lifecycle: construct → `start()` → `setState(...)` per loop-stage
 * transition → `stop()` before exit.
 */

import { ResizeBus } from '../../terminal-size.js';
import { isPlainOutputRequested } from '../../../config/env.js';
import { mascotSuppressed, type MascotState } from '../../mascot.js';
import {
  MINI_MASCOT_HEIGHT,
  MINI_MASCOT_WIDTH,
  miniMascotFrameCount,
  renderMiniMascotLines,
} from '../../mascot-mini.js';
import { detectGoblinMascot } from '../../_lib/capture-mode.js';
import type { LoopStage } from './loop-stage.js';

/** Rows the band occupies while the mascot is visible. */
export const MASCOT_BAR_ROWS = MINI_MASCOT_HEIGHT;

/**
 * Transcript rows that must survive below the reserved band before the mascot
 * is allowed to claim any. A 3-row sprite on a 12-row terminal would eat the
 * conversation; on anything roomy it is free.
 */
export const MASCOT_BAR_MIN_CONTENT_ROWS = 8;

/** Left indent, matching the loop-stage rail's two-space gutter. */
const GUTTER = '  ';

/**
 * How long an `alert` holds the band before the mascot returns to whatever the
 * loop stage says. A tool error is an instant, not a state — without a dwell it
 * would be overwritten by the very next stage transition (usually the same
 * event) and never be seen.
 */
const ALERT_DWELL_MS = 1500;

/** Default animation period. Fast enough to read as alive, slow enough to be cheap. */
const DEFAULT_FRAME_MS = 220;

export class MascotBar {
  private readonly stream: NodeJS.WriteStream;
  private readonly getAdjacentRows: () => number;
  private readonly frameMs: number;
  private started = false;
  private state: MascotState = 'idle';
  private frame = 0;
  private rowCount = 0;
  /** Geometry of the last paint, so a moved band can erase its old rows. */
  private lastStartRow = 0;
  private lastRowCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** State implied by the most recent loop stage; the alert dwell falls back to it. */
  private stageState: MascotState = 'idle';
  private alertTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeUnsub: (() => void) | null = null;
  private onRowCountChange?: (rows: number) => void;

  /**
   * @param opts.getAdjacentRows - Rows owned by painters BETWEEN this band and
   *   the status line (background-task bar + verdict rail). Used to compute the
   *   absolute paint row, exactly as `BackgroundStatusBar` does.
   * @param opts.stream - Write stream (defaults to `process.stdout`).
   * @param opts.frameMs - Animation period in ms.
   */
  constructor(opts: {
    getAdjacentRows: () => number;
    stream?: NodeJS.WriteStream;
    frameMs?: number;
  }) {
    this.stream = opts.stream ?? process.stdout;
    this.getAdjacentRows = opts.getAdjacentRows;
    this.frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
  }

  setRowCountChangeHandler(handler: (rows: number) => void): void {
    this.onRowCountChange = handler;
  }

  /**
   * Release the band and go inert. Idempotent.
   *
   * External constraint (DECSTBM): the painted rows must be erased BEFORE the
   * reservation shrinks. `clearBand` derives its target rows from the live
   * reservation, so releasing first would erase the wrong rows and orphan the
   * sprite above the status line. Teardown is written above `start()` here so
   * the inverse of every setup step stays visible next to it.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    this.stopTimer();
    this.clearAlertTimer();
    this.clearBand();
    this.rowCount = 0;
    this.state = 'idle';
    this.stageState = 'idle';
    this.onRowCountChange?.(0);
  }

  /**
   * Arm the painter. Renders nothing until {@link setState} reports work.
   *
   * Opt-in: `AFK_GOBLIN_MASCOT=1`. Four independent inert gates —
   * `AFK_PLAIN_OUTPUT`/`--plain` (full render opt-out, mirroring the
   * status-line/compositor/loop-stage gates), `AFK_BANNER_PLAIN=1` (pixel art
   * suppressed everywhere), non-TTY (nothing to position against), and the
   * flag itself — because a band tenant that starts must also be able to
   * reserve rows, and a phantom reservation on a dumb pipe would shrink the
   * scroll region for output nobody can see.
   */
  start(): void {
    if (this.started) return;
    if (!detectGoblinMascot()) return;
    if (isPlainOutputRequested()) return;
    if (mascotSuppressed()) return;
    if (!this.stream.isTTY) return;
    this.started = true;
    this.resizeUnsub = ResizeBus.subscribe(() => this.repaint());
  }

  /**
   * Point the mascot at the agent's current state. `idle` collapses the band;
   * `working`/`alert` claim it and start the animation. Cheap to call on every
   * loop-stage transition — a no-op when the state has not changed.
   */
  setState(state: MascotState): void {
    if (!this.started || state === this.state) return;
    this.state = state;
    this.frame = 0;
    if (state === 'idle') this.stopTimer();
    else this.startTimer();
    this.repaint();
  }

  /**
   * Map a loop-stage transition onto a mascot state — the REPL's only wiring
   * point. `acting` (a tool is in flight with no result yet) is the working
   * window; every other stage is rest. A `toolErrored` signal flashes `alert`
   * for {@link ALERT_DWELL_MS} and then falls back to the live stage, so the
   * error is visible without freezing the mascot in a scary face.
   *
   * Kept here rather than in the two call sites (the REPL turn loop and the
   * slash-skill surface) so the mapping and the dwell have exactly one home.
   */
  onStage(stage: LoopStage, signals?: { toolErrored?: boolean }): void {
    if (!this.started) return;
    this.stageState = stage === 'acting' ? 'working' : 'idle';
    if (signals?.toolErrored) {
      this.flashAlert();
      return;
    }
    // While an alert is dwelling it owns the band; the stage we just recorded
    // is what the dwell timer will fall back to.
    if (this.alertTimer) return;
    this.setState(this.stageState);
  }

  /**
   * Re-assert the band at its current frame. Idempotent. Called after anything
   * that scrolls the reserved rows off their home without a ResizeBus tick —
   * chiefly a full-screen scroll inside commitAbove / evictRowsToScrollback,
   * wired via `StatusLine.setAfterScrollRestore`.
   */
  redraw(): void {
    this.repaint();
  }

  /** Rows the band currently occupies (0 when idle or too cramped). */
  getRowCount(): number {
    return this.rowCount;
  }

  // ---- painting -----------------------------------------------------------

  /**
   * Erase the rows this bar last painted, using the geometry it painted them
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
   * Invariant (DECSTBM ordering): a GROWING reservation must be published
   * before the paint (the rows must already be outside the scroll region, or
   * the next scroll drags the sprite away), and a SHRINKING one must be
   * published after the old rows are erased (the erase targets rows described
   * by the outgoing reservation). Both directions therefore route through
   * `clearBand()` → `onRowCountChange` → write, in that order, and the
   * reservation is pushed only when the count actually changes so an
   * every-frame repaint does not thrash `setExtraRows`/DECSTBM.
   */
  private repaint(): void {
    if (!this.started || !this.stream.isTTY) return;
    const lines = this.state === 'idle' ? [] : renderMiniMascotLines(this.state, this.frame);
    const desired = lines.length > 0 ? this.visibleRows() : 0;
    const totalRows = this.stream.rows ?? 24;
    const adjacent = this.getAdjacentRows();
    const startRow = Math.max(1, totalRows - desired - adjacent);

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

    this.stream.write('\x1b[s');
    for (let i = 0; i < desired; i++) {
      const row = startRow + i;
      if (row < 1 || row > totalRows) continue;
      this.stream.write(`\x1b[${row};1H`);
      this.stream.write('\x1b[2K');
      this.stream.write(GUTTER + (lines[i] ?? ''));
    }
    this.stream.write('\x1b[u');
    this.lastStartRow = startRow;
    this.lastRowCount = desired;
  }

  /**
   * Rows the band may claim right now: all of them, or none. Partial sprites
   * are worse than no sprite, so the band collapses entirely when the terminal
   * cannot spare MASCOT_BAR_ROWS on top of the status line, the rows below us
   * (bg bar + verdict rail), the loop-stage rail, and a floor of readable
   * transcript.
   */
  private visibleRows(): number {
    const totalRows = this.stream.rows ?? 24;
    const columns = this.stream.columns ?? 80;
    if (columns < MINI_MASCOT_WIDTH + GUTTER.length) return 0;
    const headroom =
      totalRows - 1 - this.getAdjacentRows() - 1 - MASCOT_BAR_MIN_CONTENT_ROWS;
    return headroom >= MASCOT_BAR_ROWS ? MASCOT_BAR_ROWS : 0;
  }

  // ---- animation ----------------------------------------------------------

  private clearAlertTimer(): void {
    if (!this.alertTimer) return;
    clearTimeout(this.alertTimer);
    this.alertTimer = null;
  }

  /** Show `alert`, then fall back to the live stage after the dwell. */
  private flashAlert(): void {
    this.clearAlertTimer();
    this.setState('alert');
    this.alertTimer = setTimeout(() => {
      this.alertTimer = null;
      this.setState(this.stageState);
    }, ALERT_DWELL_MS);
    this.alertTimer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private startTimer(): void {
    if (this.timer) return;
    // Single-frame states need no ticker (idle is one frame by construction).
    if (miniMascotFrameCount(this.state) <= 1) return;
    this.timer = setInterval(() => {
      this.frame += 1;
      this.repaint();
    }, this.frameMs);
    // Never hold the event loop open: a live mascot must not delay process exit.
    this.timer.unref?.();
  }
}
