/**
 * Loop-stage tracker and reserved-footer bar.
 *
 * AFK's system prompt names a five-stage operating loop:
 *
 *     Observe → Model → Choose → Act → Update
 *
 * The stages are not narrated by the model and are not first-class events on
 * the runtime side either. But the live `OutputEvent` stream carries enough
 * structural signal to *infer* which stage is currently active, and the
 * inference is honest because each stage label is grounded in an event kind
 * the runtime literally observed:
 *
 *   - `observing`  — turn just armed, no events yet (waiting for the SDK).
 *   - `modeling`   — `thinking` chunk active and no tool calls in flight.
 *   - `choosing`   — content streaming and no tool in flight (the model is
 *                    composing prose that commits to a path).
 *   - `acting`     — at least one tool_use_detail with no matching tool_result.
 *   - `updating`   — the most recent event is a tool_result and no new tool
 *                    has started (the model is folding the result into its
 *                    next move).
 *
 * The tracker is event-driven and order-sensitive. It is a pure state
 * machine: feed it events; ask it for the current stage. It does not own
 * any rendering — `LoopStageBar` consults it when painting the reserved
 * footer row, and `stream-renderer-orchestrator.ts` advances it on every
 * streaming event.
 *
 * This module deliberately does not invent state the runtime cannot prove.
 * For example we do not surface a "Choose" indicator merely because no tool
 * has fired yet — only when content is actively streaming. If the model
 * sits silent the indicator stays at "Observe".
 *
 * ## LoopStageBar
 *
 * `LoopStageBar` pins the stage rail as its own reserved footer row above
 * the status line, using the same DECSTBM extra-row reservation mechanism
 * as `BackgroundStatusBar`. It paints directly via CUP (cursor absolute
 * positioning) inside `\x1b[s` / `\x1b[u` save/restore brackets, leaving
 * the compositor's scroll region and overlay frame entirely undisturbed.
 *
 * Lifecycle: construct → `start()` → `repaint(stage)` on each stage
 * transition → `stop()` before exit.
 */

import type { OutputEvent } from '../../../agent/types.js';
import { ResizeBus } from '../../terminal-size.js';
import { palette } from '../../palette.js';
import { isPlainOutputRequested } from '../../../config/env.js';

export type LoopStage = 'observing' | 'modeling' | 'choosing' | 'acting' | 'updating';

/** All stages in canonical order — used by the rail renderer. */
export const LOOP_STAGES: readonly LoopStage[] = [
  'observing',
  'modeling',
  'choosing',
  'acting',
  'updating',
] as const;

/**
 * One-letter glyph + short label per stage. The rail shows the labels; the
 * compact spinner uses the glyphs only when width is constrained.
 */
export const STAGE_LABEL: Record<LoopStage, string> = {
  observing: 'observe',
  modeling: 'model',
  choosing: 'choose',
  acting: 'act',
  updating: 'update',
};

/**
 * Tracker state. Exposed through methods rather than a class so it remains
 * trivially serializable for tests.
 */
export interface StageTrackerState {
  stage: LoopStage;
  /** Tool-use ids whose result has not yet been seen. */
  pendingTools: Set<string>;
}

/** Construct a fresh tracker positioned at the start of a turn. */
export function createStageTracker(): StageTrackerState {
  return { stage: 'observing', pendingTools: new Set() };
}

/**
 * Reset the tracker to the start-of-turn state. Called by the turn handler
 * each time a new user message is sent so stale `pendingTools` don't leak
 * across turns.
 */
export function resetStageTracker(s: StageTrackerState): void {
  s.stage = 'observing';
  s.pendingTools.clear();
}

/**
 * Advance the tracker for one event. Returns true when the stage actually
 * changed — callers can use this to repaint sparingly. The function never
 * throws and never blocks; unknown event kinds are ignored.
 *
 * Ordering note: the tracker checks `pendingTools` *before* it consults the
 * event kind so that a freshly-arrived `tool_result` flips us into
 * `updating` for one beat before the next `tool_use_detail` (if any) drags
 * us back into `acting`. That two-step is what makes the rail feel alive
 * during multi-tool turns.
 */
export function advanceStage(s: StageTrackerState, event: OutputEvent): boolean {
  const prev = s.stage;

  switch (event.type) {
    case 'chunk': {
      const chunk = event.chunk;
      if (chunk.type === 'tool_use_detail') {
        s.pendingTools.add(chunk.toolUseId);
        s.stage = 'acting';
      } else if (chunk.type === 'tool_result') {
        s.pendingTools.delete(chunk.toolUseId);
        // If more tools are still pending, we're still acting; otherwise
        // we're updating (folding results back into the model).
        s.stage = s.pendingTools.size > 0 ? 'acting' : 'updating';
      } else if (chunk.type === 'thinking') {
        // Thinking always means "modeling", regardless of pending tools — the
        // model is reasoning, not acting, even if a tool is still in flight.
        if (s.pendingTools.size === 0) s.stage = 'modeling';
      } else if (chunk.type === 'content') {
        // Content streaming with no tools in flight = composing the chosen
        // path. While tools are in flight content is rare; if it does
        // happen we leave the stage as 'acting' so the rail doesn't flicker.
        if (s.pendingTools.size === 0) s.stage = 'choosing';
      }
      // tool_diff, tool_use: render-only chunk types — no stage signal.
      break;
    }
    case 'done':
      // Don't override the trailing stage — the orchestrator finalizes its
      // own visuals. Just clear pendingTools defensively.
      s.pendingTools.clear();
      break;
    default:
      // progress / error / message / panel / suggestion — no stage signal.
      break;
  }

  return s.stage !== prev;
}

/**
 * Render a one-line stage rail showing the five stages with the active one
 * highlighted. Used by `LoopStageBar` to paint the reserved footer row.
 *
 * Format (active = solid diamond + bold):
 *
 *     ◇ observe · ◇ model · ◇ choose · ◆ act · ◇ update
 *
 * Color is intentionally restrained — bold + accent on the active stage,
 * dim on inactives. The goal is glance-readable, not decorative.
 *
 * Special case: `observing` is the idle/reset stage between turns (a turn
 * just armed with no events yet, or no turn in flight at all) — the rail has
 * nothing earned to show, so painting all five cells persistently between
 * turns is chrome, not signal. Collapse to a single dim `· idle` cell
 * instead of the full 5-cell rail. Every other stage renders the full rail
 * unchanged.
 */
export function formatStageRail(
  active: LoopStage,
  fmt: { dim: (s: string) => string; accent: (s: string) => string; bold: (s: string) => string },
): string {
  if (active === 'observing') {
    return fmt.dim('· idle');
  }
  const cells = LOOP_STAGES.map((stage) => {
    const isActive = stage === active;
    const glyph = isActive ? '◆' : '◇';
    const label = STAGE_LABEL[stage];
    const cell = `${glyph} ${label}`;
    return isActive ? fmt.accent(fmt.bold(cell)) : fmt.dim(cell);
  });
  return cells.join(fmt.dim(' · '));
}

// ─── Reserved-footer bar ────────────────────────────────────────────────────

/**
 * Persistent loop-stage bar pinned as a reserved footer row above the status
 * line.
 *
 * Uses the same DECSTBM extra-row reservation mechanism as
 * `BackgroundStatusBar`: it never touches DECSTBM directly; instead it fires
 * `onRowCountChange(1)` on `start()` and `onRowCountChange(0)` on `stop()`.
 * The caller (repl-loop) wires that callback into a combined `setExtraRows`
 * accumulator (loop-stage rows + bg-bar rows) so the scroll region accounts
 * for both bars.
 *
 * ## Row positioning
 *
 * This bar always occupies the *topmost* row of the reserved footer block —
 * i.e. row `totalRows − totalExtraRows` (where `totalExtraRows` is the full
 * extra-rows count including this bar's own 1 row). It reads `totalExtraRows`
 * via the `getExtraRows` callback supplied at construction, so it sits above
 * the BackgroundStatusBar rows even as that count fluctuates.
 *
 * Paint target formula:
 *   `paintRow = totalRows − getExtraRows()`
 *
 * Example: rows=24, extraRows=3 (1 loop-stage + 2 bg-tasks) →
 *   paintRow = 21  (loop-stage bar)
 *   bg-bar rows 22–23
 *   status line row 24
 *
 * The bar paints using CUP (`\x1b[${paintRow};1H`) bracketed by
 * `\x1b[s` / `\x1b[u` (save/restore cursor), mirroring the technique in
 * `BackgroundStatusBar.repaint()`. It renders exactly one row.
 *
 * Visibility: renders whenever `started === true` and the stream is a TTY.
 * Between turns (stage = `'observing'`) `formatStageRail` collapses the full
 * 5-cell rail to a single dim `· idle` cell (see its docstring) rather than
 * painting all five stages with none of them earned yet.
 */
export class LoopStageBar {
  private readonly stream: NodeJS.WriteStream;
  private readonly getExtraRows: () => number;
  private started = false;
  private currentStage: LoopStage = 'observing';
  private resizeUnsub: (() => void) | null = null;
  private onRowCountChange?: (rows: number) => void;

  /**
   * @param opts.getExtraRows - Returns the current total extra-rows reservation
   *   from the StatusLine (including this bar's own 1 row). Used to compute
   *   the absolute paint row. Typically `() => ctx.statusLine.getExtraRows()`.
   * @param opts.stream - Write stream (defaults to `process.stdout`).
   */
  constructor(opts: { getExtraRows: () => number; stream?: NodeJS.WriteStream }) {
    this.stream = opts.stream ?? process.stdout;
    this.getExtraRows = opts.getExtraRows;
  }

  setRowCountChangeHandler(handler: (rows: number) => void): void {
    this.onRowCountChange = handler;
  }

  start(): void {
    if (this.started) return;
    // AFK_PLAIN_OUTPUT / --plain is a full render opt-out: stay inert so a
    // --plain TTY behaves like a non-TTY surface — no 1-row DECSTBM
    // reservation, no ResizeBus subscription, no CUP paint (every paint path
    // is gated on `started`). Mirrors the status-line/compositor/renderer/
    // input gates on `isPlainOutputRequested` (config/env.ts).
    if (isPlainOutputRequested()) return;
    this.started = true;
    // Reserve 1 row first so the DECSTBM is updated before we paint.
    this.onRowCountChange?.(1);
    this.resizeUnsub = ResizeBus.subscribe(() => this.repaint(this.currentStage));
    this.repaint(this.currentStage);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.resizeUnsub) {
      this.resizeUnsub();
      this.resizeUnsub = null;
    }
    this.clearRow();
    // Release our 1-row reservation.
    this.onRowCountChange?.(0);
  }

  /**
   * Update the displayed stage and repaint the reserved row. Called by the
   * stream-renderer orchestrator (via `LoopStageBar.repaint`) whenever the
   * stage tracker advances.
   */
  repaint(stage: LoopStage): void {
    if (!this.started || !this.stream.isTTY) return;
    this.currentStage = stage;
    const totalRows = this.stream.rows ?? 24;
    const extraRows = this.getExtraRows();
    // Paint at the topmost row of the reserved block.  extraRows includes our
    // own 1 row, so `totalRows - extraRows` is the row immediately above the
    // BackgroundStatusBar rows (or immediately above the status line when the
    // bg bar is empty).
    const paintRow = Math.max(1, totalRows - extraRows);
    this.stream.write('\x1b[s');
    this.stream.write(`\x1b[${paintRow};1H`);
    this.stream.write('\x1b[2K');
    this.stream.write(
      '  ' +
        formatStageRail(stage, {
          dim: palette.dim,
          accent: palette.brand,
          bold: palette.bold,
        }),
    );
    this.stream.write('\x1b[u');
  }

  /**
   * Re-assert the rail at its current stage. Idempotent. Called after anything
   * that scrolls the rail off its reserved row without going through the
   * ResizeBus — chiefly a full-screen scroll inside commitAbove /
   * evictRowsToScrollback (wired via StatusLine.setAfterScrollRestore). Mirrors
   * the ResizeBus subscriber, which already does `repaint(currentStage)`.
   */
  redraw(): void {
    this.repaint(this.currentStage);
  }

  private clearRow(): void {
    if (!this.stream.isTTY) return;
    const totalRows = this.stream.rows ?? 24;
    // Use the pre-stop extraRows (still includes our 1 row at this point).
    const extraRows = this.getExtraRows();
    const paintRow = Math.max(1, totalRows - extraRows);
    this.stream.write('\x1b[s');
    this.stream.write(`\x1b[${paintRow};1H`);
    this.stream.write('\x1b[2K');
    this.stream.write('\x1b[u');
  }
}
