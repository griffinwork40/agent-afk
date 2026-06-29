/**
 * Pure routing/geometry helpers for `TerminalCompositor.commitAbove`.
 *
 * Extracted so the band-hold routing decision and the band-model cap can be
 * unit-tested WITHOUT driving a real (or `@xterm/headless`) terminal: no side
 * effects, no `this`, every input is a scalar or array and every result is a
 * plain value. The escape-sequence emission and frame state stay in
 * `terminal-compositor.ts`; only the "what should this commit do" arithmetic
 * lives here. Full root cause + design: docs/scrollback.md and the regression
 * suites terminal-compositor.overflow-gap.test.ts / .h1-prevtoprow.test.ts.
 */

/** Everything `decideCommitMode` needs, lifted out of the compositor's state. */
export interface CommitModeInput {
  /** Live frame top row captured BEFORE clear() (`logUpdate.topRow ?? 0`). */
  prevTopRow: number;
  /** Effective frame top: `prevTopRow > 1 ? prevTopRow : max(1, rows-1-extraRows)`. */
  frameTop: number;
  /** Content ceiling above which nothing is painted (`max(anchorRow ?? 1, 1)`). */
  anchorFloor: number;
  /** Raw anchor row (`anchorRow ?? 1`) — gates band-merge soundness (must be ≤1). */
  anchorRow: number;
  /** Physical-row count of the block being committed (wrap-aware). */
  lineCount: number;
  /** The block's visual rows (already hard-wrapped to the terminal width). */
  textLines: string[];
  /** Terminal height in rows. */
  rows: number;
  /** Reserved status-line rows below the frame. */
  extraRows: number;
  /** Current on-screen committed band model. */
  committedBand: string[];
  /** Tracked bottom row of the committed band (0 when unset). */
  committedBandBottomRow: number;
  /**
   * How many of `committedBand`'s rows are MATERIALIZED on the terminal now
   * (always the bottom suffix nearest the frame). The complementary prefix
   * `committedBand.slice(0, length - committedBandPaintedRows)` is PENDING —
   * held only in the in-memory band model, never painted, never archived.
   * Drives the EXACT `overflowHasPending` signal (see decideCommitMode).
   */
  committedBandPaintedRows: number;
}

/** The routing decision + the geometry the caller's phases consume. */
export interface CommitMode {
  /** Single-copy fits path: block fits `[anchorFloor, frameTop)` and the frame top is known. */
  fitsAboveFrame: boolean;
  /** Above-frame rows currently available to paint into. */
  room: number;
  /** Bottom row a collapsed-frame band can occupy. */
  overflowTargetBottom: number;
  /** Max band-model rows that can ever show above a minimal frame. */
  maxBandModel: number;
  /** Prior band verifiably contiguous with the frame top (safe to merge). */
  overflowPriorContiguous: boolean;
  /** Prior band + new lines (merged when contiguous, else just the new lines). */
  overflowRun: string[];
  /** Prior band carries rows never painted on screen (`committedBandPaintedRows < committedBand.length`) — held only in the model, not on screen, not in scrollback. */
  overflowHasPending: boolean;
  /** Route this commit through the band-hold path (hold in the model; don't archive + truncate). */
  useBandHold: boolean;
}

/**
 * Decide how a `commitAbove` block is routed: the single-copy fits path or the
 * band-hold path. The legacy overflow archive (returning neither flag) is now
 * only reached when `maxBandModel === 0` (degenerate 1-row terminal with a
 * full-height anchor), which is effectively unreachable in practice.
 *
 * `fitsAboveFrame` — the block fits `[anchorFloor, frameTop)`, so Phase 1
 * scrolls only the band overflow and Phase 3 paints the one copy. Gated on
 * `prevTopRow > 1` (BLOCKER-1, review #592): only then is the real frame top
 * known. When `prevTopRow <= 1` the live frame already fills the viewport, so
 * the `frameTop` fallback would overestimate the above-frame room — the fits
 * path genuinely needs a known frame top.
 *
 * `useBandHold` — keep a block in the band model rather than archiving it to
 * scrollback + painting a truncated on-screen copy (the legacy overflow path's
 * duplicate header + orphan divider + blank "void"). Four ways to enter:
 *
 *  • `overflowRun.length <= maxBandModel && !fitsAboveFrame` — the merged run
 *    still fits a collapsed screen but not the current room. Band-hold routing
 *    is deliberately NOT gated on `prevTopRow > 1` (H1, review #649): when
 *    `prevTopRow <= 1` the block is HELD in the model and painted by
 *    repositionCommittedBand() on collapse, NOT dropped down the overflow path.
 *
 *  • `textLines.length <= maxBandModel && !fitsAboveFrame` — the NEW block alone
 *    fits a collapsed screen even though the MERGED run (prior painted band +
 *    new block) does not. Hold the new block whole; Phase 1 archives the genuine
 *    overflow (the oldest prior-band rows beyond maxBandModel) to scrollback as
 *    REAL content, and capBandModel keeps the newest maxBandModel rows — the
 *    same machinery the `overflowHasPending` arm relies on. Without this clause,
 *    two blocks that each fit on their own (e.g. two markdown tables committed
 *    under one tall overlay) push the merged run over maxBandModel with no
 *    pending rows, drop to the legacy overflow path, and the NEWER block is
 *    split: its header is archived to scrollback while a truncated, border-less
 *    copy paints on screen with a blank "void" above it — the recurring "second
 *    table renders broken / missing lines" bug
 *    (terminal-compositor.two-table-final.test.ts).
 *
 *  • `overflowHasPending` — once the prior band carries PENDING rows (rows held
 *    in the model but never painted: `committedBandPaintedRows < committedBand
 *    .length`), the commit MUST stay on band-hold even when the merged run
 *    exceeds maxBandModel (review #649 P1). The fits path scrolls from
 *    `committedBand.length`, which counts those pending rows; routing there
 *    would scroll unpainted blanks into scrollback while Phase 3's cap drops the
 *    real rows. Band-hold Phase 1 instead archives the genuine overflow (the
 *    oldest rows beyond what the collapsed screen holds) as REAL content. This
 *    test compares the EXACT painted-row count, NOT the `room` geometry proxy
 *    (`committedBand.length > room`): after a single intervening repaint grew
 *    `room` past the band length while pending rows remained, the proxy read
 *    false and dropped them (the two-block follow-up deferred from PR #255).
 *
 *  • `!fitsAboveFrame && maxBandModel > 0` (the over-tall case) — a block
 *    taller than the collapsed screen is ALSO routed through band-hold. The
 *    commit-time `maxBandModel` estimate can exceed the true collapse paint
 *    capacity `maxFit` (= `targetBottom - floor + 1` in
 *    `repositionCommittedBand`), because `maxFit` accounts for the REAL
 *    collapsed frame height (input + gap + spinner + status rows) while
 *    `maxBandModel` measures against a 1-row minimal frame. The excess
 *    ("pending overflow") would be silently dropped if left as pure pending:
 *    `repositionCommittedBand` can only paint `fit` rows and the remainder
 *    is neither painted nor archived. `preserveRowsBeforeFrameRender` handles
 *    this: on collapse (desiredTopRow >= prevTopRow, overlay settling lower)
 *    it detects the pending overflow, paints the full model top-aligned, then
 *    `evictRowsToScrollback` moves the oldest `overflow = bandLen - room` rows
 *    into scrollback as REAL content before the re-pin — so every committed
 *    row lands in scrollback or the viewport, never dropped.
 *
 * `overflowRun` merges the prior band into the new lines only when verifiably
 * contiguous with the frame top (`overflowPriorContiguous`) — otherwise a
 * resize / anchor-evict moved it and adjacency cannot be assumed.
 */
export function decideCommitMode(input: CommitModeInput): CommitMode {
  const {
    prevTopRow,
    frameTop,
    anchorFloor,
    anchorRow,
    lineCount,
    textLines,
    rows,
    extraRows,
    committedBand,
    committedBandBottomRow,
    committedBandPaintedRows,
  } = input;

  const fitsAboveFrame = prevTopRow > 1 && lineCount <= frameTop - anchorFloor;

  const room = Math.max(0, frameTop - anchorFloor);
  const overflowTargetBottom = Math.max(1, rows - 1 - extraRows);
  const maxBandModel = Math.max(0, overflowTargetBottom - anchorFloor);
  const overflowPriorContiguous =
    committedBand.length > 0 && anchorRow <= 1 && committedBandBottomRow === frameTop - 1;
  const overflowRun = overflowPriorContiguous ? [...committedBand, ...textLines] : textLines;
  const overflowHasPending =
    overflowPriorContiguous && committedBand.length > committedBandPaintedRows;
  // Invariant (band-hold coverage): route ALL !fitsAboveFrame cases through
  // band-hold when maxBandModel > 0. The over-tall case (overflowRun.length >
  // maxBandModel) is now included — Phase 1 archives the genuine overflow
  // (oldest rows beyond maxBandModel) to scrollback as REAL content, and
  // preserveRowsBeforeFrameRender evicts the pending-band excess at collapse
  // time so every committed row ends up in scrollback or the viewport. Without
  // this clause the legacy overflow path archived the whole block but left
  // committedBand empty, so repositionCommittedBand had nothing to re-pin when
  // the overlay collapsed — the freed viewport rows stayed blank (the
  // "end-of-turn viewport void" bug, terminal-compositor.endturn-overflow-gap).
  const useBandHold = overflowHasPending || (!fitsAboveFrame && maxBandModel > 0);

  return {
    fitsAboveFrame,
    room,
    overflowTargetBottom,
    maxBandModel,
    overflowPriorContiguous,
    overflowRun,
    overflowHasPending,
    useBandHold,
  };
}

/**
 * Cap a band-hold run to its newest `max` rows — the rows that can ever show
 * above a minimal (collapsed) frame. A run longer than `max` keeps its suffix
 * (the most-recent rows); the older prefix is dropped here because the caller's
 * Phase-1 band-hold branch has already archived those rows to scrollback as
 * real content. Returns the run unchanged when it already fits.
 */
export function capBandModel(run: string[], max: number): string[] {
  return run.length > max ? run.slice(run.length - max) : run;
}
