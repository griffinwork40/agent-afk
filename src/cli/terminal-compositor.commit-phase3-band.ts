import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';
import type { CommitGeometry } from './terminal-compositor.commit-geometry.js';
import type { CommitRoute } from './terminal-compositor.commit-route.js';
import { eraseAndPaintRow } from './terminal-compositor.scrollback.js';
import { writeWithScrollGuard } from './terminal-compositor.commit-guard.js';
import { clearCommittedBand } from './terminal-compositor.committed-band-commit.js';

/**
 * Classic (non-band-hold) Phase 3 for newTopRow > 1: merge/cap/orphan-erase/paint
 * the committed band run.
 *
 * Invariant: committedBand tracks the FULL contiguous on-screen committed
 * run occupying [committedBandTopRow, newTopRow - 1] adjacent to the frame
 * top — NOT just the most-recent block. repositionCommittedBand re-pins
 * the band against the frame on a shrink; tracking only the latest block
 * let a large collapse re-pin that one block while OLDER on-screen blocks
 * stayed stranded high — the "massive gap" between scrollback and the live
 * frame. Tracking the whole run re-pins all of it, keeping it contiguous.
 *
 * The prior band is merged with the new lines ONLY when verifiably
 * contiguous with them. In the fitsAboveFrame path Phase 1 scrolled
 * `bandOverflow` rows (0 when the band has room to grow, otherwise
 * exactly the number of oldest band lines that no longer fit), so the
 * maintained invariant keeps the prior band's bottom one row above the
 * frame top — verified by the stale, pre-commit committedBandBottomRow ===
 * newTopRow - 1, the prior band's bottom sits exactly one row above this
 * block's top. anchorRow <= 1 keeps the merge sound (no mid-commit anchor-
 * ceiling evict could have shifted the tracked bottom). Otherwise (frame
 * resized between commits, anchor-ceiling evict, or the overflow
 * !fitsAboveFrame path) fall back to single-block tracking.
 */
export function commitPhase3Band(
  self: CommittedBandHost,
  geo: CommitGeometry,
  route: CommitRoute,
  newTopRow: number,
  maxRun: number,
  postScrollFloor: number,
): void {
  const { fitsAboveFrame, anchorFloor, phase1EffectiveFrameTop } = geo;
  const { textLines, textMeta, lineCount } = route;

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
      writeWithScrollGuard(self, () => {
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

  // suppress unused warning — lineCount is needed for the band-paint path
  void lineCount;
}
