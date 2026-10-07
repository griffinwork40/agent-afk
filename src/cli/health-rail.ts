/**
 * Session-health glance-rail — a persistent compact single-line footer row.
 *
 * Shows: turn count | elapsed time | tool calls | running/total subagents | context %
 * Example: `T3 · 2m14s · 12 calls · 2/5 subs · ctx 34%`
 *
 * Follows the same DECSTBM reserved-row pattern as {@link LoopStageBar} and
 * {@link BackgroundStatusBar}: the rail never touches DECSTBM directly — it
 * fires `onRowCountChange(1)` on `start()` and `onRowCountChange(0)` on
 * `stop()`. The caller wires those signals into the combined `setExtraRows`
 * accumulator on the status line.
 *
 * The bar sits immediately below the {@link LoopStageBar} within the reserved
 * footer region. Since the health rail's own 1 row is already counted in
 * `extraRows`, the positioning within the reserved band is:
 *   totalRows - getExtraRows()        ← loop-stage bar  (topmost reserved row)
 *   totalRows - getExtraRows() + 1   ← this health rail (second reserved row)
 *   totalRows - N..totalRows-1        ← bg-task bar + verdict ledger
 *   totalRows                         ← status line
 *
 * Lifecycle: construct → start() → update() on every turn boundary or tool
 * completion → stop() before exit. Update is safe to call before start()
 * (fields are buffered and applied on the first repaint).
 *
 * Gated on `isPlainOutputRequested()`: stays inert in plain/non-TTY mode.
 *
 * @module cli/health-rail
 */

import type { BackgroundAgentRegistry } from '../agent/background-registry.js';
import type { SessionStats } from './slash/types.js';
import { formatHealthRail, type HealthRailFields } from './health-rail.format.js';
import { contentMargin } from './render/measure.js';
import { ResizeBus } from './terminal-size.js';
import { ResizeGhostRow } from './resize-ghost-row.js';
import { isPlainOutputRequested } from '../config/env.js';
import { contextLimitFor } from './model-limits.js';

export interface HealthRailOptions {
  stream?: NodeJS.WriteStream;
  backgroundRegistry?: BackgroundAgentRegistry;
  /**
   * Returns the total extra-rows count from the StatusLine. The health rail
   * paints within the reserved footer at `totalRows - extraRows + 1`, i.e.
   * one row below the LoopStageBar (which paints at `totalRows - extraRows`).
   * Both the health rail's own row and the loop-stage row are already counted
   * in `extraRows`.
   *
   * Typically `() => ctx.statusLine.getExtraRows()`.
   */
  getExtraRows: () => number;
  /**
   * Live accessor for foreground subagent counts.
   *
   * Returns `{ active, total }` where:
   *   - `active`  — number of foreground subagents currently in `running` state.
   *   - `total`   — number of foreground subagents ever dispatched this session.
   *
   * Called on every `update()` so the rail reflects the live foreground-wave
   * state. When omitted, foreground agents are not counted (legacy behaviour).
   *
   * Wired via `makeForegroundCountsGetter(ctx)` in `footer-subsystems.ts`.
   * That closure excludes background-registered handles from the foreground
   * count and ratchets the background-seen total to handle registry eviction.
   */
  getForegroundAgentCounts?: () => { active: number; total: number };
}

/**
 * Internal snapshot stored between `update()` calls. Uses `sessionStartTime`
 * instead of a pre-computed `elapsedMs` so that `repaint()` can compute the
 * elapsed duration fresh on every paint — avoiding the frozen-clock bug where
 * `elapsedMs` was baked in at `update()` time and stayed stale between events.
 */
interface RailSnapshot {
  totalTurns: number;
  /** Unix timestamp (ms) of session start — used to compute elapsed at paint time. */
  sessionStartTime: number;
  toolCalls: number;
  /** Currently-running subagents across foreground + background. */
  activeSubs: number;
  /** Total subagents ever dispatched (foreground + background combined high-water mark). */
  totalSubs: number;
  contextRatio: number;
}

/** Opaque handle returned by `HealthRail.start()` — see the class. */
export class HealthRail {
  private readonly stream: NodeJS.WriteStream;
  private readonly registry: BackgroundAgentRegistry | undefined;
  private readonly getExtraRows: () => number;
  private readonly getForegroundAgentCounts: (() => { active: number; total: number }) | undefined;

  private started = false;
  private snapshot: RailSnapshot | null = null;
  private onRowCountChange?: (rows: number) => void;
  private resizeUnsub: (() => void) | null = null;
  /** Interval that triggers a repaint every second while the rail is running. */
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * The absolute row at which the health rail was most recently painted.
   * Updated on every paint so the immediate-channel resize snapshot captures
   * the TRUE pre-SIGWINCH address. Mirrors LoopStageBar.lastPaintedRow.
   */
  private lastPaintedRow: number | null = null;
  /**
   * Tracks the pre-SIGWINCH painted row so the next repaint() can erase the
   * ghost left behind when the pane grows. Owned by ResizeGhostRow; accessed
   * here only through subscribe/consumeGhostRow/unsubscribe. Mirrors the
   * StatusLine.preResizePaintedRow / LoopStageBar pattern extracted into the
   * shared helper.
   */
  private readonly ghostRowTracker = new ResizeGhostRow(() => this.lastPaintedRow);
  /**
   * Monotonic high-water mark for total background subagent jobs ever dispatched.
   *
   * The background registry evicts terminal jobs ~5 minutes after they settle,
   * so `registry.list().length` can shrink over time. This counter only
   * ratchets upward, ensuring the displayed total never decreases.
   */
  private totalBgSubsEver = 0;
  /**
   * Monotonic high-water mark for total foreground subagent dispatches ever seen.
   *
   * The SubagentManager's in-flight map shrinks as children complete, so a
   * point-in-time `total` from `getForegroundAgentCounts()` can decrease. This
   * ratchet ensures the displayed total never decreases (same contract as
   * `totalBgSubsEver`). Resets only with the HealthRail instance, i.e. per session.
   */
  private totalFgSubsEver = 0;

  constructor(opts: HealthRailOptions) {
    this.stream = opts.stream ?? process.stdout;
    this.registry = opts.backgroundRegistry;
    this.getExtraRows = opts.getExtraRows;
    this.getForegroundAgentCounts = opts.getForegroundAgentCounts;
  }

  /** Register the row-count notification handler (wired by the REPL loop). */
  setRowCountChangeHandler(handler: (rows: number) => void): void {
    this.onRowCountChange = handler;
  }

  /**
   * Start the rail: reserve 1 extra row, install the 1-second tick, and paint
   * the initial frame. No-op in plain-output mode or on non-TTY streams.
   */
  start(): void {
    if (this.started) return;
    if (isPlainOutputRequested()) return;
    this.started = true;
    this.onRowCountChange?.(1);
    // Immediate channel: snapshot lastPaintedRow before the debounce window
    // opens so repaint() can erase the ghost row on GROW. ResizeGhostRow
    // registers the ResizeBus.subscribeImmediate handler that captures the
    // pre-SIGWINCH row address synchronously — before any debounced repaint
    // can mutate lastPaintedRow. Mirrors StatusLine / LoopStageBar pattern.
    this.ghostRowTracker.subscribe();
    this.resizeUnsub = ResizeBus.subscribe(() => this.repaint());
    // Tick every second so the elapsed-time counter advances even when no
    // events arrive (e.g. between tool calls or while the model is streaming
    // a long response without hitting a tool boundary).
    this.tickInterval = setInterval(() => this.repaint(), 1000);
    this.repaint();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    this.ghostRowTracker.unsubscribe();
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.clearRow();
    this.onRowCountChange?.(0);
  }

  /**
   * Push a new snapshot. Called after every turn completion and mid-turn on
   * tool-call boundaries. If the rail has not started yet, fields are buffered
   * for the first repaint; otherwise the row is repainted immediately.
   *
   * @param contextRatioOverride When provided, use this value as the context
   *   fill ratio instead of deriving it from `stats.turnTokens`. Pass
   *   `contextSampler.getRatio()` in `onContextProgress` callbacks so the
   *   rail reflects live mid-turn context usage rather than the stale
   *   end-of-previous-turn snapshot.
   */
  update(stats: SessionStats, contextRatioOverride?: number): void {
    // Background subagents: sourced from the BackgroundAgentRegistry.
    const allBgJobs = this.registry ? this.registry.list() : [];
    const activeBgSubs = allBgJobs.filter((j) => j.status === 'running').length;
    // Ratchet upward: registry evicts terminal jobs after ~5 min, so
    // list().length can shrink. The high-water mark never decreases.
    this.totalBgSubsEver = Math.max(this.totalBgSubsEver, allBgJobs.length);

    // Foreground subagents: sourced from the SubagentManager via the injected
    // callback. Falls back to 0/0 when the callback is absent (legacy mode).
    const fg = this.getForegroundAgentCounts?.() ?? { active: 0, total: 0 };
    this.totalFgSubsEver = Math.max(this.totalFgSubsEver, fg.total);

    // Unified counts shown on the rail: foreground + background combined.
    const activeSubs = activeBgSubs + fg.active;
    const totalSubs = this.totalBgSubsEver + this.totalFgSubsEver;

    // Accumulate total tool calls across all completed turns.
    const toolCalls = stats.turns.reduce(
      (sum, t) => sum + (t.toolEvents?.length ?? 0),
      0,
    );

    // Derive context ratio: prefer the live override (from contextSampler)
    // when available; fall back to deriving from the most recent turn's token
    // footprint (which is only populated by recordTurn at end-of-turn).
    let contextRatio: number;
    if (contextRatioOverride !== undefined) {
      contextRatio = contextRatioOverride;
    } else {
      const last = stats.turnTokens[stats.turnTokens.length - 1];
      contextRatio = last !== undefined
        ? (last.footprint ?? last.input + last.output + last.cache) / contextLimitFor(stats.model)
        : 0;
    }

    this.snapshot = {
      totalTurns: stats.totalTurns,
      // Store start time, not elapsed — repaint() recomputes elapsed from
      // Date.now() on every paint so the clock ticks live.
      sessionStartTime: stats.sessionStartTime,
      toolCalls,
      activeSubs,
      totalSubs,
      contextRatio: Math.max(0, Math.min(1, contextRatio)),
    };

    if (this.started) this.repaint();
  }

  /** Re-assert the row. Idempotent — safe to call from afterScrollRestore. */
  redraw(): void {
    this.repaint();
  }

  private repaint(): void {
    if (!this.started || !this.stream.isTTY) return;
    const totalRows = this.stream.rows ?? 24;
    const extraRows = this.getExtraRows();
    // Sits one row below the loop-stage bar within the reserved footer block.
    // The loop-stage bar paints at totalRows - extraRows (topmost reserved row);
    // the health rail paints at totalRows - extraRows + 1 (second reserved row).
    // Both rows are counted in extraRows so both are within the reserved band.
    const paintRow = Math.max(1, totalRows - extraRows + 1);
    const maxW = Math.max(4, (this.stream.columns ?? 80) - 2);

    // Compute elapsedMs at paint time so the counter ticks even between update()
    // calls (e.g. during long tool executions or streaming without tool events).
    const snap = this.snapshot;
    const fields: HealthRailFields = snap
      ? {
          totalTurns: snap.totalTurns,
          elapsedMs: Date.now() - snap.sessionStartTime,
          toolCalls: snap.toolCalls,
          activeSubs: snap.activeSubs,
          totalSubs: snap.totalSubs,
          contextRatio: snap.contextRatio,
        }
      : {
          totalTurns: 0,
          elapsedMs: 0,
          toolCalls: 0,
          activeSubs: 0,
          totalSubs: 0,
          contextRatio: 0,
        };

    // Content centering (AFK_CENTER_CONTENT): prepend left margin so the
    // health rail floats at the same horizontal position as other content.
    const pad = contentMargin();
    this.stream.write('\x1b[s');
    // Erase the ghost left by a pane GROW: consumeGhostRow() returns the
    // pre-SIGWINCH row captured on the immediate channel before stream.rows
    // changed. Only erase when the old row differs from the new paint row AND
    // is inside the current viewport — addressing rows outside [1, totalRows]
    // would scroll. Mirrors LoopStageBar.repaint()'s ghost-erase pattern.
    const ghostRow = this.ghostRowTracker.consumeGhostRow();
    if (ghostRow !== null && ghostRow !== paintRow && ghostRow >= 1 && ghostRow <= totalRows) {
      this.stream.write(`\x1b[${ghostRow};1H`);
      this.stream.write('\x1b[2K');
    }
    this.stream.write(`\x1b[${paintRow};1H`);
    this.stream.write('\x1b[2K');
    this.stream.write(pad + formatHealthRail(fields, Math.max(4, maxW - pad.length)));
    this.stream.write('\x1b[u');
    this.lastPaintedRow = paintRow;
  }

  private clearRow(): void {
    if (!this.stream.isTTY) return;
    const totalRows = this.stream.rows ?? 24;
    const extraRows = this.getExtraRows();
    const paintRow = Math.max(1, totalRows - extraRows + 1);
    this.stream.write('\x1b[s');
    this.stream.write(`\x1b[${paintRow};1H`);
    this.stream.write('\x1b[2K');
    this.stream.write('\x1b[u');
  }
}


