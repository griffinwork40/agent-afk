/**
 * Physical row positioning for the terminal compositor frame.
 *
 * Extracted from `terminal-compositor.frame.ts` to isolate the concern of
 * mapping logical frame content to physical terminal rows — separate from
 * viewport-budget computation (frame.layout.ts) and line assembly
 * (frame.lines.ts).
 *
 * Pure functions — no side effects, no mutations to FrameHost state.
 * All row values are 1-based terminal row numbers.
 */

import type { LogUpdateFn, FramePlacementMode } from './terminal-compositor.types.js';

export interface FramePosition {
  /** The physical terminal row where the frame's top line will be rendered. */
  desiredTopRow: number;
  /** The physical terminal row where the frame's bottom line will be rendered. */
  targetBottomRow: number;
  /** Post-hard-wrap physical line count of the assembled frame content. */
  physicalRows: number;
}

/**
 * Compute the physical terminal row positions for a frame render.
 *
 * Accounts for:
 * - Post-hard-wrap row count (CupFrameRenderer wraps at stdout.columns — a
 *   logical line wider than the terminal occupies 2+ physical rows; using the
 *   logical count would under-count targetBottomRow, overlapping the DECSTBM
 *   reserved footer — see issue #592 and the LoopStageBar repaint race).
 * - Placement mode (cursor-follow vs bottom-pinned): cursor-follow positions
 *   the frame just below `anchorRow` on fresh sessions; bottom-pinned (active
 *   once `hasCommitted` is true) always pins to `absoluteBottom`.
 * - `measure()` consolidation: `lineCount` is targetBottomRow-independent, so
 *   one `measure()` call gives `lineCount`; `targetBottomRow` and
 *   `desiredTopRow` are derived arithmetically without a second wrap pass.
 *
 * @param frame          Assembled frame string (lines joined with '\n').
 * @param frameLines     Logical lines array (used as fallback when measure absent).
 * @param absoluteBottom Hard row ceiling: compositor must never write below this.
 * @param placementMode  'cursor-follow' | 'bottom-pinned'.
 * @param anchorRow      Optional upper anchor (cursor-follow only).
 * @param logUpdate      Log-update function with optional `measure()`.
 */
export function computeFramePosition(
  frame: string,
  frameLines: string[],
  absoluteBottom: number,
  placementMode: FramePlacementMode,
  anchorRow: number | undefined,
  logUpdate: LogUpdateFn,
): FramePosition {
  // Invariant (wrap-aware frame height): physicalRows must reflect the
  // POST-wrap row count — not just frameLines.length (the logical count).
  // CupFrameRenderer hard-wraps at stdout.columns, so a single logical input
  // line wider than the terminal occupies 2+ physical rows. Using the logical
  // count in cursor-follow mode under-counts targetBottomRow by the extra
  // wrapped rows, causing the frame to overlap the DECSTBM reserved footer
  // band (LoopStageBar). Each spinner-tick repaint then writes the frame at
  // the wrong position, and the footer bar's "· idle" CUP-paint lands inside
  // the frame region — producing a cascade of duplicate idle lines that push
  // content into scrollback. measure() returns the physical (post-wrap) line
  // count; when unavailable, fall back to the logical count (safe for stubs
  // and tests that don't wrap).
  //
  // Consolidation: lineCount is targetBottomRow-independent (it depends only
  // on content and terminal width), so we call measure() once with any valid
  // targetBottomRow to get lineCount, compute the real targetBottomRow from
  // it, then derive desiredTopRow arithmetically — avoiding a second full
  // wrap pass.
  const logicalRows = frameLines.length;
  const physicalRows = logUpdate.measure
    ? logUpdate.measure(frame, absoluteBottom).lineCount
    : logicalRows;
  // Invariant: the input frame is bottom-pinned (targetBottomRow ===
  // absoluteBottom) once committed content exists. On a FRESH session
  // (placementMode === 'cursor-follow', no committed content yet), the frame
  // instead sits just below the banner so the prompt appears directly under
  // the welcome art — no large empty gap.
  //
  // Contract: cursor-follow computes targetBottomRow as
  //   min(absoluteBottom, anchorRow + physicalRows - 1)
  // so a 1-line idle frame lands at anchorRow (right below the banner) while
  // a multi-line frame (dropdown open) extends downward toward absoluteBottom.
  const targetBottomRow =
    placementMode === 'cursor-follow' && anchorRow !== undefined
      ? Math.min(absoluteBottom, (anchorRow - 1) + physicalRows)
      : absoluteBottom;
  // Wrap-aware top row: derived from the same physicalRows (lineCount) already
  // computed above — equivalent to measure().topRow but without a second wrap
  // pass. Stubs without measure() fall back to logical.
  const desiredTopRow = logUpdate.measure
    ? Math.max(1, targetBottomRow - physicalRows + 1)
    : Math.max(1, targetBottomRow - frameLines.length + 1);
  return { desiredTopRow, targetBottomRow, physicalRows };
}
