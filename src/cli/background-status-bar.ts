/**
 * Persistent background-task bar rendered above the existing status line.
 *
 * Uses DECSTBM scroll-region reservation (same technique as {@link StatusLine})
 * to pin one or more task-progress rows above the bottom status row. Repaints
 * on BackgroundAgentRegistry 'started' / 'settled' events, throttled to avoid
 * flicker.
 *
 * Lifecycle: construct → start() → repaint via registry events → stop() before exit.
 *
 * @module cli/background-status-bar
 */

import type { BackgroundAgentRegistry, BackgroundJob } from '../agent/background-registry.js';
import type { BackgroundItem } from './background/types.js';
import { truncateDisplayWidth } from './display.js';
import { palette } from './palette.js';
import { formatDuration } from './format-utils.js';
import { ResizeBus } from './terminal-size.js';
import { isPlainOutputRequested } from '../config/env.js';

const SPINNER_FRAMES = ['◐', '◑', '◒', '◓'] as const;

export interface BackgroundStatusBarOptions {
  stream?: NodeJS.WriteStream;
  throttleMs?: number;
  /**
   * Returns the number of rows owned by painters that sit *below* this bar
   * (between the bg bar and the status line). Typically this is the verdict
   * ledger rail (0 or 1 row). Used to keep bg-bar rows from overwriting the
   * verdict rail row. Default: `() => 0`.
   */
  getAdjacentRows?: () => number;
}

export class BackgroundStatusBar {
  private readonly stream: NodeJS.WriteStream;
  private readonly registry: BackgroundAgentRegistry | undefined;
  private readonly throttleMs: number;

  private started = false;
  private lastRepaint = 0;
  private spinnerIndex = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private resizeUnsub: (() => void) | null = null;
  private resizeImmediateUnsub: (() => void) | null = null;
  private registryStartedHandler: ((job: BackgroundJob) => void) | null = null;
  private registrySettledHandler: ((job: BackgroundJob) => void) | null = null;
  private rowCount = 0;
  // The start-row address used by the most recent paint. Stored at paint time so
  // resetGeometry() can snapshot the TRUE pre-SIGWINCH address: clearRows()
  // recomputes startRow from the live stream.rows, but by the time a resize
  // handler runs stream.rows is already the NEW height, so only a stored address
  // can still point at the old rows. Mirrors StatusLine.lastPaintedRow.
  private lastPaintStartRow = 0;
  // Pre-resize snapshot captured by resetGeometry() on the immediate channel and
  // consumed by the next repaint() (via clearPreResizeRows()) to erase rows
  // stranded at the old address. null = no resize-erase pending. Mirrors
  // StatusLine.preResizePaintedRow.
  private preResizeStartRow: number | null = null;
  private preResizeRowCount: number | null = null;
  private onRowCountChange?: (rows: number) => void;
  private readonly getAdjacentRows: () => number;

  constructor(
    registry?: BackgroundAgentRegistry,
    opts: BackgroundStatusBarOptions = {},
  ) {
    this.registry = registry;
    this.stream = opts.stream ?? process.stdout;
    this.throttleMs = opts.throttleMs ?? 200;
    this.getAdjacentRows = opts.getAdjacentRows ?? (() => 0);
  }

  setRowCountChangeHandler(handler: (rows: number) => void): void {
    this.onRowCountChange = handler;
  }

  start(): void {
    if (this.started) return;
    // AFK_PLAIN_OUTPUT / --plain is a full render opt-out: stay inert so a
    // --plain TTY behaves like a non-TTY surface. Never arm the ResizeBus
    // subscription, the spinner interval, or the reserved-row painter (every
    // paint path is gated on `started`). Mirrors the status-line/compositor/
    // renderer/input gates on `isPlainOutputRequested` (config/env.ts).
    if (isPlainOutputRequested()) return;
    this.started = true;

    if (this.registry) {
      this.registryStartedHandler = (_job: BackgroundJob) => {
        this.scheduleRepaint();
      };
      this.registrySettledHandler = (_job: BackgroundJob) => {
        this.scheduleRepaint();
      };
      this.registry.on('started', this.registryStartedHandler);
      this.registry.on('settled', this.registrySettledHandler);
    }

    this.resizeUnsub = ResizeBus.subscribe(() => this.repaint());
    this.resizeImmediateUnsub = ResizeBus.subscribeImmediate(() => this.resetGeometry());

    this.spinnerInterval = setInterval(() => {
      // Invariant: resetGeometry() zeroes this.rowCount synchronously inside
      // the 'resize' event (via ResizeBus.subscribeImmediate), which fires
      // BEFORE any macrotask (including this setInterval callback) can execute.
      // Therefore, if a SIGWINCH fires between two spinner ticks, this.rowCount
      // is guaranteed to be 0 by the time this callback runs — the `> 0` guard
      // correctly suppresses the repaint until the debounced ResizeBus.subscribe
      // channel fires repaint() and re-seizes the correct row count and
      // start-row address against the new terminal geometry.
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
      if (this.rowCount > 0) this.repaint();
    }, Math.max(this.throttleMs, 50));
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.registry) {
      if (this.registryStartedHandler) {
        this.registry.off('started', this.registryStartedHandler);
        this.registryStartedHandler = null;
      }
      if (this.registrySettledHandler) {
        this.registry.off('settled', this.registrySettledHandler);
        this.registrySettledHandler = null;
      }
    }
    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    if (this.resizeImmediateUnsub) {
      this.resizeImmediateUnsub();
      this.resizeImmediateUnsub = null;
    }
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }

    if (this.rowCount > 0) {
      this.clearRows();
      this.rowCount = 0;
      this.onRowCountChange?.(0);
    }
  }

  private resetGeometry(): void {
    // Invariant: 'stale' means `this.rowCount` was computed against the
    // pre-SIGWINCH terminal height and therefore encodes both (a) how many rows
    // were physically written at the OLD start-row address and (b) the old
    // equality baseline used by the `newRowCount !== this.rowCount` guard in
    // repaint().  After SIGWINCH, `stream.rows` has already changed, but the
    // 150ms-debounced ResizeBus.subscribe channel has NOT yet fired, so any
    // repaint() call in that window (typically from the spinner at ≤150ms
    // interval) evaluates newRowCount against the NEW terminal height and
    // compares it with the OLD this.rowCount.  Two failure modes follow:
    //   1. SHRINK: the equality guard may not trip, leaving the old rows
    //      uncleaned; clearRows() would CUP to addresses now outside the
    //      visible viewport, producing ghost rows in the scrollback.
    //   2. EXPAND: repaint() computes a new startRow against the larger
    //      terminal but skips clearRows() because newRowCount === this.rowCount,
    //      so the old content sits at the old startRow while new content is
    //      written at the new startRow — a visible stripe artifact.
    // resetGeometry() does three things, all synchronously inside the 'resize'
    // event (the IMMEDIATE channel, ResizeBus.subscribeImmediate) so they land
    // before the 150ms debounce window opens and any spinner tick observes stale
    // state:
    //   1. Snapshot the pre-SIGWINCH paint address (lastPaintStartRow + rowCount)
    //      into preResize{StartRow,RowCount}.  This is the ONLY moment the true
    //      old address is still recoverable: stream.rows has already flipped to
    //      the new height, so clearRows() — which recomputes startRow from
    //      stream.rows — can no longer reach the old rows.  The next repaint()
    //      consumes the snapshot via clearPreResizeRows() to erase rows stranded
    //      at the old address (failure mode 2 / EXPAND above).  Mirrors
    //      StatusLine's preResizePaintedRow snapshot.
    //   2. Zero rowCount.  This does NOT make clearRows() run on the next
    //      repaint() — the `if (this.rowCount > 0)` guard there sees 0 and skips
    //      it; the explicit old-row erase is clearPreResizeRows() (point 1).
    //      Zeroing rowCount instead buys two things: (a) the spinner's
    //      `if (rowCount > 0)` guard suppresses mid-window repaints that would
    //      paint against stale geometry; (b) it forces the
    //      `newRowCount !== this.rowCount` equality guard to trip on the next
    //      repaint() so rowCount is re-seeded and onRowCountChange fires the
    //      correct new count.
    //   3. Zero lastRepaint so the throttle gate in scheduleRepaint() is open and
    //      the immediate-next call (spinner or registry event) actually executes
    //      repaint() and re-seizes the correct coordinates.
    if (this.rowCount > 0) {
      this.preResizeStartRow = this.lastPaintStartRow;
      this.preResizeRowCount = this.rowCount;
    }
    this.rowCount = 0;
    this.lastRepaint = 0;
  }

  private scheduleRepaint(): void {
    const now = Date.now();
    if (now - this.lastRepaint < this.throttleMs) return;
    this.repaint();
  }

  /**
   * Re-assert the task rows after something scrolled them off-screen without
   * firing the ResizeBus — chiefly a full-screen scroll inside commitAbove /
   * evictRowsToScrollback (wired via StatusLine.setAfterScrollRestore). No-op
   * when no tasks are running (repaint() early-returns at rowCount 0). Mirrors
   * the ResizeBus subscriber, which already calls repaint().
   */
  redraw(): void {
    this.repaint();
  }

  private repaint(): void {
    if (!this.started || !this.stream.isTTY) return;
    this.lastRepaint = Date.now();

    // Build list of running subagent jobs.
    const items: BackgroundItem[] = (this.registry?.list() ?? [])
      .filter((job) => job.status === 'running')
      .map((job): BackgroundItem => ({ kind: 'subagent', job }));

    const totalRows = this.stream.rows ?? 24;
    // adjacentRows = rows owned by painters between the bg bar and the status
    // line (typically the verdict ledger rail, 0 or 1). The bg bar must not
    // paint into those rows, so clamp against (totalRows - 1 - adjacentRows).
    const adjacentRows = this.getAdjacentRows();
    // Clamp newRowCount against the terminal height (one row reserved for the
    // status line, plus any adjacent painter rows below the bar) BEFORE the
    // equality check below. Storing the clamped value (rather than the raw
    // item count) is what makes the equality guard correctly trip on
    // SIGWINCH-driven geometry changes — e.g. terminal shrinks below item
    // count, or grows past a prior clamp. Without this, a resize that changes
    // the clamp without changing items.length would silently skip clearRows()
    // and leave stale rows behind. Bonus: also suppresses the s/u escape-pair
    // leakage when totalRows ≤ 1 (no paintable rows → early return below).
    const newRowCount = Math.max(0, Math.min(items.length, totalRows - 1 - adjacentRows));

    // Invariant: erase rows stranded at the pre-resize address (set by
    // resetGeometry() on SIGWINCH) BEFORE re-seeding geometry or hitting the
    // early newRowCount===0 return below — otherwise an EXPAND leaves the old
    // rows as a ghost stripe (clearRows() cannot reach them; see
    // resetGeometry()). No-op on every non-resize repaint.
    this.clearPreResizeRows();

    if (newRowCount !== this.rowCount) {
      if (this.rowCount > 0) this.clearRows();
      this.rowCount = newRowCount;
      this.onRowCountChange?.(newRowCount);
    }

    if (newRowCount === 0) return;

    // Start row is offset above adjacent painter rows and the status line.
    const startRow = Math.max(1, totalRows - newRowCount - adjacentRows);
    this.lastPaintStartRow = startRow;

    this.stream.write('\x1b[s');
    for (let i = 0; i < newRowCount; i++) {
      const item = items[i]!;
      const row = startRow + i;
      this.stream.write(`\x1b[${row};1H`);
      this.stream.write('\x1b[2K');
      this.stream.write(this.formatItemLine(item));
    }
    this.stream.write('\x1b[u');
  }

  private clearRows(): void {
    if (!this.stream.isTTY) return;
    const totalRows = this.stream.rows ?? 24;
    const adjacentRows = this.getAdjacentRows();
    // Mirror the same clamping used in repaint() so we only clear rows that
    // were actually written — prevents double-clear of row 0 on small terminals.
    const visibleCount = Math.min(this.rowCount, totalRows - 1 - adjacentRows);
    const startRow = Math.max(1, totalRows - visibleCount - adjacentRows);

    this.stream.write('\x1b[s');
    for (let i = 0; i < visibleCount; i++) {
      this.stream.write(`\x1b[${startRow + i};1H`);
      this.stream.write('\x1b[2K');
    }
    this.stream.write('\x1b[u');
  }

  /**
   * Erase the rows the bar painted at its PRE-resize address — captured by
   * resetGeometry() into preResize{StartRow,RowCount} on the immediate resize
   * channel, before SIGWINCH-updated stream.rows made the old address
   * unrecomputable. Called once at the top of the first repaint() after a
   * resize; a no-op otherwise.
   *
   * Contract: only erases addresses still on-screen in the NEW geometry. On
   * EXPAND the old (higher) rows would otherwise strand as ghosts, so they are
   * erased; on SHRINK the old rows are now below the viewport, where a
   * cursor-move would clamp onto the status-line row — so they are skipped (the
   * terminal reflows them into scrollback, exactly as the pre-existing
   * zero-rowCount path already relied on). Mirrors StatusLine.onResize()'s
   * preResizePaintedRow erase, adapted for the bar's multi-row, relocating
   * start-row.
   */
  private clearPreResizeRows(): void {
    const startRow = this.preResizeStartRow;
    const rowCount = this.preResizeRowCount;
    this.preResizeStartRow = null;
    this.preResizeRowCount = null;
    if (startRow === null || rowCount === null || !this.stream.isTTY) return;
    const totalRows = this.stream.rows ?? 24;
    // Only the old rows still on-screen in the NEW geometry (see Contract).
    // Skipping off-screen rows on SHRINK also avoids leaking a bare s/u pair.
    const rows: number[] = [];
    for (let i = 0; i < rowCount; i++) {
      const row = startRow + i;
      if (row <= totalRows) rows.push(row);
    }
    if (rows.length === 0) return;
    this.stream.write('\x1b[s');
    for (const row of rows) {
      this.stream.write(`\x1b[${row};1H`);
      this.stream.write('\x1b[2K');
    }
    this.stream.write('\x1b[u');
  }

  /** Format a unified BackgroundItem row. */
  private formatItemLine(item: BackgroundItem): string {
    return this.formatJobLine(item.job);
  }

  /** Format a single subagent job row. Shows metadata only — never result text. */
  formatJobLine(job: BackgroundJob): string {
    const maxW = Math.max(4, (this.stream.columns ?? 80) - 2);
    const spinner = palette.brand(SPINNER_FRAMES[this.spinnerIndex]!);
    const id = palette.dim(job.jobId);
    // Prefer label (truncated prompt), fall back to jobId.
    const label = palette.bold(job.label || job.jobId);

    const parts = [spinner, id, label];

    // Stats: elapsed time since startedAt. BackgroundJob has no token/tool fields.
    const elapsed = Date.now() - job.startedAt;
    parts.push(palette.dim(formatDuration(elapsed)));

    return truncateDisplayWidth('  ' + parts.join(' '), maxW);
  }
}
