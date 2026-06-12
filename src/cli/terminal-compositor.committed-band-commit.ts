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

import type { LogUpdateFn, CompositorScrollRegionGuard } from './terminal-compositor.types.js';

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
  committedBandTopRow: number;
  committedBandBottomRow: number;
  /** Most-recent committed block covered by a full-viewport frame, awaiting
   *  re-pin on the next collapse (see {@link repositionCommittedBand}). */
  coveredBand: string[];
  /** Re-entrancy guard: suppresses a repaint during the clear→write window. */
  committing: boolean;
  /** Suppresses the shrink re-pin (repositionCommittedBand) for a commit. */
  commitInFlight: boolean;
  /** Whether any commit has happened this arm cycle (guards growthDeficit). */
  hasCommitted: boolean;
  /** Pre-resize on-screen footprint to physically erase on the next repaint. */
  pendingResizeErase: { top: number; bottom: number } | null;
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
  const newlineCount = (stripped.match(/\n/g)?.length ?? 0);
  const logicalLineCount = Math.max(1, newlineCount + 1);
  // Physical (wrap-aware) row count. A committed line wider than the terminal
  // soft-wraps to >1 physical row, so the LOGICAL count (newlines+1) under-counts
  // the rows the block actually occupies. That under-count made Phase 1 scroll too
  // few rows (LF×lineCount) — stranding wrapped overflow rows on screen — and
  // mis-sized fitsAboveFrame / bandOverflow. Mirror the frame side (a7ace49 / #39),
  // which derives its geometry from CupFrameRenderer.measure()'s physical row count
  // via the shared wrapToPhysicalLines helper; reuse the same measure() here so the
  // band and frame can't drift. (a7ace49 flagged this site as the tracked follow-up:
  // "commitAbove()'s lineCount is still logical — a separate wrap-blind site.")
  // Logical fallback for stubs without measure().
  const lineCount = self.logUpdate.measure
    ? Math.max(1, self.logUpdate.measure(stripped, rows).lineCount)
    : logicalLineCount;
  const textLines = stripped.split('\n');

  const extraRows = self.scrollRegion?.getExtraRows() ?? 0;
  // Invariant (one geometry per commit): the room/scroll/band math below must
  // measure the frame at the position Phase 2's repaint will ACTUALLY use.
  // Frame placement runs in two regimes (terminal-compositor.frame.ts ~236):
  // banner-following while `hasBanner && !commitInFlight` (idle frame sits
  // just below the banner / band), bottom-anchored during a commit. With a
  // banner and an EMPTY band the idle frame banner-follows at ~anchorRow, so
  // capturing prevTopRow from that regime reports zero above-frame room and
  // misroutes the commit into the overflow path — Phase 1 then "archives" the
  // block ON SCREEN at anchorFloor (an untracked orphan, not scrollback),
  // Phase 3 paints a second copy at anchorFloor while recording the band at
  // the bottom-anchored rows, and the next commit's merge repaints a third —
  // the first-turn "echo first line duplicated + card body lost" bug. Flip
  // into the commit regime FIRST (clear the banner-followed frame, repaint at
  // the bottom-anchored position) so every phase sees one geometry. Band
  // non-empty ⇒ contentFloor = committedBandBottomRow keeps idle placement
  // bottom-consistent already ⇒ skip (no extra clear/repaint flicker on the
  // steady-state per-commit path). repositionCommittedBand is suppressed
  // under commitInFlight (committed-band-repin.ts:72) and the band is empty
  // here anyway; commitInFlight is re-set below and reset at Phase 3's end.
  if (self.anchorRow !== undefined && self.anchorRow > 1 && self.committedBand.length === 0) {
    self.commitInFlight = true;
    self.logUpdate.clear(extraRows);
    self.repaint();
  }
  // Decide where the committed text is written so it lands in scrollback
  // EXACTLY ONCE. Capture the live frame's top row BEFORE clear() resets it:
  // every frame mutation (setOverlay, setSpinner, keypress) repaints
  // synchronously — and the regime-sync above re-ran placement for the
  // banner-followed case — so `topRow` reflects the frame Phase 2's repaint
  // will reproduce. `capacity` is the number of rows available to DISPLAY
  // committed text above the frame, between the pre-arm content ceiling
  // (anchorRow) and the frame top.
  const prevTopRow = self.logUpdate.topRow ?? 0;
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
  const fitsAboveFrame = prevTopRow > 1 && lineCount <= frameTop - anchorFloor;

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
      if (fitsAboveFrame) {
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
    const newPainted = Math.min(textLines.length, maxRun);
    if (newPainted > 0) {
      // Tail-slice (not head): when the block is taller than the above-frame
      // room (overflow path, newPainted < lineCount), keep the LAST lines. A
      // block's final line — e.g. a verdict card's closing border `╰──╯` and
      // its affordance — must survive, not its opening line; dropping the
      // bottom left boxes rendered un-closed. In the fits path newPainted ===
      // lineCount, so this is the whole array (no behavior change there).
      const newLines = textLines.slice(textLines.length - newPainted);
      // "Whole block painted" = newPainted === textLines.length (no lines
      // dropped to overflow). Compare against textLines.length, NOT lineCount:
      // lineCount is the WRAP-AWARE physical row count (measure()), which
      // diverges from the logical-line array length whenever a block has a
      // trailing blank line (`\n\n` → split yields a trailing "") or a wrapped
      // line. Using lineCount here wrongly failed the contiguity check on every
      // `\n\n`-terminated commit, suppressing the merge and stranding the prior
      // band as a single overwritten block (lost commits) — the splice
      // regression. newPainted is itself derived from textLines.length.
      const wholeBlockPainted = newPainted === textLines.length;
      const contiguousPriorBand =
        fitsAboveFrame &&
        wholeBlockPainted &&
        self.committedBand.length > 0 &&
        self.committedBandBottomRow === newTopRow - 1;
      const run = contiguousPriorBand ? [...self.committedBand, ...newLines] : newLines;
      // Cap at the room between the anchor floor and the frame top. maxRun >=
      // newPainted always (the new lines fit by construction), so they are
      // never dropped; only prior-band lines that scroll above the floor are.
      const capped = run.length > maxRun ? run.slice(run.length - maxRun) : run;
      const bandTop = newTopRow - capped.length;
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
        for (let i = 0; i < capped.length; i++) {
          const row = bandTop + i;
          if (row >= newTopRow) break; // Never overwrite the live frame.
          out += `\x1b[${row};1H\x1b[2K${capped[i] ?? ''}`;
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
          out += `\x1b[${row};1H\x1b[2K${textLines[i] ?? ''}`;
        }
      }
      if (out.length > 0) {
        writeWithGuard(() => {
          self.stdout.write(out);
        });
      }
      self.committedBand = capped;
      self.committedBandBottomRow = newTopRow - 1;
      self.committedBandTopRow = bandTop;
      // An on-screen band is now authoritative — any previously covered block is
      // stale (this commit supersedes it).
      self.coveredBand = [];
    } else {
      clearCommittedBand(self);
    }
  } else {
    // No above-frame area: the frame fills the viewport (newTopRow ≤ 1) or
    // nothing has rendered yet. The block is already in scrollback (Phase 1's
    // overflow archive). Rather than DROP it, PARK it in coveredBand so the
    // moment the overlay collapses repositionCommittedBand re-pins it adjacent
    // to the frame — without this the band is empty on collapse and
    // CupFrameRenderer shrink-pads blank rows nothing refills (the "massive
    // blank gap" in big-gap.txt). Cap to the viewport height; the re-pin caps
    // again to the real above-frame room. clearCommittedBand() resets coveredBand
    // first, so set it AFTER. (newTopRow ≤ 1 ⇒ nothing rendered yet has no block
    // to park — textLines is the just-committed content either way.)
    clearCommittedBand(self);
    if (newTopRow <= 1 && textLines.length > 0) {
      const cap = Math.max(1, rows - 1);
      self.coveredBand = textLines.length > cap ? textLines.slice(textLines.length - cap) : textLines;
    }
  }
  self.commitInFlight = false;
  self.debugLog('commitAbove:phase3:done');
}

export function clearCommittedBand(self: CommittedBandHost): void {
  self.committedBand = [];
  self.committedBandTopRow = 0;
  self.committedBandBottomRow = 0;
  // Drop any covered-but-retained content too: every clear path (disarm, /clear,
  // resetCommittedBand, fits-path empties) means there is no longer a band to
  // re-pin, so a stale coveredBand must not resurrect old transcript on the next
  // shrink. Sites that intentionally PARK content in coveredBand set it AFTER
  // calling this (commitAbove's full-viewport branch).
  self.coveredBand = [];
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
