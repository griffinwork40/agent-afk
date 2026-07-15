/**
 * Committed-band lifecycle — `commitAbove` (the above-frame / scrollback commit
 * pipeline), band clear/reset, resize ghost-erase, and band repositioning —
 * extracted from terminal-compositor.ts. Follows the free-functions-on-host
 * pattern used by the sibling paste/autocomplete/render modules: the
 * TerminalCompositor owns all band state; these functions read and MUTATE the
 * narrow {@link CommittedBandHost} slice it passes as `self`. No behavior
 * change — bodies are byte-for-byte moves with `this.` rewritten to `self.`
 * and the intra-cluster `clearCommittedBand` call made a direct module call.
 *
 * The band fields stay on the class (not lifted into a sub-object) because the
 * resize / scrollback test suite reaches into them directly; this module only
 * borrows them through the host interface.
 */

import type { LogUpdateFn, CompositorScrollRegionGuard, BandRowMeta } from './terminal-compositor.types.js';
import {
  eraseAndPaintRow,
  buildBandMeta,
  scrollbackFlushLines,
  buildScrollbackArchiveEscape,
  snapFlushCountToLogicalBoundary,
} from './terminal-compositor.types.js';
import { hardWrapToWidth } from './wrap.js';
import { decideCommitMode } from './commit-mode.js';
import {
  reflowCommittedBandToWidth,
  type BandReflowCache,
} from './terminal-compositor.band-reflow.js';

/**
 * Narrowest TerminalCompositor state slice the committed-band functions touch.
 * The band-tracking fields, commit-state flags, and `pendingResizeErase` are
 * mutated in place; `scrollRegion`/`stdout` are read-only collaborators; and
 * `repaint`/`debugLog` are class methods the functions call back into.
 */
export interface CommittedBandHost {
  /** Re-render the live frame (Phase 2 of commitAbove). */
  repaint(): void;
  /** Structured debug tracer (no-op unless compositor debugging is enabled). */
  debugLog(stage: string, extra?: Record<string, unknown>): void;
  /** The full contiguous on-screen committed run adjacent to the frame top. */
  committedBand: string[];
  /** Per-physical-row logical provenance, index-aligned 1:1 with committedBand (#540). */
  committedBandMeta: BandRowMeta[];
  committedBandTopRow: number;
  committedBandBottomRow: number;
  /** Real unpadded frame top from the last repaint's measure() — see the field
   *  doc on the class. Routing (prevTopRow) trusts this over logUpdate.topRow. */
  lastMeasuredFrameTop: number;
  /** How many of committedBand's rows (its bottom suffix) are painted on screen. */
  committedBandPaintedRows: number;
  /** Memoization for reflowCommittedBandToWidth — see the field doc on the class. */
  bandReflowCache: BandReflowCache | null;
  /** Re-entrancy guard: suppresses a repaint during the clear→write window. */
  committing: boolean;
  /** Suppresses the shrink re-pin (repositionCommittedBand) for a commit. */
  commitInFlight: boolean;
  /** Whether any commit has happened this arm cycle (guards growthDeficit). */
  hasCommitted: boolean;
  /** Pre-resize on-screen footprint to physically erase on the next repaint. */
  pendingResizeErase: { top: number; bottom: number } | null;
  /**
   * F2: true from the SIGWINCH-immediate handler until the next debounced
   * repaint re-establishes real frame geometry. See the field doc on the
   * class (terminal-compositor.ts) for the full failure mode this guards.
   */
  bandGeometryStale: boolean;
  /** Pre-arm content ceiling — committed text never lands above this row. */
  anchorRow: number | undefined;
  /** Whether the compositor currently holds raw mode + the keypress listener. */
  armed: boolean;
  /** The single log-update region tracker; null when not armed. */
  logUpdate: LogUpdateFn | null;
  /** DECSTBM scroll-region guard; absent when no status line is active. */
  readonly scrollRegion?: CompositorScrollRegionGuard;
  readonly stdout: NodeJS.WriteStream;
}

export function commitAbove(self: CommittedBandHost, text: string): void {
  self.debugLog('commitAbove:enter', { textLen: text.length, anchorRow: self.anchorRow ?? null, committing: self.committing, topRow: self.logUpdate?.topRow ?? null });
  // External constraint (DECSTBM contract): when a StatusLine is active
  // the bottom row is reserved via a persistent scroll region. A raw
  // `\n` written at the bottom of that sub-region triggers a sub-region
  // scroll on xterm/iTerm2/Apple Terminal, and the displaced top line
  // silently exits without entering scrollback. Wrapping the inner write
  // in `scrollRegion.withFullScrollRegion(...)` makes the `\n` produce a
  // full-screen scroll instead, which DOES enter scrollback. No-op when
  // scrollRegion is absent or its status line hasn't started.
  const writeWithGuard = (write: () => void): void => {
    if (self.scrollRegion) {
      self.scrollRegion.withFullScrollRegion(write);
    } else {
      write();
    }
  };

  if (!self.armed || !self.logUpdate) {
    writeWithGuard(() => {
      self.stdout.write(text + '\n');
    });
    return;
  }
  // Invariant: logUpdate.clear() → scrollback write → repaint() must be
  //   atomic w.r.t. re-entrant repaint(); the `committing` flag enforces self.
  //
  // log-update tracks the overlay+input region. clear() erases it and
  // returns the cursor to the top of that region. stdout.write(text+'\n')
  // then injects text into the scrollback, pushing the cursor below it.
  // repaint() re-tracks a fresh frame from the new cursor position.
  //
  // The `committing` guard suppresses any re-entrant repaint() that fires
  // synchronously during the clear→write window (e.g. a resize event flushed
  // mid-stack, or any future caller that triggers repaint via setOverlay
  // while commitAbove is in flight). Without it, a second frame would be
  // drawn on top of the just-cleared region and the spinner row would be
  // stranded in scrollback. `try/finally` guarantees the flag is reset even
  // if logUpdate.clear() or stdout.write() throws (e.g. TTY closed
  // mid-session) — otherwise the compositor would go permanently deaf to
  // repaint() for the rest of the session.
  //
  // Ordering note: logUpdate.clear() walks the cursor up to the top of
  // the previous frame, then writeWithGuard wraps ONLY the
  // scrollback-bound `stdout.write(text + '\n')`. We don't wrap the
  // clear() because (a) its erase-line ANSI doesn't interact with
  // DECSTBM scroll semantics, and (b) wrapping it would also flush the
  // status line mid-commit, producing visible flicker on every
  // commitAbove during a turn.
  // Compute line count from the text (each newline delimits a row;
  // trailing \n is the line terminator, not its own row).
  const rows = Math.max(1, self.stdout.rows ?? 24);
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;

  // Separate a block's CONTENT from its trailing blank SEPARATOR.
  //
  // commitBlock commits prose as `trimmed + '\n\n'` — the TUI rhythm contract:
  // every block owns exactly one trailing blank (docs/tui-rhythm.md). After the
  // single-'\n' strip above, a separator-terminated block's `stripped` still
  // ends with '\n', so split('\n') yields a trailing '' — the separator row. A
  // block with NO separator (`commitAbove('A\nB')`, or the single-terminator
  // `commitAbove('A\nB\n')`) leaves no trailing '' (its lone '\n' was stripped).
  //
  // Pop the trailing '' so `contentLines` / `contentLineCount` describe ONLY
  // real content: a phantom trailing '' previously made textLines.length =
  // count+1, and in the exact-fit scenario (content height === above-frame
  // room) the tail-slice dropped a table's top border and painted the '' into
  // the bottom slot (d86f2a2). The separator is RE-ADDED as a painted blank row
  // below — but only when there is room for it beyond the content (a block that
  // exactly fills the room keeps all its content and drops the separator, so the
  // newest content still sits against the frame). The length>1 guard keeps
  // `commitAbove('')` painting its single blank row (the subagent-done path).
  const cols = Math.max(1, self.stdout.columns ?? 80);
  // F1 (retained-logical-source re-wrap): the prior band was hard-wrapped at
  // WHATEVER width was current when IT was committed — possibly a resize or
  // several ago. Re-wrap it to the CURRENT `cols` before any of the geometry
  // below reads `self.committedBand`/`committedBandBottomRow` (the merge
  // contiguity check, decideCommitMode's overflowRun, and Phase 3's merge all
  // read the band) — see terminal-compositor.band-reflow.ts's module doc for
  // why a stale-width row can never be trusted verbatim again. No-op (and
  // free) when nothing has resized since the band was last reflowed.
  reflowCommittedBandToWidth(self, cols);
  const logicalLines = stripped.split('\n');
  let hasTrailingSeparator = false;
  while (logicalLines.length > 1 && logicalLines[logicalLines.length - 1] === '') {
    logicalLines.pop();
    hasTrailingSeparator = true;
  }
  // Wrap-aware physical CONTENT rows: a logical line wider than the terminal
  // occupies >1 physical row. hardWrapToWidth (pure char wrap, ANSI-preserving,
  // matches the terminal) makes commitAbove position/scroll/paint exactly one
  // terminal row per array entry — so a wide line's wrapped tail is not "eaten"
  // by the next commit's paint, and the band-hold row math is exact.
  const contentLines = logicalLines.flatMap((l) => hardWrapToWidth(l, cols).split('\n'));
  const contentLineCount = Math.max(1, contentLines.length);
  // #540 axis-2 (retained logical source): the per-physical-row provenance for
  // `contentLines`, index-aligned 1:1. Recorded from the SAME logical lines +
  // width that produced the physical rows above, so the scrollback-flush sites
  // can later emit the logical line (terminal-soft-wrapped, reflow-clean)
  // instead of these pre-hard-wrapped rows. The separator blank row (added to
  // textLines/bandTextLines below) is its own logical line ''.
  const contentMeta = buildBandMeta(logicalLines, cols);
  const separatorMeta: BandRowMeta = { logicalText: '', isHead: true };

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
  const rawLogUpdateTopRow = self.logUpdate.topRow ?? 0;
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

  // Suppress the shrink re-pin for the whole commit; Phase 3 sets the band.
  // Re-armed at the top of every commitAbove, so a throw on a dying TTY (the
  // only realistic escape — Phase 3's stdout.write under writeWithGuard) that
  // skips the Phase-3 reset only suppresses a visual nicety for a session
  // that is already ending; the next commit re-arms it. No try/finally needed.
  self.commitInFlight = true;
  self.committing = true;
  // Rows Phase 1 scrolls into scrollback this commit (set inside the guard).
  // The whole screen — banner included — scrolls up by this many rows, so the
  // anchor floor must drop to match (see the decrement after the finally).
  let scrolledRows = 0;
  try {
    self.logUpdate.clear(extraRows);
    writeWithGuard(() => {
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
      const canUseMergePath = fitsAboveFrame;
      const effectiveFrameTop =
        canUseMergePath && self.committedBand.length > 0 && self.committedBandBottomRow > 0
          ? Math.max(frameTop, self.committedBandBottomRow + 1)
          : frameTop;
      const aboveFrameRoom = Math.max(0, effectiveFrameTop - anchorFloor);
      // When the merge path is available: emit only the overflow (may be 0).
      // Otherwise: emit the full lineCount to scroll old band rows to scrollback.
      const bandOverflow = canUseMergePath
        ? Math.max(0, self.committedBand.length + lineCount - aboveFrameRoom)
        : lineCount;
      // Record the rows the fitsAboveFrame path scrolls so the anchor floor can
      // follow (see the decrement after the finally). Scoped to fitsAboveFrame:
      // the overflow path archives the whole block to scrollback and floors
      // Phase 3 at the unchanged anchorFloor to avoid clobbering the banner.
      scrolledRows = fitsAboveFrame ? bandOverflow : 0;
      self.debugLog('commitAbove:phase1', { lineCount, fitsAboveFrame, bandOverflow });
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
        // (see capBandModel call) so archived + retained are disjoint + complete.
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
  } finally {
    self.committing = false;
    self.debugLog('commitAbove:finally');
  }
  // Invariant (floor follows the scroll): Phase 1 scrolled `scrolledRows` rows
  // off the top of the screen. The banner occupying rows [1, anchorRow-1]
  // scrolled up with everything else, so the protected ceiling shrinks by the
  // same amount — exactly as the evict path in preserveRowsBeforeFrameRender
  // does (anchorRow -= deficit). Without this the floor goes stale, the
  // above-frame room never grows, committed content orphans in the vacated
  // banner rows, and a later overlay collapse loses it. Clamp at 1; once the
  // banner is fully in scrollback the path matches the no-banner case.
  if (scrolledRows > 0 && self.anchorRow !== undefined && self.anchorRow > 1) {
    self.anchorRow = Math.max(1, self.anchorRow - scrolledRows);
  }
  // Mark that a commit has happened this arm cycle so growthDeficit in
  // repaint() knows there is transcript content above the frame to protect.
  self.hasCommitted = true;

  // Phase 2: repaint the live frame at its normal bottom-anchored
  // position. The repaint() does its own erase+paint via render(),
  // landing the new frame at `newTopRow..rows-1` regardless of how
  // big the previous frame was.
  self.debugLog('commitAbove:phase2:repaint');
  self.repaint();
  self.debugLog('commitAbove:phase2:done', { newTopRow: self.logUpdate.topRow ?? null });

  // Phase 3: write the committed text at rows `newTopRow -
  // lineCount..newTopRow - 1` (immediately above the live frame) so it's
  // visible without scrolling.
  //
  // In the fitsAboveFrame case this is the SOLE copy of the block — Phase 1
  // scrolled only the band overflow (oldest lines that no longer fit) into
  // scrollback, never the new block itself. The copy stays visible and is
  // kept durable across a later overlay growth by repaint()'s evict-on-growth
  // (which scrolls it into scrollback rather than letting the taller frame
  // overwrite it); it also flows into scrollback on its own as later commits
  // evict it.
  //
  // In the overflow case Phase 1 already archived the whole block at
  // anchorFloor, so this paints only the top lines that fit.
  //
  // Edge cases:
  // - `topRow` is 0 or 1: no above-frame area exists, skip phase 3.
  // - `lineCount > newTopRow - anchorFloor`: only the lines that fit between
  //   anchorFloor and the frame are painted; in the overflow path the rest
  //   are already in scrollback (Phase 1) — never CUP-written below
  //   anchorFloor.
  const newTopRow = self.logUpdate.topRow ?? 0;
  if (newTopRow > 1) {
    // Invariant: committedBand tracks the FULL contiguous on-screen committed
    // run occupying [committedBandTopRow, newTopRow - 1] adjacent to the frame
    // top — NOT just the most-recent block. repositionCommittedBand re-pins
    // the band against the frame on a shrink; tracking only the latest block
    // let a large collapse re-pin that one block while OLDER on-screen blocks
    // stayed stranded high — the "massive gap" between scrollback and the live
    // frame. Tracking the whole run re-pins all of it, keeping it contiguous.
    //
    // The prior band is merged with the new lines ONLY when verifiably
    // contiguous with them. In the fitsAboveFrame path Phase 1 scrolled
    // `bandOverflow` rows (0 when the band has room to grow, otherwise
    // exactly the number of oldest band lines that no longer fit), so the
    // maintained invariant keeps the prior band's bottom one row above the
    // frame top — verified by the stale, pre-commit committedBandBottomRow ===
    // newTopRow - 1, the prior band's bottom sits exactly one row above this
    // block's top. anchorRow <= 1 keeps the merge sound (no mid-commit anchor-
    // ceiling evict could have shifted the tracked bottom). Otherwise (frame
    // resized between commits, anchor-ceiling evict, or the overflow
    // !fitsAboveFrame path) fall back to single-block tracking.
    // Measure room against the POST-scroll floor: the anchorRow decrement above
    // lowered the ceiling by `scrolledRows`, so the newly-vacated banner rows
    // are now legitimately available to the band. Using the stale pre-scroll
    // anchorFloor would keep maxRun pinned and re-trigger the cap-to-one-row bug.
    const postScrollFloor = Math.max(self.anchorRow ?? 1, 1);
    const maxRun = Math.max(0, newTopRow - postScrollFloor);
    if (useBandHold) {
      // Band-hold Phase 3: track the committed run's RETAINED suffix as the band
      // model, but paint only the bottom paintedCount rows that fit above the
      // current frame. The rest are "pending" — in the model, not yet on screen,
      // not in scrollback. repositionCommittedBand paints the whole model
      // contiguously above the frame on the next shrink/collapse.
      //
      // #540: the retained suffix is overflowRun[archiveCount:], the exact
      // complement of what Phase 1 archived. archiveCount is capBandModel's
      // `overflowRun.length - maxBandModel` SNAPPED DOWN to a logical-line
      // boundary, so the model may retain up to (one logical line's height − 1)
      // rows BEYOND maxBandModel — a straddling logical line is kept whole here
      // rather than archived half now / half later (which re-fragments it). The
      // extra pending rows are painted on collapse / flushed on disarm like any
      // pending rows; the bound is one logical line, so the model never grows
      // unboundedly.
      const model = overflowRun.slice(archiveCount);
      // #540: slice the provenance at the SAME index so it stays 1:1 with `model`.
      const modelMeta = overflowRunMeta.slice(archiveCount);
      const paintedCount = Math.min(model.length, maxRun);
      const bandTop = newTopRow - paintedCount;
      let out = '';
      for (let i = 0; i < paintedCount; i++) {
        const row = bandTop + i;
        if (row >= newTopRow) break; // Never overwrite the live frame.
        out += eraseAndPaintRow(row, model[model.length - paintedCount + i]);
      }
      if (out.length > 0) {
        writeWithGuard(() => {
          self.stdout.write(out);
        });
      }
      self.committedBand = model;
      self.committedBandMeta = modelMeta;
      self.committedBandBottomRow = newTopRow - 1;
      self.committedBandTopRow = bandTop;
      // Only the bottom `paintedCount` rows reached the terminal; the rest of
      // the model is pending (painted by repositionCommittedBand on collapse).
      self.committedBandPaintedRows = paintedCount;
    } else {
    const newPainted = Math.min(textLines.length, maxRun);
    if (newPainted > 0) {
      // Tail-slice (not head): when the block is taller than the above-frame
      // room (overflow path, newPainted < lineCount), keep the LAST lines. A
      // block's final line — e.g. a verdict card's closing border `╰──╯` and
      // its affordance — must survive, not its opening line; dropping the
      // bottom left boxes rendered un-closed. In the fits path newPainted ===
      // lineCount, so this is the whole array (no behavior change there).
      const newLines = textLines.slice(textLines.length - newPainted);
      // #540: the new block's provenance, sliced in lockstep with newLines.
      const newMeta = textMeta.slice(textMeta.length - newPainted);
      // "Whole block painted" = newPainted === textLines.length (no lines
      // dropped to overflow). Compare against textLines.length, NOT lineCount:
      // lineCount is the WRAP-AWARE physical row count (measure()), which can
      // diverge from the logical-line array length when a line is wider than
      // the terminal and wraps to >1 physical row. newPainted is itself derived
      // from textLines.length, so comparing back to textLines.length keeps the
      // check self-consistent regardless of wrap-induced divergence.
      // Note: textLines already includes the painted separator row (or none) and
      // lineCount is coupled to it, so there is no `\n\n` trailing-blank
      // divergence to correct here — the separator is extracted and conditionally
      // re-added above, never left as a phantom array element.
      const wholeBlockPainted = newPainted === textLines.length;
      // Invariant (contiguity across banner-path eviction gaps): the prior band
      // is mergeable when it was adjacent to the frame BEFORE Phase 2 snapped the
      // frame to bottom-anchored (commitInFlight). Banner-path evictions in
      // preserveRowsBeforeFrameRender shift committedBandBottomRow downward (lower
      // row number) by scrolling the viewport upward, but the frame stays where it
      // is for the next render — so by the time the response commitAbove fires, the
      // band's tracked bottom may be several rows below newTopRow-1. The classic
      // check (`committedBandBottomRow === newTopRow - 1`) requires exact adjacency
      // to the POST-Phase-2 frame top and fails on this gap, dropping the whole
      // prior band from the model. The extended check adds `effectiveFrameTop - 1`
      // (the band's tracked bottom is adjacent to the PRE-Phase-2 frame top,
      // corrected for shrink-pad) — that relationship is unambiguously contiguous
      // even though Phase 2 stretched the gap by snapping to absoluteBottom.
      // Safety: `fitsAboveFrame` is already required, so this extended arm only
      // fires when the merged run is guaranteed to fit in the above-frame region;
      // `anchorRow <= 1` is NOT required here because the merge path is gated on
      // `fitsAboveFrame`, not on `anchorRow <= 1`.
      const contiguousPriorBand =
        fitsAboveFrame &&
        wholeBlockPainted &&
        self.committedBand.length > 0 &&
        (self.committedBandBottomRow === newTopRow - 1 ||
          self.committedBandBottomRow === phase1EffectiveFrameTop - 1);
      const run = contiguousPriorBand ? [...self.committedBand, ...newLines] : newLines;
      // #540: the merged run's provenance, 1:1 with `run` (same merge decision,
      // same-order arrays — self.committedBandMeta is 1:1 with self.committedBand).
      const runMeta = contiguousPriorBand ? [...self.committedBandMeta, ...newMeta] : newMeta;
      // Cap at the room between the anchor floor and the frame top. maxRun >=
      // newPainted always (the new lines fit by construction), so they are
      // never dropped; only prior-band lines that scroll above the floor are.
      const capped = run.length > maxRun ? run.slice(run.length - maxRun) : run;
      // #540: cap the provenance by the SAME row count so it stays 1:1 with `capped`.
      const cappedMeta = run.length > maxRun ? runMeta.slice(runMeta.length - maxRun) : runMeta;
      const bandTop = newTopRow - capped.length;
      // Stale band rows above bandTop: when the extended contiguity arm fires, the
      // old band's tracked top (self.committedBandTopRow) may be ABOVE the new
      // bandTop — those rows hold echo content that was physically scrolled there
      // by earlier evictions and was never overwritten (they were above the
      // streaming frame top). Phase 3's paint loop covers only rows bandTop..newTopRow-1;
      // rows committedBandTopRow..bandTop-1 are orphaned: they still show stale echo
      // content whose row position no longer matches the merged band model. Erase
      // them before painting so screen == model after Phase 3.
      const oldBandTop = self.committedBandTopRow;
      let out = '';
      if (fitsAboveFrame) {
        // History: repaint the ENTIRE visible band, not just the new block.
        // commitAbove suppresses repositionCommittedBand for the whole commit
        // (commitInFlight), but Phase 2's CupFrameRenderer erase pass runs
        // with a stale-tall previousTopRow after a shrink-pad collapse and
        // wipes the older band rows. Painting only the new block left those
        // rows blank on screen while the model still counted them; the next
        // commit's Phase-1 scroll / evict-on-growth then carried BLANKS into
        // scrollback (the band content was never physically there to scroll),
        // and the cap dropped the orphaned lines on the false premise they had
        // reached scrollback — the "massive gap" / lost-commits bug. Repainting
        // the full capped run keeps screen == model, so scroll-eviction
        // carries real content into scrollback and the cap drops exactly the
        // lines that scroll off. Single-copy still holds: these rows live only
        // in the viewport until a later scroll moves them (once) into
        // scrollback. Full root-cause + design: docs/scrollback.md.
        //
        // Invariant (orphan erase): erase rows that the old band occupied above
        // the new bandTop BEFORE painting the merged run. Without this, an old
        // echo row that was physically scrolled above the new bandTop (by banner-
        // path evictions) remains visible on screen while the model no longer
        // tracks it — a ghost that the next collapse repaint's stale-tall erase
        // may or may not cover, producing intermittent duplicate or orphaned rows.
        // This erase is safe for the non-extended arm too (bandTop >= oldBandTop
        // in the classic adjacent case, so the loop emits zero iterations).
        if (oldBandTop > 0 && oldBandTop < bandTop) {
          const eraseFloor = Math.max(postScrollFloor, oldBandTop);
          for (let r = eraseFloor; r < bandTop; r++) {
            out += eraseAndPaintRow(r);
          }
        }
        for (let i = 0; i < capped.length; i++) {
          const row = bandTop + i;
          if (row >= newTopRow) break; // Never overwrite the live frame.
          out += eraseAndPaintRow(row, capped[i]);
        }
      } else {
        // Overflow (block taller than the above-frame region): Phase 1 already
        // archived the whole block to scrollback at anchorFloor. Paint the
        // BOTTOM lines that fit (anchored so the block's final line lands at
        // newTopRow-1, immediately above the frame), matching scrollback
        // semantics — newest content sits at the bottom; older lines scroll
        // up into history. Top-anchoring instead dropped the block's last
        // line, so a verdict card taller than the room above the live frame
        // rendered with no closing border `╰──╯` (the "cut-off bottom" bug).
        // The dropped top lines stay recoverable via the Phase-1 archive.
        // `capped` (== these same tail lines, via the tail-slice above) is the
        // band we track, so repositionCommittedBand repaints them on resize.
        const room = Math.max(0, newTopRow - anchorFloor);
        const startIdx = Math.max(0, textLines.length - room);
        for (let i = startIdx; i < textLines.length; i++) {
          const row = anchorFloor + (i - startIdx);
          if (row >= newTopRow) break;
          out += eraseAndPaintRow(row, textLines[i]);
        }
      }
      if (out.length > 0) {
        writeWithGuard(() => {
          self.stdout.write(out);
        });
      }
      self.committedBand = capped;
      self.committedBandMeta = cappedMeta;
      self.committedBandBottomRow = newTopRow - 1;
      self.committedBandTopRow = bandTop;
      // The whole `capped` run is materialized: the fits arm CUP-paints all of
      // it above the frame; the overflow arm paints the tail that fits AND
      // Phase 1 already archived the full block to scrollback. Either way no row
      // of `capped` is unpainted-and-unarchived, so nothing is pending here.
      self.committedBandPaintedRows = capped.length;
    } else {
      clearCommittedBand(self);
    }
    } // end else (not useBandHold)
  } else if (useBandHold) {
    // Full-viewport frame (newTopRow <= 1): no above-frame row to paint now, but
    // band-hold is active — the block fits the collapsed screen. Store the model
    // FULLY PENDING; repositionCommittedBand paints it on the next shrink/collapse.
    // committedBandBottomRow = collapsedFrameTop - 1 (NOT a 0 sentinel) lets a
    // subsequent full-viewport commit satisfy overflowPriorContiguous and MERGE.
    // #540: the retained suffix is overflowRun[archiveCount:], the exact
    // complement of Phase 1's logical-boundary-snapped archive (same reasoning
    // as the newTopRow>1 band-hold arm above).
    const model = overflowRun.slice(archiveCount);
    const modelMeta = overflowRunMeta.slice(archiveCount);
    const collapsedFrameTop = Math.max(1, rows - 1 - extraRows);
    self.committedBand = model;
    self.committedBandMeta = modelMeta;
    self.committedBandBottomRow = Math.max(0, collapsedFrameTop - 1);
    self.committedBandTopRow = Math.max(anchorFloor, collapsedFrameTop - model.length);
    // Nothing was painted to the terminal: the whole model is PENDING until
    // repositionCommittedBand materializes it on collapse. If disarm() runs
    // first (Ctrl-C / abort / exit mid-turn), it flushes this pending model to
    // scrollback so the committed block is not lost from screen AND history.
    self.committedBandPaintedRows = 0;
  } else {
    clearCommittedBand(self);
  }
  self.commitInFlight = false;
  self.debugLog('commitAbove:phase3:done');
}

export function clearCommittedBand(self: CommittedBandHost): void {
  self.committedBand = [];
  self.committedBandMeta = [];
  self.committedBandTopRow = 0;
  self.committedBandBottomRow = 0;
  self.committedBandPaintedRows = 0;
  // Explicit reset (also self-invalidates via reflowCommittedBandToWidth's
  // reference check once committedBand is reassigned above, but an empty band
  // never needs a cache entry either way).
  self.bandReflowCache = null;
}

/**
 * Drop the retained above-frame committed band + commit-presence flags
 * WITHOUT tearing down the arm cycle (input core, autocomplete, paste and
 * resize state all stay live). Called from the REPL `/clear` path
 * (clearScreen, bootstrap.ts) so a physical screen wipe also discards the
 * stale transcript band.
 *
 * Invariant: must run BEFORE the `\x1b[3J\x1b[2J\x1b[H` wipe. A band that
 * survives the clear is CUP-painted back onto the freshly-cleared screen by
 * repositionCommittedBand() on the next shrink repaint — e.g. when a
 * slash-command menu opens (overlay grows) then collapses (overlay shrinks),
 * resurrecting the previous session's transcript. Mirrors the band-reset
 * trio in resetState(); see that method for the full disarm semantics.
 */
export function resetCommittedBand(self: CommittedBandHost): void {
  self.hasCommitted = false;
  clearCommittedBand(self);
  self.commitInFlight = false;
}
