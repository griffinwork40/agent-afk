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
    const grew = self.hasCommitted && prevTopRow > 1 && desiredTopRow < prevTopRow;
    const bandLen = self.committedBand.length;
    if (!grew || bandLen === 0) return;
    const room = Math.max(0, desiredTopRow - 1);
    const overflow = bandLen - room;
    if (overflow <= 0) return; // whole band fits above the new frame — no scroll
    // Re-paint the full band top-aligned at [1, bandLen], erasing its old
    // floating position, so the scroll carries the oldest `overflow` lines —
    // real content, never blank rows — into scrollback. The frame render that
    // follows repaints its own (lower) footprint; survivors sit above it.
    let out = '';
    for (let r = Math.max(1, self.committedBandTopRow); r <= self.committedBandBottomRow; r++) {
      out += `\x1b[${r};1H\x1b[2K`;
    }
    for (let i = 0; i < bandLen; i++) {
      out += `\x1b[${1 + i};1H\x1b[2K${self.committedBand[i] ?? ''}`;
    }
    try {
      self.stdout.write(out);
    } catch {
      /* terminal closed mid-render — next render's lifecycle tears us down */
    }
    evictRowsToScrollback(self, overflow);
    // Survivors physically shifted to [1, room] by the scroll — already
    // hugging the new frame top (room === desiredTopRow - 1). Record that so a
    // later shrink re-pins from the right place.
    self.committedBand = self.committedBand.slice(overflow);
    self.committedBandTopRow = 1;
    self.committedBandBottomRow = room;
    return;
  }

  // Banner present (anchorRow > 1): legacy deficit-based eviction, unchanged.
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
