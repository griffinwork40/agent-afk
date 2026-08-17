/**
 * Session-health glance-rail — a persistent compact single-line footer row.
 *
 * Shows: turn count | elapsed time | tool calls | active subagents | context %
 * Example: `T3 · 2m14s · 12 calls · 2 subs · ctx 34%`
 *
 * Follows the same DECSTBM reserved-row pattern as {@link LoopStageBar} and
 * {@link BackgroundStatusBar}: the rail never touches DECSTBM directly — it
 * fires `onRowCountChange(1)` on `start()` and `onRowCountChange(0)` on
 * `stop()`. The caller wires those signals into the combined `setExtraRows`
 * accumulator on the status line.
 *
 * The bar sits immediately above the {@link LoopStageBar} (which is always
 * the topmost reserved row). Row positioning:
 *   totalRows - getExtraRows() - 1   ← this health rail
 *   totalRows - getExtraRows()        ← loop-stage bar  (topmost reserved row)
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
import { ResizeBus } from './terminal-size.js';
import { isPlainOutputRequested } from '../config/env.js';

export interface HealthRailOptions {
  stream?: NodeJS.WriteStream;
  backgroundRegistry?: BackgroundAgentRegistry;
  /**
   * Returns the total extra-rows count from the StatusLine. The health rail
   * paints one row ABOVE the LoopStageBar (which is at totalRows - extraRows),
   * so its paint row is `totalRows - extraRows - 1`.
   *
   * Typically `() => ctx.statusLine.getExtraRows()`.
   */
  getExtraRows: () => number;
}

/** Opaque handle returned by `HealthRail.start()` — see the class. */
export class HealthRail {
  private readonly stream: NodeJS.WriteStream;
  private readonly registry: BackgroundAgentRegistry | undefined;
  private readonly getExtraRows: () => number;

  private started = false;
  private lastFields: HealthRailFields | null = null;
  private onRowCountChange?: (rows: number) => void;
  private resizeUnsub: (() => void) | null = null;

  constructor(opts: HealthRailOptions) {
    this.stream = opts.stream ?? process.stdout;
    this.registry = opts.backgroundRegistry;
    this.getExtraRows = opts.getExtraRows;
  }

  /** Register the row-count notification handler (wired by the REPL loop). */
  setRowCountChangeHandler(handler: (rows: number) => void): void {
    this.onRowCountChange = handler;
  }

  /**
   * Start the rail: reserve 1 extra row and paint the initial frame.
   * No-op in plain-output mode or on non-TTY streams.
   */
  start(): void {
    if (this.started) return;
    if (isPlainOutputRequested()) return;
    this.started = true;
    this.onRowCountChange?.(1);
    this.resizeUnsub = ResizeBus.subscribe(() => this.repaint());
    this.repaint();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    this.clearRow();
    this.onRowCountChange?.(0);
  }

  /**
   * Push a new snapshot. Called after every turn completion and mid-turn on
   * tool-call boundaries. If the rail has not started yet, fields are buffered
   * for the first repaint; otherwise the row is repainted immediately.
   */
  update(stats: SessionStats): void {
    const activeSubs = this.registry
      ? this.registry.list().filter((j) => j.status === 'running').length
      : 0;

    // Accumulate total tool calls across all completed turns.
    const toolCalls = stats.turns.reduce(
      (sum, t) => sum + (t.toolEvents?.length ?? 0),
      0,
    );

    // Derive context ratio from the most recent turn's footprint.
    const last = stats.turnTokens[stats.turnTokens.length - 1];
    const contextRatio = last !== undefined
      ? (last.footprint ?? last.input + last.output + last.cache) / contextLimitFor(stats)
      : 0;

    this.lastFields = {
      totalTurns: stats.totalTurns,
      elapsedMs: Date.now() - stats.sessionStartTime,
      toolCalls,
      activeSubs,
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
    // Sits one row ABOVE the loop-stage bar (which is at totalRows - extraRows).
    const paintRow = Math.max(1, totalRows - extraRows - 1);
    const maxW = Math.max(4, (this.stream.columns ?? 80) - 2);

    const fields: HealthRailFields = this.lastFields ?? {
      totalTurns: 0,
      elapsedMs: 0,
      toolCalls: 0,
      activeSubs: 0,
      contextRatio: 0,
    };

    this.stream.write('\x1b[s');
    this.stream.write(`\x1b[${paintRow};1H`);
    this.stream.write('\x1b[2K');
    this.stream.write(formatHealthRail(fields, maxW));
    this.stream.write('\x1b[u');
  }

  private clearRow(): void {
    if (!this.stream.isTTY) return;
    const totalRows = this.stream.rows ?? 24;
    const extraRows = this.getExtraRows();
    const paintRow = Math.max(1, totalRows - extraRows - 1);
    this.stream.write('\x1b[s');
    this.stream.write(`\x1b[${paintRow};1H`);
    this.stream.write('\x1b[2K');
    this.stream.write('\x1b[u');
  }
}

/**
 * Approximate context-window limit for the session's model.
 *
 * Contract: this is a best-effort approximation used ONLY for the glance
 * indicator — it does not feed any operational decision. The authoritative
 * value lives in `model-limits.ts`; importing it here would drag the full
 * model table into the CLI render path, so we use a simple common-case
 * heuristic (200k for Claude) that keeps the health rail self-contained.
 * A better future option: accept `contextLimit` as a field in `update()`.
 */
function contextLimitFor(stats: SessionStats): number {
  const model = String(stats.model);
  // Claude extended context tiers
  if (model.includes('opus-5') || model.includes('claude-opus-5')) return 500_000;
  if (model.includes('3-5') || model.includes('claude-3-5')) return 200_000;
  if (model.includes('3-7') || model.includes('claude-3-7')) return 200_000;
  // Default for other Claude / OpenAI models
  return 200_000;
}
