import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';

export interface CommitGeometry {
  rows: number;
  cols: number;
  extraRows: number;
  prevTopRow: number;
  frameTop: number;
  anchorFloor: number;
  fitsAboveFrame: boolean;
  phase1EffectiveFrameTop: number;
}

/**
 * Snapshot all terminal-geometry values needed for a single commit in one
 * place so that Phase 1 and Phase 3 always operate on the SAME row numbers —
 * the "atomic geometry snapshot" invariant.
 *
 * `rows` and `cols` are passed in (already read by the orchestrator) so
 * that stdout is never re-queried inside the geometry computation.
 */
export function snapshotCommitGeometry(
  self: CommittedBandHost,
  contentLineCount: number,
  rows: number,
  cols: number,
): CommitGeometry {
  const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
  // Invariant (one geometry per commit): the room/scroll/band math below must
  // measure the frame at the position Phase 2's repaint will ACTUALLY use.
  // Frame placement now runs in a SINGLE regime — the input frame is always
  // bottom-anchored (terminal-compositor.frame.ts: targetBottomRow ===
  // absoluteBottom), idle and during a commit alike — so the idle frame's
  // prevTopRow captured below already reflects exactly where Phase 2 will
  // re-render it. No regime-sync clear/repaint is needed before capturing it.
  //
  // History: a "content-following" regime used to banner-follow the idle frame
  // up to ~anchorRow while the band was empty. Capturing prevTopRow from that
  // regime reported zero above-frame room and misrouted the FIRST commit into
  // the overflow path (Phase 1 archived the block on-screen at anchorFloor as
  // an untracked orphan, Phase 3 painted a second copy, the next commit's merge
  // a third — the first-turn "echo first line duplicated + card body lost"
  // bug). The guard for it was a pre-commit `clear()+repaint()` that flipped
  // into the bottom-anchored regime first. Unconditional bottom-pinning removed
  // the content-following regime entirely, so that guard is obsolete and gone.
  // Decide where the committed text is written so it lands in scrollback
  // EXACTLY ONCE. Capture the live frame's top row BEFORE clear() resets it:
  // every frame mutation (setOverlay, setSpinner, keypress) repaints
  // synchronously, so `topRow` reflects the frame Phase 2's repaint will
  // reproduce. `capacity` is the number of rows available to DISPLAY committed
  // text above the frame, between the pre-arm content ceiling (anchorRow) and
  // the frame top.
  //
  // External constraint (pre-repaint vs post-repaint geometry ordering):
  // CupFrameRenderer.render() applies shrink-padding when the frame shrinks
  // between renders — it prepends blank rows so the erase pass covers the full
  // prior footprint. The padded newTopRow is stored as logUpdate.topRow, making
  // it LOWER than the raw content top that measure(currentFrame, bottom).topRow
  // would return and that Phase-2 repaint() will actually establish (Phase-1
  // clear() resets previousLineCount=0, so Phase-2 render() never applies shrink
  // padding and always lands the frame at its real raw position).
  //
  // When the committed band exists and was repositioned by
  // repositionCommittedBand during the preceding setOverlay()+repaint() call,
  // committedBandBottomRow is adjacent to the real frame top (= real_top - 1).
  // Use that as a floor to correct the stale padded value: the real frame top
  // can never be LOWER than committedBandBottomRow + 1 (the band must be above
  // the frame). Without this correction a stale low prevTopRow causes
  // decideCommitMode to compute wrong fitsAboveFrame and overflowPriorContiguous,
  // routing the commit to band-hold when the fits path was correct — and the
  // band-hold paint then overwrites the repositioned prior-band content without
  // archiving it to scrollback, permanently losing it (zero hits on the prior
  // committed block after collapse).
  //
  // F2 (fail-safe commit mode on stale geometry): the correction above assumes
  // `committedBandBottomRow` was set by a repositionCommittedBand call that ran
  // against the CURRENT screen geometry. `bandGeometryStale` — set by the
  // SIGWINCH-immediate handler alongside logUpdate.resetGeometry(), cleared by
  // repositionCommittedBand once it re-pins against the new geometry — is false
  // exactly when that assumption fails: a resize landed and no repaint has run
  // since, so `committedBandBottomRow` is a PRE-resize row number. Using it as
  // a floor here would reproduce that stale-but-nonzero row, defeat the
  // `prevTopRow <= 1` band-hold safety fallback below (BLOCKER-1), and route
  // decideCommitMode into the merge-then-cap fits path against geometry that no
  // longer describes the screen — silently truncating the prior band as
  // "already scrolled" rows that never scrolled (DEFECT 2, confirmed by
  // terminal-compositor.resize-stale-width.repro.test.ts's H2 case). Skipping
  // the floor while stale falls through to `rawLogUpdateTopRow` (0, since
  // resetGeometry() zeroed it), which takes the `frameTop` fallback below and
  // is exactly the "genuinely no known frame top" case BLOCKER-1 already
  // handles safely via band-hold.
  const rawLogUpdateTopRow = self.logUpdate?.topRow ?? 0;
  // Prefer the real post-render frame top the last repaint captured via measure()
  // (lastMeasuredFrameTop). logUpdate.topRow reports the transient shrink-PADDED
  // top, which reads LOWER than reality after a frame shrink and makes
  // decideCommitMode compute a wrong (too-small) fitsAboveFrame — routing a block
  // that FITS into band-hold, which then overwrites repositioned prior content
  // without archiving it ("two boxes + blank void" streaming-table bug;
  // terminal-compositor.commit-geometry.test.ts + the History note at
  // frame.ts:191-198). Take the MAX so prevTopRow can only be RAISED toward the
  // true top, never lowered — the existing committedBandBottomRow+1 floor is
  // preserved. Gated on !bandGeometryStale: after a SIGWINCH with no repaint
  // since, lastMeasuredFrameTop (and the band floor) are PRE-resize values, so
  // both are excluded and we fall through to rawLogUpdateTopRow — the BLOCKER-1
  // band-hold safety path. When lastMeasuredFrameTop is 0 (no repaint yet) this
  // reduces EXACTLY to the prior expression.
  const measuredFrameTop = self.bandGeometryStale ? 0 : self.lastMeasuredFrameTop;
  const bandFloor =
    self.committedBand.length > 0 && self.committedBandBottomRow > 0 && !self.bandGeometryStale
      ? self.committedBandBottomRow + 1
      : 0;
  const prevTopRow = Math.max(rawLogUpdateTopRow, measuredFrameTop, bandFloor);
  const frameTop = prevTopRow > 1 ? prevTopRow : Math.max(1, rows - 1 - extraRows);
  const anchorFloor = Math.max(self.anchorRow ?? 1, 1);
  // The block "fits" when every line can be CUP-painted at a row in
  // [anchorFloor, frameTop). When it fits we take the single-copy path
  // (Phase 1 scrolls only, Phase 3 paints the one copy, and repaint()'s
  // evict-on-growth keeps that single copy durable). When it does not — a
  // block taller than the visible above-frame region — we fall back to
  // archiving the whole block at anchorFloor in Phase 1 (the legacy path),
  // which keeps the overflow recoverable via scrollback.
  // BLOCKER-1 guard (review #592): only take the scroll-only single-copy
  // path when prevTopRow > 1, i.e. we KNOW the real frame top. When
  // prevTopRow <= 1 the live frame already fills the viewport (overlay-heavy
  // streaming) or was never rendered, so there is genuinely no above-frame
  // room — the `frameTop` fallback (rows-1-extraRows) would overestimate it,
  // Phase 1 would write no text, and Phase 3 would skip (newTopRow <= 1),
  // dropping the block from screen AND scrollback. Falling through to the
  // overflow path archives the block to scrollback at anchorFloor instead
  // (recoverable). No existing test hits prevTopRow <= 1.
  const fitsAboveFrame = prevTopRow > 1 && contentLineCount <= frameTop - anchorFloor;
  // Shrink-pad-corrected effective frame top (shared between Phase 1 and Phase 3):
  // when the prior band is positioned, the real above-frame room starts at
  // committedBandBottomRow + 1 (not at the raw frameTop which may be artificially
  // low due to CupFrameRenderer shrink-padding). Computed here so it is in scope
  // for Phase 3's extended contiguity check without being re-derived inside the
  // writeWithGuard closure. Value matches Phase 1's `effectiveFrameTop` exactly.
  const phase1EffectiveFrameTop =
    fitsAboveFrame && self.committedBand.length > 0 && self.committedBandBottomRow > 0
      ? Math.max(frameTop, self.committedBandBottomRow + 1)
      : frameTop;

  return {
    rows,
    cols,
    extraRows,
    prevTopRow,
    frameTop,
    anchorFloor,
    fitsAboveFrame,
    phase1EffectiveFrameTop,
  };
}
