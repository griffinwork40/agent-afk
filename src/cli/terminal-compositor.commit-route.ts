import type { BandRowMeta } from './terminal-compositor.types.js';
import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';
import type { CommitText } from './terminal-compositor.commit-text.js';
import type { CommitGeometry } from './terminal-compositor.commit-geometry.js';
import { decideCommitMode } from './commit-mode.js';
import { snapFlushCountToLogicalBoundary } from './terminal-compositor.scrollback.js';

export interface CommitRoute {
  textLines: string[];
  textMeta: BandRowMeta[];
  lineCount: number;
  useBandHold: boolean;
  overflowRun: string[];
  overflowRunMeta: BandRowMeta[];
  archiveCount: number;
  rawGenuineOverflow: number;
  maxBandModel: number;
}

/**
 * Derive the commit routing decision from geometry and text decomposition:
 * which text lines to paint, whether to use band-hold, what overflow to
 * archive, and how many rows to scroll in Phase 1.
 */
export function routeCommit(
  self: CommittedBandHost,
  t: CommitText,
  geo: CommitGeometry,
): CommitRoute {
  const { fitsAboveFrame, phase1EffectiveFrameTop, anchorFloor, prevTopRow, frameTop, rows, extraRows } = geo;
  const { contentLines, contentMeta, contentLineCount, hasTrailingSeparator, separatorMeta } = t;

  // Re-add the trailing separator as a painted blank row — but only when the
  // above-frame region has room for it BEYOND the content. A block whose content
  // exactly fills the room keeps all its content and drops the separator (the
  // table exact-fit case, d86f2a2); otherwise the separator lands at newTopRow-1
  // (against the frame), so the NEXT block commits above it and consecutive
  // blocks read with exactly one blank line between them (the rhythm contract).
  // `textLines` (what Phase 3 paints) and `lineCount` (what Phase 1 scrolls and
  // bandOverflow evicts) are kept COUPLED — both grow by exactly the painted
  // separator — so the scroll and the cap evict the SAME rows; a mismatch would
  // lose a committed row or push a blank into scrollback. In the overflow path
  // paintSeparator is false (it requires fitsAboveFrame), so lineCount ===
  // contentLineCount and textLines === contentLines there, preserving the legacy
  // overflow geometry. Room is measured against phase1EffectiveFrameTop (the same
  // shrink-pad-corrected top bandOverflow uses) so the decision stays consistent.
  const aboveFrameRoomForSeparator = Math.max(0, phase1EffectiveFrameTop - anchorFloor);
  const paintSeparator =
    hasTrailingSeparator && fitsAboveFrame && contentLineCount < aboveFrameRoomForSeparator;
  const textLines = paintSeparator ? [...contentLines, ''] : contentLines;
  const textMeta = paintSeparator ? [...contentMeta, separatorMeta] : contentMeta;
  const lineCount = contentLineCount + (paintSeparator ? 1 : 0);

  // Band-hold routing (pure, tested in commit-mode.test.ts): keep a block that
  // overflows the CURRENT tall frame but fits the COLLAPSED screen in the band
  // model instead of archiving+truncating it. Additive: useBandHold is a new
  // route checked before the existing fits/overflow branches; the existing
  // fitsAboveFrame computed above still governs separator + Phase-1/3 fits math.
  //
  // Band-hold model uses the separator-inclusive block. The rhythm separator is
  // always counted in the band model's row budget — even when paintSeparator is
  // false — because the collapsed frame will display the separator between blocks.
  // This also lets decideCommitMode see the correct effective lineCount (including
  // the separator) so a 1-content-line block with trailing separator counts as 2
  // model rows, correctly routing it to band-hold when room=1.
  const bandTextLines = hasTrailingSeparator ? [...contentLines, ''] : contentLines;
  const bandTextMeta = hasTrailingSeparator ? [...contentMeta, separatorMeta] : contentMeta;
  const bandLineCount = bandTextLines.length;
  const {
    useBandHold,
    overflowRun,
    overflowPriorContiguous,
    maxBandModel,
  } = decideCommitMode({
    prevTopRow,
    frameTop,
    anchorFloor,
    anchorRow: self.anchorRow ?? 1,
    lineCount: bandLineCount,
    textLines: bandTextLines,
    rows,
    extraRows,
    committedBand: self.committedBand,
    committedBandBottomRow: self.committedBandBottomRow,
    committedBandPaintedRows: self.committedBandPaintedRows,
    geometryStale: self.bandGeometryStale,
  });
  // #540 axis-2: the per-physical-row provenance for `overflowRun`, rebuilt
  // here to stay 1:1 with it — decideCommitMode is a pure geometry helper and
  // is left untouched. Mirrors its `overflowRun = overflowPriorContiguous ?
  // [...committedBand, ...bandTextLines] : bandTextLines` exactly, using the
  // same-order meta arrays (self.committedBandMeta is kept 1:1 with
  // self.committedBand; bandTextMeta with bandTextLines).
  const overflowRunMeta: BandRowMeta[] = overflowPriorContiguous
    ? [...self.committedBandMeta, ...bandTextMeta]
    : bandTextMeta;
  // #540 axis-2: how many oldest PHYSICAL rows of overflowRun the band-hold
  // path archives to scrollback this commit — decideCommitMode's raw
  // `overflowRun.length - maxBandModel`, but SNAPPED DOWN to a logical-line
  // boundary so a multi-row logical line is never archived one physical row per
  // commit (which would emit it verbatim each time and re-fragment it). The
  // straddling line (and everything after) is RETAINED in the band model until
  // a later commit's overflow covers all its rows, then it archives whole as
  // one soft-wrappable line. Phase 1 (archive) and Phase 3 (model = the
  // retained suffix) both split overflowRun at this same index so archived and
  // retained stay disjoint and complete.
  const rawGenuineOverflow = Math.max(0, overflowRun.length - maxBandModel);
  const archiveCount = snapFlushCountToLogicalBoundary(
    overflowRunMeta,
    rawGenuineOverflow,
    overflowRun.length,
  );

  return {
    textLines,
    textMeta,
    lineCount,
    useBandHold,
    overflowRun,
    overflowRunMeta,
    archiveCount,
    rawGenuineOverflow,
    maxBandModel,
  };
}
