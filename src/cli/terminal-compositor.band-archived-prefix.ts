/**
 * Archived-prefix bookkeeping for the committed band (content-hug only).
 *
 * Invariant: archived prefix: `committedBandArchivedPrefix` counts the
 * LEADING rows of `committedBand` that are already in native scrollback. They
 * stay in the band model so a large collapse can refill the screen. The shared
 * hiddenArchivedRows plan (archived-reveal.ts) keeps them hidden on small shrinks
 * when the bottom gap is <= max(3, floor(rows/8)). Reveal latches until the next
 * archive, commit, or resize; threshold oscillation cannot hide them again.
 * Initial small shrinks may progress to a large collapse and reveal once. They must never
 * reach scrollback a second time. Hence two rules every scrollback-writing site
 * follows:
 *   1. A logical-line archive (scrollbackFlushLines + buildScrollbackArchiveEscape)
 *      skips the archived prefix: {@link flushLinesSkippingArchived}.
 *   2. A raw scroll (`\n` at the bottom margin) pushes whatever is on the top
 *      screen rows into history, so before it runs, any painted archived rows
 *      that would leave the top are dropped from the model and the remaining
 *      band is repainted shifted up: {@link dropScrollingArchivedRows}.
 * Range: 0 <= prefix <= committedBand.length; always 0 in bottom-pinned mode;
 * reset with the band (clear/forget); decremented by n whenever a band prefix
 * of n rows is removed. Bounded by {@link capArchivedPrefix}.
 *
 * Accepted trade-off: only after a large collapse re-shows archived rows, tmux
 * copy-mode shows them twice at the seam (bottom of history, top of screen).
 * They are never written to scrollback twice. Full account: docs/scrollback.md
 * "Fixed: blank gap below prompt after tall overlay collapses (content-hug)".
 */

import type { BandRowMeta, FramePlacementMode } from './terminal-compositor.types.js';
import { eraseAndPaintRow, scrollbackFlushLines } from './terminal-compositor.scrollback.js';
import { withAutowrapDisabled } from './terminal-compositor.band-reflow.js';
import { contentMargin } from './render/measure.js';

/** State slice the archived-prefix helpers read and mutate. */
export interface ArchivedPrefixHost {
  committedBand: string[];
  committedBandMeta: BandRowMeta[];
  committedBandTopRow: number;
  committedBandBottomRow: number;
  committedBandPaintedRows: number;
  committedBandArchivedPrefix: number;
  placementMode: FramePlacementMode;
  readonly stdout: NodeJS.WriteStream;
}

/** Whether covered band rows are archived-and-retained (content-hug) rather
 *  than archived-and-sliced (bottom-pinned, unchanged). */
export function retainArchivedOnCover(self: Pick<ArchivedPrefixHost, 'placementMode'>): boolean {
  return self.placementMode === 'content-hug';
}

/** The archived prefix clamped to the current band length (defensive). */
export function archivedPrefix(self: Pick<ArchivedPrefixHost, 'committedBand' | 'committedBandArchivedPrefix'>): number {
  return Math.max(0, Math.min(self.committedBandArchivedPrefix, self.committedBand.length));
}

/**
 * Pending rows that are NOT already in scrollback. The pending-eviction trigger
 * counts only these, so already-archived (hidden) rows never re-trigger an
 * archive (which would loop, or drop them).
 */
export function nonArchivedPendingRows(
  self: Pick<ArchivedPrefixHost, 'committedBand' | 'committedBandPaintedRows' | 'committedBandArchivedPrefix'>,
): number {
  const pending = self.committedBand.length - self.committedBandPaintedRows;
  return Math.max(0, pending - archivedPrefix(self));
}

/**
 * Logical lines to write to scrollback for the first `count` rows of a band
 * whose first `prefix` rows are already in scrollback: the archived rows are
 * skipped (never written twice). Slicing at the prefix boundary is safe for the
 * #540 meta: a slice that starts on a continuation row is emitted verbatim by
 * scrollbackFlushLines, and the straddle rule still sees the rows past `count`.
 */
export function flushLinesSkippingArchived(
  rows: readonly string[],
  meta: readonly BandRowMeta[] | undefined,
  count: number,
  prefix: number,
): string[] {
  const p = Math.max(0, Math.min(prefix, count, rows.length));
  if (p === 0) return scrollbackFlushLines(rows, meta, count);
  return scrollbackFlushLines(rows.slice(p), meta?.slice(p), count - p);
}

/**
 * The archived prefix after a commit replaces the band with
 * `merged ? [...band, ...new].slice(dropped) : new`: the prior band's prefix
 * survives only when it was merged, minus the `dropped` leading rows (which
 * the commit archived or capped away; archived-prefix rows among them were
 * skipped by the archive, never written twice). Read BEFORE the band is replaced.
 */
export function retainedArchivedPrefix(
  self: Pick<ArchivedPrefixHost, 'committedBand' | 'committedBandArchivedPrefix'>,
  merged: boolean,
  dropped: number,
): number {
  if (!merged) return 0;
  return Math.max(0, archivedPrefix(self) - Math.max(0, dropped));
}

/**
 * Bound the retained archived prefix at `cap` rows by silently dropping the
 * oldest ones (no write: they are already in scrollback). Only UNPAINTED rows
 * are dropped, so nothing that is on screen becomes untracked.
 */
export function capArchivedPrefix(self: Omit<ArchivedPrefixHost, 'placementMode' | 'stdout'>, cap: number): void {
  const prefix = archivedPrefix(self);
  const unpainted = self.committedBand.length - self.committedBandPaintedRows;
  const drop = Math.min(Math.max(0, prefix - Math.max(0, cap)), Math.max(0, unpainted));
  if (drop <= 0) return;
  self.committedBand = self.committedBand.slice(drop);
  self.committedBandMeta = self.committedBandMeta.slice(drop);
  self.committedBandArchivedPrefix = prefix - drop;
}

/**
 * Before a raw scroll of `scrollRows` rows (screen rows [1, scrollRows] leave
 * the top into history), remove every painted archived row that would leave,
 * so it is never written to scrollback a second time. Returns `d`, the number
 * of painted rows removed; the caller must scroll `scrollRows - d` instead.
 * Pass `Infinity` to remove every painted archived row (disarm).
 *
 * Mechanism: drop the archived rows (all unpainted ones plus the `d` painted
 * ones, keeping model order contiguous) and statelessly repaint the remaining
 * painted rows shifted UP by `d`, erasing the `d` rows freed at the bottom.
 * After a scroll of `scrollRows - d` every surviving row lands exactly where
 * the original `scrollRows` scroll would have put it. Tracked positions stay in
 * the caller's pre-scroll coordinates: BottomRow is unchanged and TopRow moves
 * down by `d` (the first remaining row's as-if pre-scroll row), so a caller
 * that then subtracts its full `scrollRows` lands both on the real rows.
 *
 * Invariant (drop-by-repaint BEFORE any scroll): the repaint must be written
 * before the caller's `\n` scroll. Scrolling first would carry the archived
 * rows into history again (the duplicate this exists to prevent), and a
 * repaint after the scroll would address rows that have already moved.
 */
export function dropScrollingArchivedRows(self: Omit<ArchivedPrefixHost, 'placementMode'>, scrollRows: number): number {
  const prefix = archivedPrefix(self);
  if (prefix === 0 || scrollRows <= 0) return 0;
  const bandLen = self.committedBand.length;
  const painted = Math.max(0, Math.min(self.committedBandPaintedRows, bandLen));
  const unpainted = bandLen - painted;
  const paintedArchived = Math.max(0, Math.min(painted, prefix - unpainted));
  if (paintedArchived === 0) return 0;
  const bottom = self.committedBandBottomRow;
  const top = self.committedBandTopRow > 0 ? self.committedBandTopRow : bottom - painted + 1;
  if (bottom <= 0 || top <= 0) return 0; // position unknown: cannot repaint safely
  const lastLeaving = Math.min(top + paintedArchived - 1, scrollRows);
  const d = Math.max(0, Math.min(paintedArchived, lastLeaving - top + 1));
  if (d === 0) return 0;

  const removed = unpainted + d;
  self.committedBand = self.committedBand.slice(removed);
  self.committedBandMeta = self.committedBandMeta.slice(removed);
  self.committedBandPaintedRows = painted - d;
  self.committedBandArchivedPrefix = prefix - removed;
  self.committedBandTopRow = top + d;

  const remaining = self.committedBand.slice(self.committedBand.length - self.committedBandPaintedRows);
  const pad = contentMargin();
  let out = '';
  for (let i = 0; i < remaining.length; i++) {
    const raw = remaining[i] ?? '';
    out += eraseAndPaintRow(top + i, pad && raw !== '' ? pad + raw : raw);
  }
  for (let r = top + remaining.length; r < top + painted; r++) out += eraseAndPaintRow(r);
  withAutowrapDisabled(self.stdout, () => {
    try {
      self.stdout.write(out);
    } catch {
      /* terminal closed mid-repaint — lifecycle tears us down on next render */
    }
  });
  return d;
}
