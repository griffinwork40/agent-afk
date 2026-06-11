/**
 * Committed-band resize + repin — `flushResizeGhostErase` and
 * `repositionCommittedBand` — split from terminal-compositor.committed-band.ts
 * to stay within the <350 LOC per-file budget. Follows the same
 * free-functions-on-host pattern; takes {@link CommittedBandHost} by reference.
 */

import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';

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
    out += `\x1b[${r};1H\x1b[2K`;
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
  // Promote covered content the moment the frame shrinks enough to show it. A
  // full-viewport frame (newTopRow ≤ 1) parked the most-recent block in
  // coveredBand (commitAbove) instead of dropping it; re-pin it now adjacent to
  // the new frame top so the collapse shows it hugging the frame rather than a
  // run of shrink-pad blank rows (the "massive blank gap"). While the frame
  // still fills the viewport (targetBottom < floor) this is a no-op and the
  // block stays parked. The block is already in scrollback (Phase 1 archive), so
  // the only cost of the re-pin is an off-screen scrollback copy (no-gap default).
  if (self.committedBand.length === 0 && self.coveredBand.length > 0 && targetBottom >= floor) {
    self.committedBand = self.coveredBand;
    self.coveredBand = [];
    // Treat the promoted band as having occupied the just-erased covered frame
    // footprint so renderErasedBand fires and it paints at the position the fit
    // math computes below (committedBandTopRow = 1 also makes `moved` true).
    self.committedBandTopRow = 1;
    self.committedBandBottomRow = Math.max(1, preRenderFrameTop, targetBottom);
  }
  if (self.committedBand.length === 0) return;
  // On upward growth (targetBottom < committedBandBottomRow) the band must be
  // re-pinned above the NEW frame top: preserveRowsBeforeFrameRender either
  // left the whole band in place (it fits) or already scrolled the overflow
  // into scrollback and recorded the survivors — in both cases the survivors
  // belong at [targetBottom - fit + 1, targetBottom], which the fit math below
  // computes. (Banner case keeps the legacy scroll-and-shift, which lands the
  // band at targetBottom too.) The paint is always above the frame top, so it
  // never overwrites the live frame.
  if (targetBottom < floor) return;
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
    out += `\x1b[${r};1H\x1b[2K`;
  }
  for (let i = 0; i < paint.length; i++) {
    out += `\x1b[${newTop + i};1H\x1b[2K${paint[i] ?? ''}`;
  }
  // Re-park the cursor where CupFrameRenderer.render() left it (the frame's
  // bottom content row) so the band write does not displace it.
  out += `\x1b[${Math.max(1, targetBottomRow)};1H`;
  try {
    self.stdout.write(out);
  } catch {
    /* terminal closed mid-repaint — next render's lifecycle tears us down */
  }
  self.committedBandTopRow = newTop;
  self.committedBandBottomRow = targetBottom;
}
