/**
 * Logical-line scrollback archival for the frame-compositor eviction paths.
 *
 * #540 axis-2. All three of `preserveRowsBeforeFrameRender`'s eviction sites
 * (the two `!hasBanner` paths and the banner path) previously shared one
 * mechanism: paint the FULL band top-aligned, then `evictRowsToScrollback(N)`.
 * That single paint did TWO jobs at once — it put the evicted prefix into rows
 * the scroll would carry into history, AND it left the survivors shifted up to
 * hug the new frame top. Elegant, but it forced the prefix into scrollback as
 * pre-wrapped PHYSICAL rows, which a terminal can only ever reflow per-row: on
 * a widen the content stayed hard-wrapped mid-word forever (the reported
 * fragmentation, pinned by the `width-resize-fragment-evict-growth` PTY guard).
 *
 * This module splits those two jobs apart so the archive can emit
 * SOFT-WRAPPABLE logical lines (via `committedBandMeta` + the shared
 * `scrollbackFlushLines` / `buildScrollbackArchiveEscape` helpers, the same
 * pair the band-hold archive and `flushPendingCommittedBand` already use) while
 * the survivors are re-placed by an explicit paint rather than as a side effect
 * of the scroll. Splitting them is what makes the conversion safe: a naive swap
 * that only replaced the emission left the survivors unpainted while the
 * caller's bookkeeping still claimed `committedBandPaintedRows === length`, so
 * rows existed in the model but on neither the screen nor in scrollback — the
 * historical symptom was a verdict card's closing border vanishing on a growth
 * eviction (`verdict-card-overflow.test.ts` guards it).
 */

import type { FrameHost } from './terminal-compositor.frame.js';
import {
  buildScrollbackArchiveEscape,
  eraseAndPaintRow,
  scrollbackFlushLines,
} from './terminal-compositor.scrollback.js';
import { withAutowrapDisabled } from './terminal-compositor.band-reflow.js';

/**
 * Archive the oldest `overflow` rows of the committed band to native scrollback
 * as logical lines, re-place the survivors top-aligned at `floor`, and update
 * the band bookkeeping to match.
 *
 * Contract — on return: `committedBand` / `committedBandMeta` have lost their
 * oldest `overflow` entries (sliced in lockstep, preserving the 1:1 invariant);
 * every surviving row is painted on screen at `[floor, floor + survivors - 1]`;
 * `committedBandPaintedRows === committedBand.length` (no pending rows); and
 * the archived prefix is in native scrollback. Callers must NOT repeat any of
 * that. No-op guard: `overflow <= 0` returns without touching the terminal.
 *
 * `overflow` is a PHYSICAL row count and is load-bearing geometry — it is
 * `bandLen - room`, the exact number of rows that must leave the screen for the
 * survivors to land flush against the incoming frame top. It is therefore NOT
 * snapped to a logical-line boundary the way the band-hold archive snaps its
 * own count: snapping down would leave the band too tall to fit, and snapping
 * up would strand blank rows between the band and the frame (the void class).
 * A logical line straddling the boundary is handled by `scrollbackFlushLines`,
 * which emits the in-prefix rows verbatim so the on-screen tail is never
 * duplicated — that line stays fragmented (today's behaviour), while every
 * line wholly inside the prefix now rejoins on a widen.
 */
export function archiveBandPrefixAndRepaintSurvivors(
  self: FrameHost,
  overflow: number,
  floor: number,
): void {
  if (overflow <= 0) return;
  const bandLen = self.committedBand.length;
  const rows = Math.max(1, self.stdout.rows ?? 24);
  const cols = Math.max(1, self.stdout.columns ?? 80);
  self.debugLog('evict:logical-archive', { overflow, floor, bandLen });

  // External constraint (DECSTBM/DECAWM — these three steps are NOT
  // reorderable). Step 2's scroll displaces screen rows upward, so painting
  // the survivors before it would scroll them straight into history; and the
  // stale band position must be cleared before step 2 paints over it, or
  // un-erased glyphs to the right of a shorter archived line scroll into
  // scrollback verbatim. Hence: erase old position -> archive+scroll -> paint
  // survivors. Write teardown before setup is not an option here because the
  // terminal, not this process, owns the intervening scroll.

  // (1) Erase the band's previous painted footprint, from the geometric floor
  // through the band's bottom row — derived from `floor + bandLen` rather than
  // reading `committedBandBottomRow`, retiring that adjacency-coupling read per
  // #540. The algebra is equivalent (`committedBandBottomRow === floor +
  // bandLen - 1` by the class invariant), but the derivation is geometry-only
  // and cannot be stale.
  let erase = '';
  for (let r = floor; r < floor + bandLen; r++) erase += eraseAndPaintRow(r);

  // (2) Archive the prefix as logical lines. Autowrap stays ON for this write
  // (load-bearing, and the exact opposite of the on-screen band paint in step
  // 3): the terminal must own the intra-line wrap so its continuation rows are
  // soft-wrap continuations that rejoin when the width changes. The write goes
  // through the full-screen scroll-region guard for the same reason
  // `evictRowsToScrollback` does — with a StatusLine the DECSTBM region is a
  // SUB-region, and a `\n` at its bottom margin scrolls that sub-region, so the
  // displaced line exits without ever entering scrollback.
  const archiveLines = scrollbackFlushLines(self.committedBand, self.committedBandMeta, overflow);
  const archive = buildScrollbackArchiveEscape(archiveLines, floor, rows, cols);
  const writeArchive = (): void => {
    try {
      self.stdout.write(erase + archive);
    } catch (err) {
      self.debugLog('evict:error', { msg: (err as Error)?.message ?? String(err) });
      // Stdout closed mid-render (process exit / terminal hangup); the next
      // render() fails too and the surface lifecycle tears us down.
    }
  };
  if (self.scrollRegion !== undefined) {
    self.scrollRegion.withFullScrollRegion(writeArchive);
  } else {
    writeArchive();
  }

  // (3) Re-place the survivors. The scroll in step 2 left their rows holding
  // displaced content, so they must be painted explicitly — this is the job the
  // old full-band paint did implicitly, and dropping it is what regressed the
  // verdict-card border. Autowrap is disabled here (band rows are already
  // hard-wrapped to the current width by repaint()'s reflowCommittedBandToWidth,
  // so this defends against a residual ±1-column displayWidth() gap on
  // ambiguous-width glyphs fabricating a phantom row).
  const survivors = self.committedBand.slice(overflow);
  if (survivors.length > 0) {
    let paint = '';
    for (let i = 0; i < survivors.length; i++) paint += eraseAndPaintRow(floor + i, survivors[i]);
    withAutowrapDisabled(self.stdout, () => {
      try {
        self.stdout.write(paint);
      } catch {
        /* terminal closed mid-render — lifecycle tears us down on next render */
      }
    });
  }

  // (4) Bookkeeping. Honest by construction now: every survivor was painted
  // above, so none are pending. Meta slices in lockstep to hold the 1:1
  // band<->meta invariant the reflow and logical-flush sites rely on.
  self.committedBand = survivors;
  self.committedBandMeta = self.committedBandMeta.slice(overflow);
  self.committedBandTopRow = floor;
  self.committedBandBottomRow = floor + survivors.length - 1;
  self.committedBandPaintedRows = survivors.length;
}
