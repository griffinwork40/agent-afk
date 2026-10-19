/**
 * tmux narrowing-reflow shift prediction for the compositor's tracked rows.
 *
 * Invariant: tmux cursor-pinned reflow. When a tmux pane NARROWS, tmux
 * rewraps every on-screen line wider than the new width into
 * ceil(width / newCols) rows (hard lines included: it never JOINS a hard line
 * to its neighbour, but it does split it) and keeps the CURSOR ROW FIXED.
 * Every row above the cursor therefore moves UP by N, the total number of
 * extra rows created by lines between it and the cursor; rows pushed above
 * row 1 go into tmux history. A width-only resize does not move the cursor,
 * so the CPR probe alone measures delta 0 and sees nothing. The compositor's
 * absolute rows (anchorRow floor, committed band, pendingResizeErase) stay at
 * their pre-resize values, the band is repainted at the OLD floor, and the
 * rewrapped original's top fragment survives above it (a visible duplicate
 * under a banner) or lands in history while being repainted (a scrollback
 * duplicate at anchorRow 1).
 *
 * Contract: the shift applied above the cursor is `measuredDelta - N`, so a
 * terminal that keeps the TOP fixed (cursor moves down N) yields shift 0, and
 * tmux (cursor pinned, delta 0) yields -N. N=0, an unknown line state, a CPR
 * timeout/implausible reply, or the gate being off reproduce the previous
 * behaviour exactly. Gated to tmux (env.TMUX); injectable for tests.
 */

import { env } from '../config/env.js';
import { displayWidth, stripAnsi } from './display.js';
import { hardWrapToWidth } from './wrap.js';
import { compositorBand } from './terminal-compositor.content-band.js';
import type { BandRowMeta } from './terminal-compositor.types.js';
import { reflowCommittedBandToWidth, type BandReflowCache } from './terminal-compositor.band-reflow.js';

/** One on-screen terminal line: painted display width and whether it is hard. */
export interface ReflowLine {
  /** 1-based screen row the line occupies before the resize. */
  row: number;
  /** Painted display width (margin + content, ANSI stripped). */
  width: number;
  /** False when the terminal may treat the line as soft-wrapped (join risk). */
  hard: boolean;
}

/**
 * Extra rows tmux creates when rewrapping `lines` from `oldCols` to `newCols`.
 * Each line occupies one row at `oldCols` (DECAWM-off band rows are clipped
 * there, so at most `oldCols` cells exist). Returns null when any non-blank
 * line is not known to be hard (caller falls back to no shift).
 * @returns The total count of extra rows N, or null when the shift is unknown
 *   (non-positive width, or a non-hard line is present). A null return causes
 *   the caller to fall back to the pre-shift behaviour (no row adjustment).
 */
export function computeReflowShift(lines: readonly ReflowLine[], oldCols: number, newCols: number): number | null {
  if (newCols <= 0 || oldCols <= 0) return null;
  let n = 0;
  for (const line of lines) {
    const w = Math.min(Math.max(0, line.width), oldCols);
    if (w === 0) continue;
    if (!line.hard) return null;
    n += Math.max(0, Math.ceil(w / newCols) - 1);
  }
  return n;
}

let reflowGateOverride: (() => boolean) | null = null;

/** Test seam: force the tmux gate on/off; pass null to restore env detection. */
export function setReflowShiftGateForTests(gate: (() => boolean) | null): void {
  reflowGateOverride = gate;
}

function reflowGateOn(): boolean {
  return reflowGateOverride ? reflowGateOverride() : Boolean(env.TMUX);
}

/** Host slice read when snapshotting lines and when applying the shift. */
export interface ReflowHost {
  readonly stdout: NodeJS.WriteStream;
  lastKnownCols: number;
  lastMeasuredFrameBottom: number;
  anchorRow: number | undefined;
  committedBand: string[];
  committedBandMeta: BandRowMeta[];
  committedBandTopRow: number;
  committedBandBottomRow: number;
  committedBandPaintedRows: number;
  committedBandArchivedPrefix: number;
  bandReflowCache: BandReflowCache | null;
  pendingResizeErase: { top: number; bottom: number; origin?: 'width-only' | 'expand' } | null;
}

/** Read-only slice needed to snapshot lines on SIGWINCH. */
export type SnapshotHost = Omit<ReflowHost, 'bandReflowCache'>;

interface FrameRecord { text: string; bottom: number; cols: number }
/**
 * The committed band's painted rows as tmux saw them at snapshot time: the
 * content strings (painted suffix of `committedBand`) and the OLD centering
 * margin tmux rewrapped them with (painted width = marginCols + content).
 */
export interface BandSnapshot { rows: readonly string[]; marginCols: number }
interface BurstState { lines: ReflowLine[] | null; band: BandSnapshot; origCols: number; newCols: number; n: number | null }
/** A resolved burst prediction: N plus the lines it was computed from. */
export interface ReflowPrediction {
  n: number;
  lines: readonly ReflowLine[];
  oldCols: number;
  newCols: number;
  /** Band rows at snapshot time; absent = pre-centering callers (no margin check). */
  band?: BandSnapshot;
}

const frameRecords = new WeakMap<object, FrameRecord>();
const reflowBursts = new WeakMap<object, BurstState>();

/** Record the frame just rendered (called by repaint after logUpdate.render). */
export function recordRenderedFrame(self: object, text: string, bottom: number, cols: number): void {
  frameRecords.set(self, { text, bottom, cols });
}

/** Painted display width tmux sees for a band row (blank rows paint nothing). */
function paintedWidth(raw: string, marginCols: number): number {
  return raw === '' ? 0 : marginCols + displayWidth(stripAnsi(raw));
}

function paintedBandRows(self: Pick<SnapshotHost, 'committedBand' | 'committedBandPaintedRows'>): string[] {
  const painted = Math.max(0, Math.min(self.committedBandPaintedRows, self.committedBand.length));
  return self.committedBand.slice(self.committedBand.length - painted);
}

/** Lines owned by the compositor between the floor and the cursor, or null if unknown. */
function snapshotLines(self: SnapshotHost): ReflowLine[] | null {
  const lines: ReflowLine[] = [];
  const painted = Math.max(0, Math.min(self.committedBandPaintedRows, self.committedBand.length));
  if (painted > 0) {
    const bottom = self.committedBandBottomRow;
    if (bottom <= 0 || self.committedBandTopRow !== bottom - painted + 1) return null;
    const marginCols = compositorBand({ columns: self.lastKnownCols }).marginCols;
    const rows = self.committedBand.slice(self.committedBand.length - painted);
    rows.forEach((raw, i) => {
      lines.push({ row: bottom - painted + 1 + i, width: paintedWidth(raw, marginCols), hard: true });
    });
  }
  const frame = frameRecords.get(self);
  if (!frame || frame.cols !== self.lastKnownCols || frame.bottom !== self.lastMeasuredFrameBottom) return null;
  const physical = hardWrapToWidth(frame.text.endsWith('\n') ? frame.text : `${frame.text}\n`, frame.cols).split('\n');
  while (physical.length > 0 && physical[physical.length - 1] === '') physical.pop();
  physical.forEach((text, i) => {
    const w = displayWidth(stripAnsi(text));
    // tmux grid_reflow: a line whose width equals the terminal width is
    // grid_reflow_move'd unchanged (GRID_LINE_WRAPPED is NOT set), so it is
    // treated as hard during reflow — ceil(w/newCols) fragments, never joined
    // with the next line. hardWrapToWidth also inserts an explicit '\n' at
    // every wrap boundary, so a full-width row is always a separate physical
    // row, never in the DECAWM deferred-wrap state. Mark it hard.
    lines.push({ row: frame.bottom - physical.length + 1 + i, width: w, hard: w <= frame.cols });
  });
  // The cursor is parked at column 1 of the frame's bottom row, so that row's
  // own rewrap fragments land BELOW the cursor and never move rows above it.
  const floor = Math.max(1, self.anchorRow ?? 1);
  return lines.filter((l) => l.row >= floor && l.row < self.lastMeasuredFrameBottom);
}

/**
 * Called from handleResizeImmediate on every SIGWINCH that will be resolved by
 * a CPR (`freshBurst` = no CPR in flight yet). Seeds a snapshot on the first
 * narrowing event of a burst, then recomputes the cumulative N against the
 * burst's ORIGINAL width. History: summing per-step increments over-counts —
 * tmux rejoins its own reflow fragments before rewrapping, so 230→160→115
 * yields ceil(229/115)-1 = 1 extra row, not 1 + 1. A row-shrinking step in
 * the burst makes the prediction unknown (tmux also trims/pushes rows).
 */
export function noteResizeForReflow(self: SnapshotHost, newCols: number, freshBurst: boolean, rowShrink = false): void {
  if (freshBurst) reflowBursts.delete(self);
  if (!reflowGateOn()) return;
  let state = reflowBursts.get(self);
  if (!state) {
    if (!(newCols < self.lastKnownCols) || rowShrink) return;
    const band = { rows: paintedBandRows(self), marginCols: compositorBand({ columns: self.lastKnownCols }).marginCols };
    state = { lines: snapshotLines(self), band, origCols: self.lastKnownCols, newCols, n: 0 };
    reflowBursts.set(self, state);
  }
  state.newCols = newCols;
  state.n = state.lines === null || rowShrink ? null : computeReflowShift(state.lines, state.origCols, newCols);
  if (rowShrink) state.lines = null;
}

/** Consume the burst's prediction (null when none/unknown/N=0). Always clears state. */
export function takeReflowPrediction(self: object): ReflowPrediction | null {
  const state = reflowBursts.get(self);
  reflowBursts.delete(self);
  if (!state || state.n === null || state.n <= 0 || state.lines === null) return null;
  return { n: state.n, lines: state.lines, oldCols: state.origCols, newCols: state.newCols, band: state.band };
}

/**
 * Physical band rows (after re-wrapping at the new width) that tmux pushed
 * into history. Every snapshot line sits at or below the band top, so the
 * band's first rewrapped fragment lands at `bandTop + delta - n`; each
 * fragment above row 1 is already in history. `bandTop` is pre-resize.
 */
export function historyRows(bandTop: number, delta: number, n: number): number {
  return bandTop > 0 ? Math.max(0, 1 - (bandTop + delta - n)) : 0;
}

/**
 * Invariant (margin-inclusive eviction): with AFK_CENTER_CONTENT active the
 * model wraps band rows at the content width (margin excluded) while tmux
 * rewraps the margin-INCLUSIVE painted row, so the model's fragments do not
 * match tmux's and must not be used to count history rows. This counts the
 * `hist` tmux fragments pushed into history in tmux's own units — each OLD
 * painted row splits into max(1, ceil(min(w, oldCols) / newCols)) — and
 * returns how many WHOLE leading rows are entirely in history. Returns null
 * when a row straddles the history boundary (its visible remainder cannot be
 * represented without re-deriving tmux's split) or the band changed since the
 * snapshot; the caller then falls back to the pre-shift behaviour.
 */
export function wholeRowsInHistory(
  rows: readonly string[],
  marginCols: number,
  oldCols: number,
  newCols: number,
  hist: number,
): number | null {
  if (newCols <= 0 || oldCols <= 0) return null;
  let cum = 0;
  let k = 0;
  for (; k < rows.length && cum < hist; k++) {
    const w = Math.min(paintedWidth(rows[k] ?? '', marginCols), oldCols);
    const frags = Math.max(1, Math.ceil(w / newCols));
    if (cum + frags > hist) return null;
    cum += frags;
  }
  return k;
}

function sameRows(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((r, i) => r === b[i]);
}

/** Drop `evict` leading painted rows (and the unpainted prefix); false if pending rows would be lost. */
function evictPaintedRows(self: ReflowHost, evict: number): boolean {
  if (evict <= 0) return true;
  const painted = Math.max(0, Math.min(self.committedBandPaintedRows, self.committedBand.length));
  const unpainted = self.committedBand.length - painted;
  if (unpainted > self.committedBandArchivedPrefix) return false;
  const removed = unpainted + evict;
  self.committedBand = self.committedBand.slice(removed);
  self.committedBandMeta = self.committedBandMeta.slice(removed);
  self.committedBandPaintedRows = painted - evict;
  self.committedBandArchivedPrefix = Math.max(0, self.committedBandArchivedPrefix - removed);
  self.bandReflowCache = null;
  return true;
}

/**
 * Rows to evict when centering is active at either width (see
 * {@link wholeRowsInHistory}); null = fall back (no shift, no eviction). The
 * band is NOT re-wrapped here: the next repaint reflows the survivors.
 *
 * Returns null (and falls back to pre-#4114 behaviour) when either:
 *   - `pred.band` is absent (pre-centering caller path), or
 *   - `sameRows` fails, meaning a `commitAbove` landed between the resize
 *     snapshot and the CPR-driven apply. In that burst the duplicate echo may
 *     briefly show in scrollback, but no committed content is lost — this is
 *     intentional and safe.
 */
function centeredEvictCount(self: ReflowHost, pred: ReflowPrediction, hist: number): number | null {
  if (hist <= 0) return 0;
  const band = pred.band;
  if (!band || !sameRows(paintedBandRows(self), band.rows)) return null;
  return wholeRowsInHistory(band.rows, band.marginCols, pred.oldCols, pred.newCols, hist);
}

/**
 * Apply the predicted shift (-N) to the rows above the cursor after a
 * narrowing reflow. Runs AFTER applyScrollDelta(delta), so the net shift is
 * delta - N; `preBandTop` is the band top before that delta. The band is first
 * re-wrapped at the new width (band-reflow splits the padded echo row exactly
 * as tmux does: ceil(w / cols) fragments), then the fragments tmux pushed into
 * history are dropped from the model: never erased, never repainted. Returns
 * false (no shift applied) when that would drop non-archived pending rows.
 */
export function applyReflowShift(self: ReflowHost, pred: ReflowPrediction, delta: number, preBandTop: number): boolean {
  if (pred.n <= 0) return false;
  if (self.committedBandPaintedRows > 0) {
    const newBand = compositorBand(self.stdout);
    const hist = historyRows(preBandTop, delta, pred.n);
    if ((pred.band?.marginCols ?? 0) > 0 || newBand.marginCols > 0) {
      const evict = centeredEvictCount(self, pred, hist);
      if (evict === null || !evictPaintedRows(self, evict)) return false;
    } else {
      // Centering off: band width === cols, so the model's re-wrapped
      // fragments are exactly tmux's and can be evicted fragment-wise.
      reflowCommittedBandToWidth(self, newBand.width);
      const painted = Math.max(0, Math.min(self.committedBandPaintedRows, self.committedBand.length));
      if (!evictPaintedRows(self, Math.min(painted, hist))) return false;
    }
  }
  const move = (r: number): number => (r > 0 ? Math.max(1, r - pred.n) : r);
  if (self.anchorRow !== undefined && self.anchorRow > 0) self.anchorRow = move(self.anchorRow);
  // Band positions are re-derived statelessly by the next repaint; zeroing
  // them forces repositionCommittedBand to repaint (moved === true).
  self.committedBandTopRow = 0;
  self.committedBandBottomRow = 0;
  if (self.pendingResizeErase) {
    // Top moves up with the content so the stray rows above the old floor are
    // erased; bottom stays so the full pre-resize footprint is still covered.
    self.pendingResizeErase = { ...self.pendingResizeErase, top: move(self.pendingResizeErase.top) };
  }
  return true;
}
