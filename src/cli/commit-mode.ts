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
  /** Prior band carries rows never painted on screen because the held overlay left only `room` rows visible. */
  overflowHasPending: boolean;
  /** Route this commit through the band-hold path (hold in the model; don't archive + truncate). */
  useBandHold: boolean;
}

/**
 * Decide how a `commitAbove` block is routed: the single-copy fits path, the
 * band-hold path, or (by returning neither flag) the legacy overflow archive.
 *
 * `fitsAboveFrame` — the block fits `[anchorFloor, frameTop)`, so Phase 1
 * scrolls only the band overflow and Phase 3 paints the one copy. Gated on
 * `prevTopRow > 1` (BLOCKER-1, review #592): only then is the real frame top
 * known. When `prevTopRow <= 1` the live frame already fills the viewport, so
 * the `frameTop` fallback would overestimate the above-frame room — the fits
 * path genuinely needs a known frame top.
 *
 * `useBandHold` — keep a block that overflows the CURRENT (tall) frame but
 * fits the COLLAPSED screen in the band model rather than archiving it to
 * scrollback + painting a truncated on-screen copy (the legacy overflow path's
 * duplicate header + orphan divider + blank "void"). Two ways to enter:
 *
 *  • `overflowRun.length <= maxBandModel && !fitsAboveFrame` — the merged run
 *    still fits a collapsed screen but not the current room. Band-hold routing
 *    is deliberately NOT gated on `prevTopRow > 1` (H1, review #649): when
 *    `prevTopRow <= 1` the block is HELD in the model and painted by
 *    repositionCommittedBand() on collapse, NOT dropped down the overflow path.
 *
 *  • `overflowHasPending` — once the prior band carries PENDING rows (rows in
 *    the model never painted because the held overlay left only `room` visible),
 *    the commit MUST stay on band-hold even when the merged run exceeds
 *    maxBandModel (review #649 P1). The fits path scrolls from
 *    `committedBand.length`, which counts those pending rows; routing there
 *    would scroll unpainted blanks into scrollback while Phase 3's cap drops the
 *    real rows. Band-hold Phase 1 instead archives the genuine overflow (the
 *    oldest rows beyond what the collapsed screen holds) as REAL content.
 *
 * A block taller than the collapsed screen with no pending rows
 * (`overflowRun.length > maxBandModel`, `!overflowHasPending`) takes neither
 * flag and falls through to the legacy overflow archive (recoverable).
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
  } = input;

  const fitsAboveFrame = prevTopRow > 1 && lineCount <= frameTop - anchorFloor;

  const room = Math.max(0, frameTop - anchorFloor);
  const overflowTargetBottom = Math.max(1, rows - 1 - extraRows);
  const maxBandModel = Math.max(0, overflowTargetBottom - anchorFloor);
  const overflowPriorContiguous =
    committedBand.length > 0 && anchorRow <= 1 && committedBandBottomRow === frameTop - 1;
  const overflowRun = overflowPriorContiguous ? [...committedBand, ...textLines] : textLines;
  const overflowHasPending = overflowPriorContiguous && committedBand.length > room;
  const useBandHold =
    overflowHasPending || (overflowRun.length <= maxBandModel && !fitsAboveFrame);

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
