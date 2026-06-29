/**
 * Row-preservation / scrollback-eviction primitives for the frame compositor.
 * Extracted from terminal-compositor.frame.ts to keep each module < 350 LOC.
 * Both functions were module-private in frame.ts; they are exported here so
 * frame.ts (which calls `preserveRowsBeforeFrameRender`) can import them.
 *
 * `import type` for FrameHost keeps this a TYPE-ONLY dependency on frame.ts
 * so there is no runtime circular import between the two siblings.
 */

import type { FrameHost } from './terminal-compositor.frame.js';
import { eraseAndPaintRow } from './terminal-compositor.types.js';

/**
 * Preserve rows that the next compositor frame is about to cover.
 *
 * Shared by normal input repaints and picker repaints: both ultimately use
 * the same log-update renderer, and both can grow upward into the single
 * above-frame copy written by `commitAbove()`. Keeping the eviction in one
 * pre-render path prevents picker mode from bypassing commit durability.
 */
export function preserveRowsBeforeFrameRender(self: FrameHost, desiredTopRow: number): void {
  // Evict-on-growth (durability for single-copy commits): when the frame
  // grows upward — its top climbs above the previously-rendered frame top —
  // the rows it is about to CUP-paint over hold committed transcript content
  // (commitAbove's above-frame band). Get that content into terminal
  // scrollback BEFORE the frame render overwrites it.
  const prevTopRow = self.logUpdate?.topRow ?? 0;
  const hasBanner = self.anchorRow !== undefined && self.anchorRow > 1;

  // History: the common case (no pre-arm banner, floor === 1). The old path
  // scrolled the FULL frame-growth deficit (prevTopRow - desiredTopRow) into
  // scrollback on every upward growth. When the band hugged the frame with
  // blank rows above it (a small band under a growing tall overlay — e.g. a
  // "thought for Xs" line committed while a tall thinking preview is up), it
  // was those BLANK rows that scrolled into scrollback — opening the "massive
  // gap" between committed clusters in scrollback. Worse: the band's content
  // was only ever a CUP re-paint, so the cap dropped lines believing they had
  // scrolled to scrollback when only blanks had — lost commits.
  //
  // Fix: on growth the band moves up into the blank space it already had above
  // it (no scrollback write at all when the whole band still fits). Only the
  // OLDEST lines that overflow the new above-frame room [1, desiredTopRow-1]
  // are scrolled into scrollback, carried as REAL content (the full band is
  // re-painted top-aligned first so the scroll evicts band rows, never
  // blanks). Because room === desiredTopRow - 1 here, the survivors land at
  // [1, desiredTopRow-1] — already hugging the new frame top AND contiguous
  // with scrollback, so no gap opens. Full design: docs/scrollback.md.
  if (!hasBanner) {
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
    // Trigger (gated on the genuine end-of-turn signal — DELIBERATELY not a
    // room-magnitude threshold nor a shrink-direction heuristic):
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
    const hasPending = self.committedBandPaintedRows < bandLen;
    const overlayCollapsed = self.overlay.trim().length === 0;
    if (
      !self.commitInFlight &&
      hasPending &&
      bandLen > room &&
      overlayCollapsed &&
      room > 0
    ) {
      const overflow = bandLen - room;
      let out = '';
      // Erase the old painted position (only the materialized suffix).
      for (let r = Math.max(1, self.committedBandTopRow); r <= self.committedBandBottomRow; r++) {
        out += eraseAndPaintRow(r);
      }
      // Paint the FULL model top-aligned at [1, bandLen] so the scroll evicts
      // real rows — including previously-pending ones never on screen before.
      for (let i = 0; i < bandLen; i++) {
        out += eraseAndPaintRow(1 + i, self.committedBand[i]);
      }
      try {
        self.stdout.write(out);
      } catch {
        /* terminal closed mid-render — next render's lifecycle tears us down */
      }
      evictRowsToScrollback(self, overflow);
      // Survivors physically shifted to [1, room] by the scroll.
      self.committedBand = self.committedBand.slice(overflow);
      self.committedBandTopRow = 1;
      self.committedBandBottomRow = room;
      self.committedBandPaintedRows = self.committedBand.length;
      return;
    }

    const grew = self.hasCommitted && prevTopRow > 1 && desiredTopRow < prevTopRow;
    if (!grew || bandLen === 0) return;
    const growRoom = Math.max(0, desiredTopRow - 1);
    const growOverflow = bandLen - growRoom;
    if (growOverflow <= 0) return; // whole band fits above the new frame — no scroll
    // Re-paint the full band top-aligned at [1, bandLen], erasing its old
    // floating position, so the scroll carries the oldest `overflow` lines —
    // real content, never blank rows — into scrollback. The frame render that
    // follows repaints its own (lower) footprint; survivors sit above it.
    let out = '';
    for (let r = Math.max(1, self.committedBandTopRow); r <= self.committedBandBottomRow; r++) {
      out += eraseAndPaintRow(r);
    }
    for (let i = 0; i < bandLen; i++) {
      out += eraseAndPaintRow(1 + i, self.committedBand[i]);
    }
    try {
      self.stdout.write(out);
    } catch {
      /* terminal closed mid-render — next render's lifecycle tears us down */
    }
    evictRowsToScrollback(self, growOverflow);
    // Survivors physically shifted to [1, growRoom] by the scroll — already
    // hugging the new frame top (growRoom === desiredTopRow - 1). Record that so a
    // later shrink re-pins from the right place.
    self.committedBand = self.committedBand.slice(growOverflow);
    self.committedBandTopRow = 1;
    self.committedBandBottomRow = growRoom;
    // The full band was re-painted top-aligned above before the scroll, so
    // every surviving row is materialized on screen (and the evicted prefix is
    // now in scrollback) — none are pending. Promote any previously-pending
    // rows that this growth just materialized.
    self.committedBandPaintedRows = self.committedBand.length;
    return;
  }

  // Invariant (banner-path pending-overflow eviction — collapse-time, before
  // legacy deficit eviction):
  // A partially-pending band (0 < committedBandPaintedRows < committedBand.length)
  // can coexist with anchorRow > 1 when the commit overlay was tall enough to
  // make prevTopRow ≤ 1 (BLOCKER-1: fitsAboveFrame = false, useBandHold = true)
  // but short enough that desiredTopRow > anchorRow at Phase-2 repaint time —
  // so anchorRow was NOT reduced and hasBanner remains true post-commit.
  // Concretely: maxRun = newTopRow - anchorFloor < bandLen when the overlay's
  // desiredTopRow leaves only a narrow above-banner strip, making Phase-3 paint
  // only the bottom `maxRun` rows while the older `bandLen - maxRun` rows stay
  // pending. On overlay collapse, desiredTopRow rises and the settled maxFit
  // (= desiredTopRow - anchorFloor) can still be < bandLen if the collapsed
  // frame has > 1 row (e.g. spinner still active). repositionCommittedBand then
  // silently drops the oldest bandLen - maxFit pending rows (never painted, never
  // archived) — content loss. The fully-pending case is handled by the !hasBanner
  // path's anchor-eviction (newTopRow ≤ 1 → desiredTopRow ≤ 1 < anchorRow →
  // anchorDeficit > 0 → anchorRow → 1 during Phase-2); only the PARTIALLY-
  // pending case can reach here with anchorRow > 1.
  //
  // Trigger (same signal as the !hasBanner eviction, anchored at floor):
  //   • overlayCollapsed (overlay is '' — turn has ended, frame at settled height)
  //   • hasPending (some model rows never painted)
  //   • bandLen > room (= desiredTopRow - floor) — band won't all fit above frame
  //   • !commitInFlight && room > 0 (not mid-commit; room exists above frame)
  //
  // Action (mirrors !hasBanner path, lines 96-119, with floor = anchorFloor):
  // Paint the full model top-aligned at [floor, floor+bandLen-1], evict the
  // oldest `overflow = bandLen - room` rows to scrollback so the subsequent
  // deficit path sees correct tracked rows and repositionCommittedBand never
  // drops unpainted content.
  const bandLenBanner = self.committedBand.length;
  const floorBanner = Math.max(self.anchorRow ?? 1, 1);
  const roomBanner = Math.max(0, desiredTopRow - floorBanner);
  const hasPendingBanner = self.committedBandPaintedRows < bandLenBanner;
  const overlayCollapsedBanner = self.overlay.trim().length === 0;
  if (
    !self.commitInFlight &&
    hasPendingBanner &&
    bandLenBanner > roomBanner &&
    overlayCollapsedBanner &&
    roomBanner > 0
  ) {
    const overflow = bandLenBanner - roomBanner;
    let out = '';
    // Erase the old painted position (only the materialized suffix).
    for (let r = Math.max(floorBanner, self.committedBandTopRow); r <= self.committedBandBottomRow; r++) {
      out += eraseAndPaintRow(r);
    }
    // Paint the FULL model top-aligned at [floor, floor+bandLen-1] so the
    // scroll evicts real rows — including previously-pending ones never on
    // screen before. External constraint (DECSTBM paint-before-scroll): CUP
    // writes precede the \n scroll so the evicted rows hold real content.
    for (let i = 0; i < bandLenBanner; i++) {
      out += eraseAndPaintRow(floorBanner + i, self.committedBand[i]);
    }
    try {
      self.stdout.write(out);
    } catch {
      /* terminal closed mid-render — next render's lifecycle tears us down */
    }
    evictRowsToScrollback(self, overflow);
    // Survivors physically shifted to [floor, floor+room-1] by the scroll.
    self.committedBand = self.committedBand.slice(overflow);
    self.committedBandTopRow = floorBanner;
    self.committedBandBottomRow = floorBanner + roomBanner - 1;
    self.committedBandPaintedRows = self.committedBand.length;
    return;
  }

  // Legacy deficit-based eviction (unchanged).
  const growthDeficit = (self.hasCommitted && prevTopRow > 1) ? Math.max(0, prevTopRow - desiredTopRow) : 0;
  // Anchor-row enforcement (legacy ceiling): never let the frame top climb
  // above a supplied pre-arm ceiling (welcome banner / update notice)
  // without first preserving the rows down to it.
  const anchorDeficit =
    desiredTopRow < self.anchorRow! ? self.anchorRow! - desiredTopRow : 0;
  const deficit = Math.max(growthDeficit, anchorDeficit);
  if (deficit > 0) {
    evictRowsToScrollback(self, deficit);
    // Everything (including pre-arm content) scrolled up by `deficit`, so the
    // safe ceiling moves up the same amount. Clamp at 1; once the banner has
    // fully scrolled into scrollback there is nothing left to protect.
    if (self.anchorRow !== undefined && self.anchorRow > 1) {
      self.anchorRow = Math.max(1, self.anchorRow - deficit);
    }
    // The committed band scrolled up by the same `deficit` (a small growth —
    // e.g. the spinner appearing — does NOT push it off-screen; it stays in
    // the viewport, one row higher). Shift its tracked rows so a later shrink
    // re-pins at the right screen position. Drop only the lines that crossed
    // ABOVE the anchor floor into terminal scrollback, so the re-pin never
    // paints scrolled-away content back into the viewport (which would
    // duplicate what the terminal already holds in scrollback).
    if (self.committedBand.length > 0) {
      self.committedBandTopRow -= deficit;
      self.committedBandBottomRow -= deficit;
      const floor = Math.max(self.anchorRow ?? 1, 1);
      if (self.committedBandTopRow < floor) {
        const lost = floor - self.committedBandTopRow;
        self.committedBand = self.committedBand.slice(lost);
        self.committedBandTopRow = floor;
      }
      if (self.committedBand.length === 0 || self.committedBandBottomRow < floor) {
        self.clearCommittedBand();
      } else {
        // Survivors were scrolled by the terminal as real on-screen rows.
        // The collapse-time pending-overflow eviction above (lines 158-227)
        // handles partially-pending bands before this deficit path runs, so
        // any survivors reaching here are fully materialized — none pending.
        self.committedBandPaintedRows = self.committedBand.length;
      }
    }
  }
}

/**
 * Push `rows` rows of viewport content into the terminal's scrollback
 * buffer by emitting `\n` writes at the bottom row of the active DECSTBM
 * region. Each `\n` at the bottom margin triggers a one-row scroll-up;
 * the top row of the scroll region is preserved in scrollback (terminal-
 * native). When a {@link CompositorScrollRegionGuard} (typically the
 * StatusLine) is wired, the eviction runs inside `withFullScrollRegion`
 * so the scroll happens against the full screen height rather than the
 * status-line's reserved sub-region — matching the contract `commitAbove`
 * already follows for the same reason.
 *
 * No-op when `rows <= 0`. Best-effort on stdout write failure (terminal
 * may have closed between repaint() and this call).
 */
export function evictRowsToScrollback(self: FrameHost, rows: number): void {
  if (rows <= 0) return;
  self.debugLog('evict:enter', { rows, anchorRow: self.anchorRow ?? null });
  // Invariant (DECSTBM scroll trigger): a `\n` scrolls the region only when
  // the cursor sits AT the bottom margin. Under withFullScrollRegion (and the
  // no-scrollRegion default) that margin is the physical last row
  // (this.stdout.rows). CUP there — NOT to targetBottomRow (rows-1-extraRows),
  // which sits one-or-more rows ABOVE the margin, so the first `\n`(s) would
  // merely move the cursor down without scrolling, yielding fewer than `rows`
  // scrolls and letting the growing frame overwrite the committed content
  // this eviction exists to preserve (review #592 BLOCKER-2). Safe even with a
  // status line: withFullScrollRegion forces the full-screen region and
  // repaints the status row afterward.
  const physicalBottom = Math.max(1, self.stdout.rows ?? 24);
  const escape = `\x1b[${physicalBottom};1H${'\n'.repeat(rows)}`;
  const doWrite = (): void => {
    try {
      self.stdout.write(escape);
    } catch (err) {
      self.debugLog('evict:error', { msg: (err as Error)?.message ?? String(err) });
      // Stdout may be closed mid-render (process exit, terminal hangup);
      // the next render() call will fail too and the surface lifecycle
      // will tear us down — nothing more we can do here.
    }
  };
  if (self.scrollRegion !== undefined) {
    self.scrollRegion.withFullScrollRegion(doWrite);
  } else {
    doWrite();
  }
}
