/**
 * Row-preservation / scrollback-eviction primitives for the frame compositor.
 * Extracted from terminal-compositor.frame.ts to keep each module < 350 LOC.
 * Both functions were module-private in frame.ts; they are exported here so
 * frame.ts (which calls `preserveRowsBeforeFrameRender`) can import them.
 *
 * `import type` for FrameHost keeps this a TYPE-ONLY dependency on frame.ts
 * so there is no runtime circular import between the two siblings.
 *
 * #540 axis-2 (logical-line scrollback flush) — RESOLVED. All three sites that
 * push committed content into native scrollback now emit SOFT-WRAPPABLE logical
 * lines, so scrolled-off content reflows cleanly when the width changes: the
 * band-hold archive (committed-band-commit.ts), disarm's
 * flushPendingCommittedBand (lifecycle.ts), and the three eviction paths in
 * `preserveRowsBeforeFrameRender` below — which delegate the archive to
 * `archiveBandPrefixAndRepaintSurvivors`
 * (terminal-compositor.frame-preserve-archive.ts, where the ordering constraint
 * and geometry contract are documented).
 *
 * History: these paths emitted pre-wrapped PHYSICAL rows until 2026-07-29, and
 * one earlier attempt to convert them regressed the verdict-card border because
 * the old mechanism's single paint did two jobs at once. Full account in the
 * header of terminal-compositor.frame-preserve-archive.ts. Guards:
 * `verdict-card-overflow.test.ts` and the PTY scenario
 * `width-resize-fragment-evict-growth`.
 *
 * The legacy deficit-based eviction at the end of the function still calls
 * `evictRowsToScrollback` directly and is deliberately unchanged: it scrolls
 * whatever is already on screen (including pre-arm banner rows) rather than
 * archiving band content, so it has no logical lines to emit.
 */

import type { FrameHost } from './terminal-compositor.frame.js';
import { dropScrollingArchivedRows } from './terminal-compositor.band-archived-prefix.js';
import {
  evictNoBannerPath,
  evictBannerPendingOverflow,
} from './terminal-compositor.frame-preserve.evict.js';

/**
 * Preserve rows that the next compositor frame is about to cover.
 *
 * Shared by normal input repaints and picker repaints: both ultimately use
 * the same log-update renderer, and both can grow upward into the single
 * above-frame copy written by `commitAbove()`. Keeping the eviction in one
 * pre-render path prevents picker mode from bypassing commit durability.
 *
 * The no-banner path (`!hasBanner`, floor === 1) is handled by
 * `evictNoBannerPath`; the banner pending-overflow path by
 * `evictBannerPendingOverflow`. Both live in
 * terminal-compositor.frame-preserve.evict.ts. The legacy deficit tail runs
 * inline below (it scrolls pre-arm banner rows, not band content, and has no
 * logical lines to emit).
 */
export function preserveRowsBeforeFrameRender(self: FrameHost, desiredTopRow: number): void {
  // Evict-on-growth (durability for single-copy commits): when the frame
  // grows upward — its top climbs above the previously-rendered frame top —
  // the rows it is about to CUP-paint over hold committed transcript content
  // (commitAbove's above-frame band). Get that content into terminal
  // scrollback BEFORE the frame render overwrites it.
  const prevTopRow = self.logUpdate?.topRow ?? 0;
  const hasBanner = self.anchorRow !== undefined && self.anchorRow > 1;

  if (!hasBanner) {
    evictNoBannerPath(self, desiredTopRow, prevTopRow);
    return;
  }

  if (evictBannerPendingOverflow(self, desiredTopRow)) return;

  // Legacy deficit-based eviction.
  //
  // Burst-safety gate (#3212): while `resizeGeometryStale` is set, both
  // `prevTopRow` (= logUpdate.topRow, reset to 0 by resetGeometry on SIGWINCH)
  // and `anchorRow` (shifted by applyScrollDelta mid-burst) may not reflect
  // the actual screen layout.  The reported symptom — every failing burst shows
  // `evict:enter` with anchorRow between CPR cycles — traces to `anchorDeficit`
  // firing on a stale anchor coordinate: applyScrollDelta shifts anchorRow UP
  // after a SHRINK step, and the next CPR-resolved repaint sees
  // desiredTopRow < anchorRow (stale), producing a non-zero anchorDeficit that
  // scrolls committed rows into native scrollback.  On the following GROW tmux
  // pulls those rows back as frozen ghost duplicates.
  //
  // `resizeGeometryStale` is set ONLY by the SIGWINCH handler, not by
  // resumeInput() — so legitimate suspend/resume anchor evictions are not
  // blocked.  The eviction deferred here retries on the next steady-state
  // repaint once repositionCommittedBand clears resizeGeometryStale.
  //
  // Terminal-protocol ordering constraint (DECSTBM): CUP writes must precede
  // the \n scroll so evicted rows carry real content.  Deferring eviction when
  // geometry is stale ensures the \n never fires against wrong absolute rows.
  if (self.resizeGeometryStale) return;
  const growthDeficit = (self.hasCommitted && prevTopRow > 1) ? Math.max(0, prevTopRow - desiredTopRow) : 0;
  // Anchor-row enforcement (legacy ceiling): never let the frame top climb
  // above a supplied pre-arm ceiling (welcome banner / update notice)
  // without first preserving the rows down to it.
  const anchorDeficit =
    desiredTopRow < self.anchorRow! ? self.anchorRow! - desiredTopRow : 0;
  const deficit = Math.max(growthDeficit, anchorDeficit);
  if (deficit > 0) scrollBannerDeficit(self, deficit);
}

/**
 * Banner path: scroll `deficit` rows (everything, including pre-arm content,
 * moves up) and shift the anchor floor and the tracked committed band to match.
 * Extracted from preserveRowsBeforeFrameRender (one whole step, explicit params).
 */
function scrollBannerDeficit(self: FrameHost, deficit: number): void {
  // Archived-prefix rows painted at the top must not scroll into history a
  // second time: drop them by repaint BEFORE the scroll (band-archived-prefix.ts),
  // then scroll only the rest. Survivor positions match the full scroll's.
  const droppedArchived = dropScrollingArchivedRows(self, deficit);
  evictRowsToScrollback(self, deficit - droppedArchived);
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
    self.committedBandTopRow -= deficit; // as-if coordinates (dropScrollingArchivedRows)
    self.committedBandBottomRow -= deficit;
    const floor = Math.max(self.anchorRow ?? 1, 1);
    if (self.committedBandTopRow < floor) {
      const lost = floor - self.committedBandTopRow;
      self.committedBand = self.committedBand.slice(lost);
      self.committedBandMeta = self.committedBandMeta.slice(lost); // #540: keep 1:1
      self.committedBandArchivedPrefix = Math.max(0, self.committedBandArchivedPrefix - lost);
      self.committedBandTopRow = floor;
    }
    if (self.committedBand.length === 0 || self.committedBandBottomRow < floor) {
      self.clearCommittedBand();
    } else {
      // Survivors were scrolled by the terminal as real on-screen rows.
      // The collapse-time pending-overflow eviction above (in evictNoBannerPath /
      // evictBannerPendingOverflow) handles partially-pending bands before this
      // deficit path runs, so any survivors reaching here are fully
      // materialized — none pending.
      self.committedBandPaintedRows = self.committedBand.length;
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
