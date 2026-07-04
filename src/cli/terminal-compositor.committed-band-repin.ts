/**
 * Committed-band resize + repin — `flushResizeGhostErase` and
 * `repositionCommittedBand` — split from terminal-compositor.committed-band.ts
 * to stay within the <350 LOC per-file budget. Follows the same
 * free-functions-on-host pattern; takes {@link CommittedBandHost} by reference.
 */

import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';
import { eraseAndPaintRow } from './terminal-compositor.types.js';
import { withAutowrapDisabled } from './terminal-compositor.band-reflow.js';

/**
 * Physically erase the pre-resize on-screen footprint snapshotted by the
 * SIGWINCH immediate handler (old live-frame + committed-band rows). Without
 * this, an EXPAND leaves those rows frozen as ghosts above the freshly
 * painted frame: resetGeometry() makes the next render's erase pass a no-op,
 * and the preserved band only repaints at its NEW position — neither touches
 * the old absolute rows. Consumes `pendingResizeErase` exactly once (cleared
 * before the write so a throwing stdout can't strand a permanent erase).
 * No-op when nothing is pending. Best-effort write — the terminal may have
 * closed mid-resize, in which case the next render's lifecycle tears us down.
 */
export function flushResizeGhostErase(self: CommittedBandHost): void {
  const pending = self.pendingResizeErase;
  if (!pending) return;
  self.pendingResizeErase = null;
  // Clamp to the current viewport: the post-resize row count is authoritative
  // and a stale `bottom` beyond it would address rows the terminal no longer
  // exposes.
  const maxRow = Math.max(1, self.stdout.rows ?? 24);
  const top = Math.max(1, pending.top);
  const bottom = Math.min(pending.bottom, maxRow);
  if (top > bottom) return;
  // No cursor-hide needed: this only runs inside repaint() after at least one
  // prior render() (which hides the cursor and never shows it until disarm),
  // so the cursor is already hidden. CUP+EL emit no '\n', so the DECSTBM
  // scroll region is never triggered.
  let out = '';
  for (let r = top; r <= bottom; r++) {
    out += eraseAndPaintRow(r);
  }
  try {
    self.stdout.write(out);
  } catch {
    /* terminal closed mid-resize — next render's lifecycle tears us down */
  }
}

/**
 * Re-pin the most-recent above-frame committed block (see {@link committedBand})
 * so its bottom line stays immediately above the live frame top after a repaint.
 *
 * Fires only when the frame stayed put or SHRANK (its top moved DOWN to
 * `desiredTopRow`): on growth, evict-on-growth has already scrolled the block
 * into scrollback and cleared the band, so there is nothing to re-pin and we
 * must never paint band rows into a frame that grew upward over them.
 *
 * Idempotent: when the block has not moved AND the just-completed frame render
 * did not erase its rows, this is a no-op (no per-tick churn on a stable
 * frame). When the render's erase pass covered the band (the collapse render,
 * whose stale-tall previousTopRow erases down through the band) it repaints.
 *
 * @param desiredTopRow      the frame's true target top (pre-padding) this repaint
 * @param preRenderFrameTop  CupFrameRenderer.topRow captured BEFORE render() —
 *                           the first row its erase pass cleared
 * @param targetBottomRow    the frame's bottom row, where the cursor is re-parked
 */
export function repositionCommittedBand(
  self: CommittedBandHost,
  desiredTopRow: number,
  preRenderFrameTop: number,
  targetBottomRow: number,
): void {
  if (self.commitInFlight || !self.logUpdate) return;
  const floor = Math.max(self.anchorRow ?? 1, 1);
  const targetBottom = desiredTopRow - 1;
  if (self.committedBand.length === 0) {
    // F2: an empty band has nothing for a stale committedBandBottomRow to
    // corrupt (commitAbove's floor-usage already requires
    // `committedBandBottomRow > 0` alongside a non-empty band), so this
    // repaint cycle's geometry is safe to trust again.
    self.bandGeometryStale = false;
    return;
  }
  // On upward growth (targetBottom < committedBandBottomRow) the band must be
  // re-pinned above the NEW frame top: preserveRowsBeforeFrameRender either
  // left the whole band in place (it fits) or already scrolled the overflow
  // into scrollback and recorded the survivors — in both cases the survivors
  // belong at [targetBottom - fit + 1, targetBottom], which the fit math below
  // computes. (Banner case keeps the legacy scroll-and-shift, which lands the
  // band at targetBottom too.) The paint is always above the frame top, so it
  // never overwrites the live frame.
  if (targetBottom < floor) return; // F2: band exists but has NO room above the
  // current floor — do NOT clear bandGeometryStale here: committedBandBottomRow
  // is left at its old (possibly stale) value below, so a later commit must
  // keep distrusting it as a floor until a repaint actually re-establishes it.
  // F2: past this point `targetBottom`/`floor` are fresh values derived from
  // THIS repaint's real desiredTopRow/anchorRow, so whatever `fit` computes
  // (a real re-pin below, or "already correct, nothing moved") reflects
  // CURRENT geometry — safe to trust committedBandBottomRow again from here.
  self.bandGeometryStale = false;
  const maxFit = targetBottom - floor + 1;
  const fit = Math.min(self.committedBand.length, maxFit);
  if (fit <= 0) return;
  const newTop = targetBottom - fit + 1;
  const moved = newTop !== self.committedBandTopRow || targetBottom !== self.committedBandBottomRow;
  // The render's erase pass clears [preRenderFrameTop, …]; if it started at or
  // above the band's current bottom it wiped the band → must repaint.
  const renderErasedBand = preRenderFrameTop > 0 && preRenderFrameTop <= self.committedBandBottomRow;
  if (!moved && !renderErasedBand) return;
  const paint = self.committedBand.slice(self.committedBand.length - fit);
  // Cursor stays hidden (the frame render hid it); CUP writes emit no '\n', so
  // the DECSTBM scroll region is never triggered — no writeWithGuard needed.
  let out = '\x1b[?25l';
  // Erase rows the block vacated when it slid DOWN (the former gap), down to —
  // but not including — its new top.
  for (let r = Math.max(floor, self.committedBandTopRow); r < newTop; r++) {
    out += eraseAndPaintRow(r);
  }
  for (let i = 0; i < paint.length; i++) {
    out += eraseAndPaintRow(newTop + i, paint[i]);
  }
  // Re-park the cursor where CupFrameRenderer.render() left it (the frame's
  // bottom content row) so the band write does not displace it.
  out += `\x1b[${Math.max(1, targetBottomRow)};1H`;
  // Belt-and-braces (see withAutowrapDisabled doc): F1's reflow already
  // guarantees `paint`'s rows fit the CURRENT width by construction, but a
  // ±1-column displayWidth() disagreement with the real terminal on an
  // ambiguous-width glyph could still let one row overrun by a cell. With
  // DECAWM off that can only clip the row, never spawn a phantom row that
  // desyncs `committedBandTopRow`/`committedBandBottomRow` from the screen.
  withAutowrapDisabled(self.stdout, () => {
    try {
      self.stdout.write(out);
    } catch {
      /* terminal closed mid-repaint — next render's lifecycle tears us down */
    }
  });
  self.committedBandTopRow = newTop;
  self.committedBandBottomRow = targetBottom;
  // `fit` rows (the band's bottom suffix) are now materialized on screen — this
  // is the collapse repaint that drains a fully-pending band-hold model. Record
  // it so a subsequent disarm() does not re-flush already-painted rows into
  // scrollback (which would duplicate them).
  self.committedBandPaintedRows = fit;
}
