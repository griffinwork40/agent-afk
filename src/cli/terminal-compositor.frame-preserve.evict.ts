/**
 * Eviction helpers for preserveRowsBeforeFrameRender, split from
 * terminal-compositor.frame-preserve.ts to keep each sibling < 350 LOC.
 * Both helpers take explicit parameters — no closures over enclosing locals.
 *
 * `pendingEvictionAllowed` is re-exported here so frame-preserve.ts imports
 * it from a single location; it has no module-scope singleton state.
 */

import type { FrameHost } from './terminal-compositor.frame.js';
import { archiveBandPrefixAndRepaintSurvivors } from './terminal-compositor.frame-preserve-archive.js';
import { contentHugFrameSettled } from './terminal-compositor.content-hug.js';
import {
  archivedPrefix,
  nonArchivedPendingRows,
} from './terminal-compositor.band-archived-prefix.js';

/**
 * Whether pending band rows may be archived on this repaint. Content-hug: as
 * soon as the frame is settled. Bottom-pinned: only once the overlay is empty
 * too (the end-of-turn signal).
 *
 * Invariant (no history hole under content-hug, 2026-10-02): in content-hug
 * mode (the REPL) the trigger is NOT gated on the overlay being empty. A
 * pending row is on neither the screen nor in scrollback, so holding it for the
 * rest of a turn opens a visible hole at the scrollback/viewport seam (operator
 * report: a verdict card's bottom border, the next prompt echo and a tool
 * header vanished from tmux history until the turn ended). Archiving early is
 * safe there because content-hug puts unused rows BELOW the prompt, and the
 * archived rows stay in the band as the archived prefix (hidden, re-shown when
 * the frame shrinks, never archived twice; band-archived-prefix.ts), so the
 * screen still refills after the collapse. The same rule makes content-hug
 * archive covered rows on frame GROWTH as well as hiding them. Bottom-pinned
 * keeps the overlay-empty gate: archiving early there
 * leaves blank rows ABOVE the band that later scroll into history as a
 * permanent gap (collapse-void.test.ts). Either mode still holds rows while a
 * dropdown/picker is open (contentHugFrameSettled), since that growth is brief
 * and user-initiated. Repro: terminal-compositor.history-hole.repro.test.ts.
 */
export function pendingEvictionAllowed(self: FrameHost, frameSettled: boolean): boolean {
  if (!frameSettled) return false;
  return self.placementMode === 'content-hug' || self.overlay.trim().length === 0;
}

/**
 * No-banner eviction path: handles both collapse-time pending-overflow eviction
 * and evict-on-growth. floor === 1 (no pre-arm banner). Takes explicit params
 * (self, desiredTopRow, prevTopRow) — named helper, not a closure.
 *
 * History: the common case (no pre-arm banner, floor === 1). The old path
 * scrolled the FULL frame-growth deficit (prevTopRow - desiredTopRow) into
 * scrollback on every upward growth. When the band hugged the frame with
 * blank rows above it (a small band under a growing tall overlay — e.g. a
 * "thought for Xs" line committed while a tall thinking preview is up), it
 * was those BLANK rows that scrolled into scrollback — opening the "massive
 * gap" between committed clusters in scrollback. Worse: the band's content
 * was only ever a CUP re-paint, so the cap dropped lines believing they had
 * scrolled to scrollback when only blanks had — lost commits.
 *
 * Fix: on growth the band moves up into the blank space it already had above
 * it (no scrollback write at all when the whole band still fits). Only the
 * OLDEST lines that overflow the new above-frame room [1, desiredTopRow-1]
 * are scrolled into scrollback, carried as REAL content (the full band is
 * re-painted top-aligned first so the scroll evicts band rows, never
 * blanks). Because room === desiredTopRow - 1 here, the survivors land at
 * [1, desiredTopRow-1] — already hugging the new frame top AND contiguous
 * with scrollback, so no gap opens. Full design: docs/scrollback.md.
 *
 * Returns true to signal the caller should return (path fully handled).
 */
export function evictNoBannerPath(self: FrameHost, desiredTopRow: number, prevTopRow: number): boolean {
  const bandLen = self.committedBand.length;

  // Invariant (collapse-time eviction of pending overflow — content-loss fix):
  // band-hold's commit-time `maxBandModel` can exceed the true collapse paint
  // capacity `maxFit` (= `targetBottom - floor + 1` in repositionCommittedBand)
  // because `maxFit` accounts for the REAL collapsed frame height (input + gap +
  // spinner + status rows) while `maxBandModel` counts against a 1-row estimate.
  // When maxBandModel > maxFit, repositionCommittedBand paints only `fit` rows
  // and the oldest `excess = bandLen - fit` PENDING rows are neither painted nor
  // archived — SILENT CONTENT LOSS. This branch runs BEFORE render(), owns
  // evictRowsToScrollback, and is the correct place to resolve it.
  //
  // Trigger (pendingEvictionAllowed; content-hug needs only a settled frame).
  // Bottom-pinned, DELIBERATELY not a room/shrink-direction heuristic:
  //   • the OVERLAY is empty (self.overlay.trim() === '') — i.e. the turn
  //     ended and the live frame is now at its settled (idle) height, so
  //     `room` is the REAL above-frame capacity. This is the only reliable
  //     "has the overlay actually collapsed?" signal: a mid-turn minor shrink
  //     (e.g. the spinner stopping while a TALL overlay is still held) leaves
  //     the overlay non-empty, so we do NOT fire and the pending band is kept
  //     intact for the real collapse — never prematurely archiving rows that
  //     should stay visible (overflow-gap.test.ts "archives the genuine
  //     overflow ... R10 visible"). AND
  //   • pending rows exist (committedBandPaintedRows < bandLen), AND
  //   • the band overflows the room above the settled frame (room =
  //     desiredTopRow - 1, anchorFloor === 1 here), AND
  //   • room > 0 AND !commitInFlight (Phase 2 repaint runs mid-commit;
  //     Phase 3 rewrites the band itself).
  // Because `room` is the TRUE above-frame room for whatever the collapsed
  // frame height turns out to be (input + gap + spinner + status, ANY height),
  // the eviction count (bandLen - room) is exactly the overflow that cannot be
  // shown — correct for every footer/input geometry, not just a 1–2 row frame.
  //
  // Action: paint the FULL model top-aligned (erasing old position) so the
  // subsequent eviction scrolls REAL rows — never blanks — into scrollback.
  // Then evict the oldest `overflow = bandLen - room` rows. Survivors remain
  // at [1, room] hugging the forthcoming frame top, all materialized.
  const room = Math.max(0, desiredTopRow - 1);
  // Content-hug archive-and-retain: rows already in scrollback (the archived
  // prefix, always 0 in bottom-pinned) never count as pending or as overflow,
  // so they cannot re-trigger an archive. `overflow` below stays an absolute
  // band index (> skip whenever this fires).
  const skip = archivedPrefix(self);
  const hasPending = nonArchivedPendingRows(self) > 0;
  const frameSettled = contentHugFrameSettled(self);
  if (
    !self.commitInFlight &&
    hasPending &&
    bandLen - skip > room &&
    pendingEvictionAllowed(self, frameSettled) &&
    room > 0
  ) {
    const overflow = bandLen - room;
    // #540 axis-2: archive the pending-overflow prefix to scrollback as
    // SOFT-WRAPPABLE logical lines, then re-place the survivors at [1, room].
    // `!hasBanner` ⇒ anchorFloor === 1 per the branch invariant above. The
    // helper erases from the geometric FLOOR (row 1) rather than reading the
    // tracked `committedBandTopRow`, retiring that adjacency-coupling read per
    // the Stage-2-core repin change (#552, committed-band-repin.ts); the
    // tracked `bottom` read is also retired — the erase bound is now derived
    // from `floor + bandLen` (geometry-only). The helper owns the
    // erase → archive → repaint ordering constraint and all band bookkeeping;
    // see terminal-compositor.frame-preserve-archive.ts.
    archiveBandPrefixAndRepaintSurvivors(self, overflow, 1);
    return true;
  }

  const grew = self.hasCommitted && prevTopRow > 1 && desiredTopRow < prevTopRow;
  if (!grew || bandLen === 0 || !frameSettled) return true; // content-hug archives on growth too (no-history-hole)
  // Burst-safety gate (#3212): while `resizeGeometryStale` is set, absolute
  // row coordinates (prevTopRow = logUpdate.topRow) reflect the pre-resize
  // layout. A CPR-resolved repaint that fires mid-burst sees the old renderer
  // top as `prevTopRow` and the fresh `desiredTopRow`; their difference looks
  // like upward growth even though no net grow has occurred yet (the burst is
  // still in flight). Evicting committed rows to scrollback on stale geometry
  // causes tmux to pull them back as a frozen duplicate on the next GROW step.
  //
  // `resizeGeometryStale` is set ONLY by the SIGWINCH immediate handler (not
  // by resumeInput, which sets `bandGeometryStale` for legitimate suspend
  // purposes). It is cleared by repositionCommittedBand once a full repaint
  // establishes fresh geometry — deferred to the next steady-state repaint
  // where coordinates are reliable, identical to `commit-geometry.ts` line 108.
  //
  // Terminal-protocol ordering constraint (DECSTBM): CUP writes must precede
  // the \n scroll so evicted rows carry real content. Deferring eviction when
  // geometry is stale ensures the scroll never fires against wrong absolute rows.
  if (self.resizeGeometryStale) return true;
  const growRoom = Math.max(0, desiredTopRow - 1);
  const growOverflow = bandLen - growRoom;
  if (growOverflow <= skip) return true; // every non-archived row fits above the new frame — no scroll
  // Advisory note (#2871.4): this early return does not update committedBandTopRow /
  // committedBandBottomRow to reflect the frame's new position. The positions
  // therefore drift whenever the frame grows but all non-archived rows still fit.
  // There is no visible effect today — re-pin happens at the next repaint that
  // actually moves the band — but if a future path reads the tracked positions
  // between this return and the next repaint it would see stale coordinates.
  // A position update here is not safe without a repaint (the band is still on
  // screen at the old rows), so the correct fix is to note the stale state rather
  // than update it prematurely.
  // #540 axis-2: archive the oldest `growOverflow` rows to scrollback as
  // SOFT-WRAPPABLE logical lines, then re-place the survivors at
  // [1, growRoom] — already hugging the new frame top (growRoom ===
  // desiredTopRow - 1), so a later shrink re-pins from the right place.
  // `!hasBanner` ⇒ anchorFloor === 1. The helper owns the erase → archive →
  // repaint ordering constraint and all band bookkeeping; see
  // terminal-compositor.frame-preserve-archive.ts. This is the site the
  // reported width-resize fragmentation came through (the ordinary
  // end-of-turn → next-turn growth), pinned by the PTY guard
  // `width-resize-fragment-evict-growth`.
  archiveBandPrefixAndRepaintSurvivors(self, growOverflow, 1);
  return true;
}

/**
 * Banner-path pending-overflow eviction: runs when anchorRow > 1 and a
 * partially-pending band overflows the above-banner strip. Takes explicit
 * params (self, desiredTopRow) — named helper, not a closure.
 *
 * Invariant (banner-path pending-overflow eviction — collapse-time, before
 * legacy deficit eviction):
 * A partially-pending band (0 < committedBandPaintedRows < committedBand.length)
 * can coexist with anchorRow > 1 when the commit overlay was tall enough to
 * make prevTopRow ≤ 1 (BLOCKER-1: fitsAboveFrame = false, useBandHold = true)
 * but short enough that desiredTopRow > anchorRow at Phase-2 repaint time —
 * so anchorRow was NOT reduced and hasBanner remains true post-commit.
 * Concretely: maxRun = newTopRow - anchorFloor < bandLen when the overlay's
 * desiredTopRow leaves only a narrow above-banner strip, making Phase-3 paint
 * only the bottom `maxRun` rows while the older `bandLen - maxRun` rows stay
 * pending. On overlay collapse, desiredTopRow rises and the settled maxFit
 * (= desiredTopRow - anchorFloor) can still be < bandLen if the collapsed
 * frame has > 1 row (e.g. spinner still active). repositionCommittedBand then
 * silently drops the oldest bandLen - maxFit pending rows (never painted, never
 * archived) — content loss. The fully-pending case is handled by the !hasBanner
 * path's anchor-eviction (newTopRow ≤ 1 → desiredTopRow ≤ 1 < anchorRow →
 * anchorDeficit > 0 → anchorRow → 1 during Phase-2); only the PARTIALLY-
 * pending case can reach here with anchorRow > 1.
 *
 * Trigger (same signal as the !hasBanner eviction, anchored at floor):
 *   • overlayCollapsed && contentHugFrameSettled (content-hug: also no open dropdown)
 *   • hasPending (some model rows never painted)
 *   • bandLen > room (= desiredTopRow - floor) — band won't all fit above frame
 *   • !commitInFlight && room > 0 (not mid-commit; room exists above frame)
 *
 * Action (mirrors !hasBanner path with floor = anchorFloor):
 * Paint the full model top-aligned at [floor, floor+bandLen-1], evict the
 * oldest `overflow = bandLen - room` rows to scrollback so the subsequent
 * deficit path sees correct tracked rows and repositionCommittedBand never
 * drops unpainted content.
 *
 * Returns true if it handled the eviction (caller should return immediately).
 */
export function evictBannerPendingOverflow(self: FrameHost, desiredTopRow: number): boolean {
  const bandLenBanner = self.committedBand.length;
  const floorBanner = Math.max(self.anchorRow ?? 1, 1);
  const roomBanner = Math.max(0, desiredTopRow - floorBanner);
  const skipBanner = archivedPrefix(self);
  const hasPendingBanner = nonArchivedPendingRows(self) > 0;
  const overlayCollapsedBanner = pendingEvictionAllowed(self, contentHugFrameSettled(self));
  if (
    !self.commitInFlight &&
    hasPendingBanner &&
    bandLenBanner - skipBanner > roomBanner &&
    overlayCollapsedBanner &&
    roomBanner > 0
  ) {
    const overflow = bandLenBanner - roomBanner;
    // #540 axis-2: archive the pending-overflow prefix to scrollback as
    // SOFT-WRAPPABLE logical lines, then re-place the survivors at
    // [floorBanner, floorBanner + roomBanner - 1]. The banner/anchor rows ABOVE
    // `floorBanner` are never touched — the helper's erase starts AT the floor.
    // It owns the erase → archive → repaint ordering constraint (DECSTBM
    // paint-before-scroll: CUP writes precede the \n scroll so evicted rows hold
    // real content) and all band bookkeeping; see
    // terminal-compositor.frame-preserve-archive.ts.
    archiveBandPrefixAndRepaintSurvivors(self, overflow, floorBanner);
    return true;
  }
  return false;
}
