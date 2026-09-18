/**
 * Persistent bottom-of-terminal status line.
 *
 * Reserves the last terminal row, parks the cursor above it, and repaints on
 * demand. Implemented with raw ANSI escape sequences — no ink, no readline
 * takeover. TTY-gated: on non-TTY stdouts the StatusLine is a no-op.
 *
 * Usage:
 *   const status = new StatusLine();
 *   status.start();
 *   status.repaint({ model: 'sonnet', cost: 0.02, tokens: 1200, contextPct: 0.12 });
 *   status.stop();   // before exit
 */

import { ResizeBus } from './terminal-size.js';
import { isPlainOutputRequested } from '../config/env.js';
import { formatStatusLine, type StatusLineFields } from './render/status-line-format.js';

export type { StatusLineFields } from './render/status-line-format.js';

interface StatusLineOpts {
  /** Stream to write escape codes to. Defaults to process.stdout. */
  stream?: NodeJS.WriteStream;
  /** Force-enable even on non-TTY (tests). */
  force?: boolean;
  /** Minimum ms between repaints — avoids flicker on fast streams. */
  throttleMs?: number;
  /**
   * Interval in ms at which a started line re-paints itself from `lastFields`,
   * so clock-derived content stays true. `0` (the default) never ticks.
   *
   * Defaults OFF and is enabled by the interactive caller (bootstrap.ts),
   * mirroring how the compositor resolves caret-blink enablement caller-side:
   * every direct/test construction stays free of an auto-started recurring
   * timer.
   */
  tickMs?: number;
}

export class StatusLine {
  private readonly stream: NodeJS.WriteStream;
  private readonly force: boolean;
  private readonly throttleMs: number;
  private readonly tickMs: number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastRepaint = 0;
  private lastFields: StatusLineFields | null = null;
  private resizeUnsub: (() => void) | null = null;
  private resizeImmediateUnsub: (() => void) | null = null;
  private lastPaintedRow: number | null = null;
  /** Captures lastPaintedRow at SIGWINCH time for onResize() to use as the stale-row target. */
  private preResizePaintedRow: number | null = null;
  private extraRows = 0;
  private afterScrollRestore: (() => void) | null = null;

  constructor(opts: StatusLineOpts = {}) {
    this.stream = opts.stream ?? process.stdout;
    this.force = opts.force ?? false;
    this.throttleMs = opts.throttleMs ?? 100;
    this.tickMs = opts.tickMs ?? 0;
  }

  private get enabled(): boolean {
    // AFK_PLAIN_OUTPUT / --plain is a full render opt-out: a TTY session with
    // the flag set must behave like a non-TTY surface, so the DECSTBM scroll
    // region and cursor-positioned status row are suppressed exactly as they
    // are on a genuine non-TTY stdout (where `isTTY` is false). Every escape-
    // emitting method routes through this getter, so gating here neutralizes
    // start/repaint/setExtraRows/onResize/rearm/withFullScrollRegion/stop in
    // one place. Mirrors the compositor/renderer/input gates that also consult
    // `isPlainOutputRequested` (config/env.ts). `force` (tests) still wins.
    return this.force || (!!this.stream.isTTY && !isPlainOutputRequested());
  }

  /** Reserve the bottom row by reducing the scroll region. */
  start(): void {
    if (this.started || !this.enabled) return;
    this.started = true;
    this.lastRepaint = 0;
    const rows = this.currentRows();
    // Preserve the current cursor so startup/resize arming does not clobber
    // already-rendered output above the reserved status row.
    this.stream.write('\x1b[s');
    this.writeScrollRegion(rows);
    this.stream.write('\x1b[u');
    if (this.resizeUnsub === null) {
      this.resizeUnsub = ResizeBus.subscribe(() => {
        this.onResize();
      });
      this.resizeImmediateUnsub = ResizeBus.subscribeImmediate(() => this.resetGeometry());
    }
    // Invariant: this is the ONLY time-driven repaint of the status row, and
    // clock-derived content depends on it. The quota segment renders a reset
    // countdown and a `~` staleness marker computed against `new Date()` at
    // paint time (quota-indicator.ts), and grades droppability from that same
    // freshness — but every other repaint here is event-driven (turn events,
    // git/context samplers, resize, a NEW quota reading). An idle session fires
    // none of them, so without this ticker a countdown sits frozen and a
    // reading never crosses into `stale` on screen. `flush()` re-renders from
    // `lastFields`, so each tick recomputes those values against the current
    // clock. `unref()` keeps the interval from holding the process open; the
    // inverse lives at the top of stop(), ahead of its early return.
    if (this.tickMs > 0 && this.tickTimer === null) {
      this.tickTimer = setInterval(() => this.flush(), this.tickMs);
      this.tickTimer.unref();
    }
  }

  private resetGeometry(): void {
    // Invariant: capturing `lastPaintedRow` into `preResizePaintedRow` BEFORE
    // nulling it is critical to preserve the stale-row-clear capability of
    // onResize() while also preventing mid-window repaint() calls from
    // corrupting the stale-row reference.
    //
    // The race this method prevents:
    //   SIGWINCH fires → stream.rows changes to newRows.
    //   A repaint(fields) call arrives in the 150ms debounce window (e.g. from a
    //   streaming token event).  repaint() writes to paintRow(newRows) and sets
    //   lastPaintedRow = paintRow(newRows).
    //   When onResize() finally fires, it reads lastPaintedRow = paintRow(newRows)
    //   and (correctly) sees that lastPaintedRow === paintRow(newRows), so it
    //   emits NO clear for the old row.  The pre-SIGWINCH content at
    //   paintRow(oldRows) is never erased — a visible stale-row artifact remains.
    //
    // By snapshotting lastPaintedRow → preResizePaintedRow here and nulling
    // lastPaintedRow synchronously, we achieve two goals simultaneously:
    //   1. onResize() reads preResizePaintedRow (the true pre-SIGWINCH row)
    //      for the old-row clear, immune to any mid-window repaint() mutation
    //      of lastPaintedRow.
    //   2. Mid-window repaint() writes to the new paintRow and seeds
    //      lastPaintedRow = paintRow(newRows).  Because lastPaintedRow was
    //      nulled, the mid-window repaint runs unconditionally (throttle gate
    //      open via lastRepaint=0) and does not attempt to clear a stale row
    //      on its own — onResize() will handle that.
    //
    // This must execute on the IMMEDIATE channel (ResizeBus.subscribeImmediate)
    // so the snapshot is taken synchronously inside the 'resize' event, before
    // any macrotask (streaming event, spinner tick) can mutate lastPaintedRow.
    this.preResizePaintedRow = this.lastPaintedRow;
    this.lastPaintedRow = null;
    this.lastRepaint = 0;
  }

  /** Re-anchor DECSTBM when the terminal height changes, then repaint. */
  private onResize(): void {
    if (!this.started || !this.enabled) return;
    const rows = this.currentRows();
    // Use preResizePaintedRow (set by resetGeometry() on the immediate channel)
    // as the authoritative old-row reference.  lastPaintedRow may have been
    // updated by a mid-window repaint() call and therefore already reflects the
    // new geometry — using it here would skip the necessary old-row clear.
    const rowToErase = this.preResizePaintedRow ?? this.lastPaintedRow;
    this.preResizePaintedRow = null;
    this.stream.write('\x1b[s');
    if (rowToErase !== null && rowToErase !== this.paintRow(rows)) {
      this.stream.write(`\x1b[${rowToErase};1H`);
      this.stream.write('\x1b[2K');
    }
    this.writeScrollRegion(rows);
    this.stream.write('\x1b[u');
    this.eraseReservedBand(rows);
    this.flush();
  }

  /** Repaint the status line with the given fields. */
  repaint(fields: StatusLineFields): void {
    if (!this.enabled || !this.started) {
      this.lastFields = fields;
      return;
    }
    const now = Date.now();
    if (now - this.lastRepaint < this.throttleMs) {
      this.lastFields = fields;
      return;
    }
    this.lastRepaint = now;
    this.lastFields = fields;

    const rows = this.currentRows();
    // Save cursor, move to bottom row, clear line, paint, restore.
    this.stream.write('\x1b[s');
    this.stream.write(`\x1b[${this.paintRow(rows)};1H`);
    this.stream.write('\x1b[2K');
    this.stream.write(this.formatLine(fields));
    this.stream.write('\x1b[u');
    this.lastPaintedRow = this.paintRow(rows);
  }

  /** Force an immediate repaint bypassing the throttle. */
  flush(): void {
    this.lastRepaint = 0;
    if (this.lastFields) this.repaint(this.lastFields);
  }

  /**
   * Reserve additional rows above the status line (e.g. for the background
   * task bar). Adjusts the DECSTBM scroll region to leave room.
   */
  setExtraRows(n: number): void {
    this.extraRows = n;
    if (this.started && this.enabled) {
      const rows = this.currentRows();
      this.stream.write('\x1b[s');
      this.writeScrollRegion(rows);
      this.stream.write('\x1b[u');
      this.eraseReservedBand(rows);
      this.flush();
    }
  }

  /** Returns the current extra-rows reservation count. */
  getExtraRows(): number {
    return this.extraRows;
  }

  /**
   * Register a callback fired at the END of every {@link withFullScrollRegion}
   * cycle, immediately after the scroll region is re-established and the status
   * line is re-flushed.
   *
   * Why this exists: `withFullScrollRegion` performs a FULL-SCREEN scroll (so
   * the displaced top line enters scrollback — see the method's doc). That
   * scroll drags the entire reserved footer UP with it: not just this status
   * row (which self-heals here via `flush()`), but also the rows OWNED by the
   * loop-stage rail and the background-task bar that sit in the `extraRows`
   * band just above the status line. Those bars do NOT otherwise repaint after
   * a scroll (only on ResizeBus), so their scrolled-up copies orphan — the
   * most visible symptom being a DUPLICATE status row one line above the rail
   * (the live frame's bottom is `rows-1-extraRows`, so it no longer covers the
   * `rows-1` row the status copy lands on once `extraRows > 0`; see #634).
   *
   * The caller (repl-loop) registers a callback that redraws those footer bars
   * so they self-heal exactly like the status line. Fired AFTER `flush()` so
   * the status row is already correct and the bars repaint over the
   * higher rows. Each bar brackets its own write in save/restore, so the
   * cursor `withFullScrollRegion` preserved for the next compositor repaint
   * survives.
   */
  setAfterScrollRestore(cb: (() => void) | null): void {
    this.afterScrollRestore = cb;
  }

  /**
   * Re-establish the scroll region and repaint. Call after anything that
   * resets the terminal scroll region (e.g. log-update teardown).
   */
  rearm(): void {
    if (!this.started || !this.enabled) return;
    const rows = this.currentRows();
    this.stream.write('\x1b[s');
    this.writeScrollRegion(rows);
    this.stream.write('\x1b[u');
    this.eraseReservedBand(rows);
    this.flush();
  }

  /**
   * Run `fn` with the DECSTBM scroll region temporarily reset to the full
   * screen, so any `\n` written by `fn` that lands at the bottom row causes
   * a full-screen scroll (which enters the terminal's scrollback buffer)
   * rather than a sub-region scroll (which on xterm/iTerm2/Apple Terminal
   * silently discards displaced lines).
   *
   * External constraint (VT100/DECSTBM contract): `ESC [ <t> ; <b> r` sets
   * the scrolling region. Lines that exit the *top* of a sub-region via an
   * `\n` at the bottom of that region do not enter scrollback on standard
   * xterm-derived emulators. Resetting to full-screen (`ESC [ r`) for the
   * duration of the write makes the same `\n` produce a scrollback-bound
   * scroll instead.
   *
   * Sequence (each step is mandatory and order-sensitive):
   *   1. save cursor, emit `ESC [ r` to reset DECSTBM to full screen, restore
   *      cursor — DECSTBM homes the cursor to (1,1) per DEC VT spec, so
   *      without bracketing save/restore the inner fn() write would land at
   *      the top of the screen instead of the caller's cursor.
   *   2. invoke fn() — writes happen with full-screen scroll semantics
   *   3. save cursor, re-establish the prior DECSTBM region via
   *      writeScrollRegion(), restore cursor — again, the DECSTBM re-arm
   *      homes the cursor, so we must save the post-fn position first.
   *   4. flush() to re-paint the status line at the bottom row in case
   *      step 2 caused a full-screen scroll that displaced it. flush() does
   *      its own save/restore around the status repaint, so the cursor we
   *      restored in step 3 survives.
   *
   * External constraint (DEC VT spec): CSI r (DECSTBM, with or without
   * arguments) moves the cursor to the home position (1,1). Every other
   * DECSTBM emit in this file (start, onResize, repaint, stop) brackets
   * the emit with `\x1b[s` / `\x1b[u`; this method must too. Tested by
   * `cursor preservation` cases in status-line.test.ts.
   *
   * No-op (returns fn() directly) when status line is not started or
   * not enabled (non-TTY): the scroll region is not active, so the
   * sub-region scroll loss cannot occur.
   */
  withFullScrollRegion<T>(fn: () => T): T {
    if (!this.started || !this.enabled) return fn();
    // Save before DECSTBM reset so fn() resumes from the caller's cursor,
    // not the (1,1) home position the reset would otherwise leave us at.
    this.stream.write('\x1b[s');
    this.stream.write('\x1b[r');
    this.stream.write('\x1b[u');
    try {
      return fn();
    } finally {
      const rows = this.currentRows();
      // Save before DECSTBM re-arm so the post-fn cursor (where fn() left
      // off) survives the re-arm's cursor-home. flush() then does its own
      // save/restore around the status repaint, preserving this cursor for
      // whatever runs next (typically the compositor's repaint).
      this.stream.write('\x1b[s');
      this.writeScrollRegion(rows);
      this.stream.write('\x1b[u');
      this.eraseReservedBand(rows);
      this.flush();
      // Re-assert the footer bars (loop-stage rail, background-task bar) that
      // the full-screen scroll dragged upward. Without this their scrolled-up
      // copies orphan above the status row — see setAfterScrollRestore().
      this.afterScrollRestore?.();
    }
  }

  /** Release the scroll region and clear the status row. */
  stop(): void {
    // Cleared FIRST, ahead of the `!started || !enabled` early return below: an
    // armed ticker is the one piece of state that can outlive a line which is
    // no longer started, so a late return must never skip its teardown.
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.resizeUnsub !== null) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    if (this.resizeImmediateUnsub !== null) {
      this.resizeImmediateUnsub();
      this.resizeImmediateUnsub = null;
    }
    if (!this.started || !this.enabled) {
      this.started = false;
      return;
    }
    const rows = this.currentRows();
    this.stream.write('\x1b[s');
    // Symmetric with onResize(): prefer preResizePaintedRow so a mid-debounce
    // repaint() that re-seeded lastPaintedRow to the new geometry doesn't cause
    // stop() to erase the wrong (new-geometry) row.
    const rowToErase = this.preResizePaintedRow ?? this.lastPaintedRow ?? this.paintRow(rows);
    this.stream.write(`\x1b[${rowToErase};1H`);
    this.stream.write('\x1b[2K');
    // Reset scroll region to full.
    this.stream.write('\x1b[r');
    this.stream.write('\x1b[u');
    this.started = false;
    this.lastRepaint = 0;
    this.lastPaintedRow = null;
    this.preResizePaintedRow = null;
  }

  private formatLine(f: StatusLineFields): string {
    const maxW = Math.max(4, (this.stream.columns ?? 80) - 2);
    return formatStatusLine(f, maxW);
  }

  private currentRows(): number {
    const rows = this.stream.rows;
    return typeof rows === 'number' && rows > 0 ? rows : 24;
  }

  private paintRow(rows: number): number {
    return rows > 1 ? rows : 1;
  }

  private writeScrollRegion(rows: number): void {
    const reserved = 1 + this.extraRows;
    if (rows > reserved) {
      this.stream.write(`\x1b[1;${rows - reserved}r`);
      return;
    }
    this.stream.write('\x1b[r');
  }

  // Invariant (reserved-band erase): clear every row between the scroll
  // region bottom and the status line's paint row. After any full-screen
  // scroll, DECSTBM re-arm, or extraRows change, displaced copies of the
  // status line and footer bars land in this band. flush() repaints the
  // status line at `rows`, and afterScrollRestore redraws the footer bars
  // at their current positions -- but neither erases the PREVIOUS contents
  // of these rows. Those ghost copies sit below the compositor frame bottom
  // and above the status row, invisible to both erase passes.
  //
  // Called from: withFullScrollRegion (scroll displaced ghosts), rearm
  // (DECSTBM re-establishment may expose stale content), setExtraRows
  // (band expansion captures rows that previously held scroll-region
  // content). The subsequent flush() + afterScrollRestore then repaint
  // clean content over the cleared rows.
  private eraseReservedBand(rows: number): void {
    const reserved = 1 + this.extraRows;
    // Erase rows (rows - reserved + 1) through (rows - 1) -- everything
    // between the scroll-region bottom and the status line's paint row.
    // When reserved === 1 (no footer bars), the range is empty: the status
    // line at `rows` is the only reserved row, and its own repaint covers
    // any ghost at that position.
    if (reserved <= 1) return;
    let erase = '';
    for (let r = rows - reserved + 1; r < rows; r++) {
      erase += `\x1b[${r};1H\x1b[2K`;
    }
    if (erase.length > 0) {
      this.stream.write('\x1b[s' + erase + '\x1b[u');
    }
  }
}
