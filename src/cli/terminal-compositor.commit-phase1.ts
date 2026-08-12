import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';
import type { CommitGeometry } from './terminal-compositor.commit-geometry.js';
import type { CommitRoute } from './terminal-compositor.commit-route.js';
import { writeWithScrollGuard } from './terminal-compositor.commit-guard.js';
import {
  scrollbackFlushLines,
  buildScrollbackArchiveEscape,
} from './terminal-compositor.scrollback.js';

/**
 * Phase 1 teardown: clear the live frame, emit the scrollback write (LFs or
 * archived overflow), and return the number of rows scrolled into scrollback
 * this commit. MUST NOT call self.repaint() — that is Phase 2.
 *
 * The `committing` flag management and try/finally live in the orchestrator.
 */
export function commitPhase1Teardown(
  self: CommittedBandHost,
  geo: CommitGeometry,
  route: CommitRoute,
): number {
  const { fitsAboveFrame, anchorFloor, rows, cols } = geo;
  const { lineCount, textLines, useBandHold, overflowRun, overflowRunMeta, archiveCount } = route;

  // Invariant (single-copy commit): each committed line reaches the
  // terminal EXACTLY ONCE. The whole-block duplication bug came from
  // writing the text in BOTH Phase 1 (a scrollback copy) AND Phase 3 (a
  // viewport copy that later also evicts to scrollback) — every block
  // landed in scrollback twice, and the most-recent blocks were visibly
  // duplicated (the Phase-3 copy above the frame plus the Phase-1 copy
  // already in scrollback). See the 'commits each block to scrollback
  // exactly once' regression in terminal-compositor.splice.test.ts.
  //
  // Two mutually-exclusive strategies:
  //
  //  • fitsAboveFrame (common case): emit `\n` × bandOverflow (not ×
  //    lineCount). The above-frame room is `frameTop - anchorFloor` rows;
  //    `bandOverflow` is how many existing band rows no longer fit once the
  //    new line is added. When the band is short of room the new line just
  //    extends it in-place — zero LFs, no blank rows scrolled. When it is
  //    at capacity, each LF displaces the topmost band row (real content,
  //    already CUP-painted by Phase 3 of the previous commit) into
  //    scrollback — never blanks. Phase 3 CUP-paints the complete capped
  //    run once. Durability (surviving a later overlay growth) is handled
  //    by repaint()'s evict-on-growth, which scrolls overflow into
  //    scrollback instead of letting the taller frame overwrite it.
  //
  //  • !fitsAboveFrame (overflow — block taller than the above-frame
  //    region): CUP-write the whole block at `anchorFloor` (never below,
  //    so the banner is never clobbered) and scroll. Phase 3 then paints
  //    only the lines that fit; the duplication that implies is bounded
  //    to a single block bigger than the screen and is the legacy
  //    behavior — far rarer than the per-commit duplication this fix
  //    removes for normal-sized blocks.
  // How many of the oldest committed band lines no longer fit above the
  // frame once `lineCount` new lines are added. Mirrors
  // preserveRowsBeforeFrameRender's evict-on-growth math but fires at
  // commit time rather than at the next repaint.
  //
  // Shrink-padding correction: CupFrameRenderer applies shrink padding
  // when the frame content shrinks — it pads blanks above the real
  // content rows so the FULL previous-render footprint is covered by the
  // erase pass. This makes prevTopRow artificially low (e.g. 6 instead
  // of 17) even though the committed band is at rows 12..16 and the real
  // frame content starts at row 17. Using raw prevTopRow here would
  // compute aboveFrameRoom = 5 instead of 16, falsely triggering a
  // bandOverflow=1 scroll that pushes a blank row into scrollback.
  //
  // Fix: when the committed band is positioned (committedBandBottomRow > 0),
  // use max(prevTopRow, committedBandBottomRow + 1) as the effective frame
  // top — the band's actual bottom boundary is authoritative. Phase 2's
  // repaint will land the frame at its real content top (≥ bandBottom+1),
  // and Phase 3 positions the extended band correctly.
  //
  // Merge-path guard: the bandOverflow optimization (emit ≤ lineCount LFs,
  // not exactly lineCount) is only safe when Phase 3 takes the merge path
  // — i.e. contiguousPriorBand will be true and the new run INCLUDES the
  // old band content. When anchorRow > 1 the merge path is disabled (that
  // condition requires anchorRow ≤ 1), so existing band content would be
  // silently overwritten by Phase 3 without ever reaching scrollback. In
  // that case fall back to emitting exactly `lineCount` LFs (original
  // behavior), which scrolls the old band rows into scrollback before
  // Phase 3 paints over them. Also safe when committedBand is empty
  // (nothing to lose) regardless of anchorRow.
  //
  // CRITICAL IMPROVEMENT: use geo.phase1EffectiveFrameTop directly instead of
  // re-deriving effectiveFrameTop here — canUseMergePath === fitsAboveFrame,
  // so these are provably identical. This converts Invariant B from
  // comment-enforced to structural.
  const effectiveFrameTop = geo.phase1EffectiveFrameTop;
  const aboveFrameRoom = Math.max(0, effectiveFrameTop - anchorFloor);
  // When the merge path is available: emit only the overflow (may be 0).
  // Otherwise: emit the full lineCount to scroll old band rows to scrollback.
  const bandOverflow = fitsAboveFrame
    ? Math.max(0, self.committedBand.length + lineCount - aboveFrameRoom)
    : lineCount;
  // Record the rows the fitsAboveFrame path scrolls so the anchor floor can
  // follow (see the decrement after the finally). Scoped to fitsAboveFrame:
  // the overflow path archives the whole block to scrollback and floors
  // Phase 3 at the unchanged anchorFloor to avoid clobbering the banner.
  const scrolledRows = fitsAboveFrame ? bandOverflow : 0;

  // #665 review: record the snap inputs/outputs too. `archiveCount === 0`
  // with `rawGenuineOverflow > 0` means the snap retained a straddling
  // logical line and Phase 1 archived NOTHING this commit — a state that is
  // only observable in a real terminal (the PTY harness cannot reproduce
  // DECAWM deferred wrap), so without these fields it leaves no trace.
  self.debugLog('commitAbove:phase1', {
    lineCount,
    fitsAboveFrame,
    bandOverflow,
    rawGenuineOverflow: route.rawGenuineOverflow,
    archiveCount,
    maxBandModel: route.maxBandModel,
    overflowRunLen: overflowRun.length,
  });

  writeWithScrollGuard(self, () => {
    if (useBandHold) {
      // Band-hold Phase 1: scroll NOTHING for the rows the model keeps (they
      // are "pending" — painted by repositionCommittedBand on collapse). Only
      // the genuine overflow (oldest rows beyond maxBandModel) is archived to
      // scrollback as REAL content. The archived prefix is disjoint from the
      // suffix Phase 3 keeps — no duplication.
      //
      // #540 axis-2 (logical-line flush): archive the overflow prefix as
      // SOFT-WRAPPABLE logical lines, not the pre-hard-wrapped physical rows,
      // so a later width resize reflows scrolled-off content cleanly instead
      // of re-fragmenting it. `archiveCount` (computed above) is the raw
      // overflow SNAPPED to a logical-line boundary, so no logical line is
      // ever split across two archive events; scrollbackFlushLines therefore
      // emits whole logical lines, and buildScrollbackArchiveEscape paints
      // them top-aligned with autowrap ON and scrolls their total physical
      // height off the top into history (the terminal owns the wrap → its
      // continuation rows are soft-wrap continuations that rejoin on resize).
      // Autowrap is load-bearing here (opposite of the on-screen band paint's
      // withAutowrapDisabled). Phase 3's model keeps overflowRun[archiveCount:]
      // (see the `overflowRun.slice(archiveCount)` assignments) so archived +
      // retained are disjoint + complete.
      if (archiveCount > 0) {
        const archiveLines = scrollbackFlushLines(overflowRun, overflowRunMeta, archiveCount);
        const escape = buildScrollbackArchiveEscape(archiveLines, anchorFloor, rows, cols);
        if (escape.length > 0) self.stdout.write(escape);
      }
    } else if (fitsAboveFrame) {
      if (bandOverflow > 0) {
        self.stdout.write(`\x1b[${rows};1H${'\n'.repeat(bandOverflow)}`);
      }
      // bandOverflow === 0: new line extends the band in-place; no LF
      // needed. Phase 3 repaints the whole band to include it. Skipping
      // the LF prevents a blank row from entering scrollback when the
      // above-frame space has not yet been filled.
    } else {
      // Per-line erase (\x1b[2K) stops a shorter line from splicing onto
      // un-erased remnants of longer prior content on the same row.
      const eraseEachLine = textLines.map((l) => `\x1b[2K${l ?? ''}`).join('\n');
      self.stdout.write(
        `\x1b[${anchorFloor};1H${eraseEachLine}\x1b[${rows};1H${'\n'.repeat(lineCount)}`,
      );
    }
  });

  return scrolledRows;
}
