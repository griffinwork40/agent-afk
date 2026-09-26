/**
 * Committed-band resize + repin — `flushResizeGhostErase` and
 * `repositionCommittedBand` — split from terminal-compositor.committed-band.ts
 * to stay within the <350 LOC per-file budget. Follows the same
 * free-functions-on-host pattern; takes {@link CommittedBandHost} by reference.
 */

import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';
import { eraseAndPaintRow } from './terminal-compositor.scrollback.js';
import { withAutowrapDisabled } from './terminal-compositor.band-reflow.js';
import { contentMargin } from './render/measure.js';

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
  // The ghost-erase range [top, bottom] may overlap the band's tracked rows.
  // If so, the on-screen content is gone and the tracking pointers are stale.
  // Reset them to 0 so repositionCommittedBand detects `moved = true` and
  // repaints the band at its new position, rather than treating the erased
  // rows as still-valid and skipping the repaint.
  // Invariant: use interval-intersection (any overlap triggers reset), not
  // full containment — a partial erase that clips only part of the band still
  // invalidates the tracked pointers.
  if (
    self.committedBand.length > 0 &&
    self.committedBandBottomRow > 0 &&
    self.committedBandTopRow <= bottom &&
    self.committedBandBottomRow >= top
  ) {
    self.committedBandTopRow = 0;
    self.committedBandBottomRow = 0;
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
 * frame — the flicker guard). When the render's erase pass covered the band
 * (the collapse render, whose stale-tall previousTopRow erases down through the
 * band) it repaints.
 *
 * Stage 2 (#540 — render, don't re-pin): when it DOES repaint, the visible
 * window is re-rendered STATELESSLY — the above-frame content region is cleared
 * from the anchor floor and the band's bottom `fit` rows are repainted at
 * [newTop, targetBottom], so the on-screen result is a pure function of
 * (committedBand, floor, targetBottom) and never depends on the tracked
 * `committedBandTopRow` for the erase range. That dissolves the scrollback-gap
 * "void" class by construction (a stranded row above a drifted tracked top is
 * always erased) instead of relying on incremental band-adjacency bookkeeping.
 * The committedBand* fields are still MAINTAINED here for the commit / eviction
 * paths that read them (see #540). Stage 3 (logical-line flush) and the
 * frame-preserve-archive erase bound have been retired; the remaining
 * coupling lives in the commit path's floor derivation and contiguity checks.
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
  // computes. The paint is always above the frame top, so it never overwrites
  // the live frame.
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
  // Invariant (bottom-aligned band): the band is pinned at
  // [targetBottom - fit + 1, targetBottom] so committed content hugs the frame
  // top — the user's most recent output sits immediately above the input line
  // with no visual gap. Any blank rows (when the band is shorter than the
  // available room) sit ABOVE the band, between scrollback and the committed
  // text.
  //
  // Short-terminal blank-gap cap (#2182): on short or wide terminals after an
  // overlay collapse, `maxFit` (the available above-frame room) can be much
  // larger than `fit` (the band's actual length). Without a cap the blank rows
  // are all visible — on a 20-row terminal a 3-line band can leave 13 blank
  // rows at the top of the viewport with content crammed at the bottom.
  //
  // Fix: clamp the number of blank rows above the band to MAX_BLANK_ROWS
  // (≈ one-third of the terminal height). When the cap kicks in the band is
  // "top-aligned within its allowance" — painted starting at
  // `floor + MAX_BLANK_ROWS` — and the gap rows between the band bottom and the
  // frame top are explicitly erased so no ghost content lingers there.
  //
  // Tracking invariant: committedBandBottomRow is kept at `targetBottom`
  // (desiredTopRow − 1) even when the blank-gap cap shifts the visual band
  // above it. Commit-path contiguity checks (`committedBandBottomRow ===
  // frameTop − 1`) and the commit-geometry tests depend on this equality to
  // detect a band that is adjacent to the frame and can be merged with the
  // next commit. committedBandTopRow is set to `paintTop` (the clamped paint
  // start) — which equals `newTop` when no capping occurs — so that:
  //   • endTurnFlush can locate the real painted rows for its erase pass by
  //     reading committedBandTopRow directly (updated to use committedBandTopRow
  //     instead of committedBandBottomRow − paintedCount + 1 in lifecycle
  //     teardown), avoiding the single-copy violation that would arise if it
  //     erased only the uncapped rows at [newTop, targetBottom].
  //   • The stable-repaint `moved` check is idempotent: both paintTop and
  //     targetBottom are the same on every tick while geometry is stable, so
  //     the check returns false and the above-frame region is not re-erased.
  const totalRows = Math.max(1, self.stdout.rows ?? 24);
  const MAX_BLANK_ROWS = Math.ceil(totalRows / 3);
  const newTop = targetBottom - fit + 1;
  const paintTop = newTop < floor + MAX_BLANK_ROWS ? newTop : floor + MAX_BLANK_ROWS;
  const moved = paintTop !== self.committedBandTopRow || targetBottom !== self.committedBandBottomRow;
  // The render's erase pass clears [preRenderFrameTop, …]; if it started at or
  // above the band's current bottom it wiped the band → must repaint.
  const renderErasedBand = preRenderFrameTop > 0 && preRenderFrameTop <= self.committedBandBottomRow;
  if (!moved && !renderErasedBand) return;
  const paint = self.committedBand.slice(self.committedBand.length - fit);
  // Content centering (AFK_CENTER_CONTENT): derive the margin from the CURRENT
  // terminal width so the band adapts on resize. The band stores raw (unpadded)
  // content; padding is a rendering concern applied here at paint time.
  const pad = contentMargin();
  // Cursor stays hidden (the frame render hid it); CUP writes emit no '\n', so
  // the DECSTBM scroll region is never triggered — no writeWithGuard needed.
  let out = '\x1b[?25l';
  // Stage 2 (#540 — render, don't re-pin): erase the ENTIRE above-frame content
  // region [floor, paintTop) from the anchor floor, NOT from the tracked band top
  // (`committedBandTopRow`). The painted window below is a pure function of
  // (committedBand, floor, targetBottom); clearing from the floor makes the
  // whole render stateless — any row stranded above a STALE tracked top (the
  // scrollback-gap "void": rows a prior eager-scroll/eviction left painted while
  // the tracked top drifted below them) is erased unconditionally, so it is
  // gap-free by construction rather than by trusting the incremental
  // `committedBandTopRow` adjacency. The banner/anchor above `floor` is never
  // touched. When fit === maxFit the band fills all available room, so
  // paintTop === floor and this loop is a no-op — paint below starts immediately.
  for (let r = floor; r < paintTop; r++) {
    out += eraseAndPaintRow(r);
  }
  for (let i = 0; i < paint.length; i++) {
    const line = pad && paint[i] !== '' ? pad + paint[i] : paint[i];
    out += eraseAndPaintRow(paintTop + i, line);
  }
  // Gap erase (#2182): when the blank-gap cap shifted the band up from newTop
  // to paintTop, rows [paintTop + fit, targetBottom] lie between the band
  // bottom and the frame top. Erase them so no ghost content (old overlay
  // rows, prior band content at a higher `newTop`) lingers in the gap. The
  // Stage-2 stateless-render invariant already erases [floor, paintTop)
  // above the band; this companion loop covers the symmetric gap below it.
  // No-op when paintTop === newTop (no capping), since paintTop + fit − 1 ===
  // targetBottom and the loop body has zero iterations.
  for (let r = paintTop + fit; r <= targetBottom; r++) {
    out += eraseAndPaintRow(r);
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
  self.committedBandTopRow = paintTop;
  self.committedBandBottomRow = targetBottom;
  // `fit` rows (the band's bottom suffix) are now materialized on screen — this
  // is the collapse repaint that drains a fully-pending band-hold model. Record
  // it so a subsequent disarm() does not re-flush already-painted rows into
  // scrollback (which would duplicate them).
  self.committedBandPaintedRows = fit;
}
