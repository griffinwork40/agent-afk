/**
 * Content-hug placement — the `'content-hug'` {@link FramePlacementMode}.
 *
 * Invariant (where blank rows may live): the viewport region
 * [floor, frameTop) is owned by the committed band, and the band is painted
 * top-aligned at `floor` (repositionCommittedBand's stateless render, given a
 * targetBottom of `floor + band.length - 1`). In content-hug mode the live
 * frame therefore sits at `floor + band.length`, directly below the last
 * committed row, until content + frame no longer fit — then it bottom-pins
 * exactly like `'bottom-pinned'` and the existing evict/archive paths take over.
 * The consequence is the whole point: any rows the layout does not need lie
 * BELOW the prompt. A frame shrink moves the prompt up instead of opening a
 * gap between committed content and the prompt (the #2182 cap regression)
 * or above committed content (blank rows that later scroll into history as a
 * permanent scrollback gap). Blank rows below the prompt are overwritten by
 * the next commit before they can ever scroll into history.
 *
 * Contract (commit geometry): commitAbove's routing measures "room above the
 * frame" to decide fit / overflow / band-hold. In content-hug mode the frame
 * is deliberately NOT at the floor, so the room it must use is the room the
 * frame WOULD have if bottom-pinned: `frameTop + slack`, where slack is how
 * far the last-rendered frame bottom sits above `absoluteBottom`. Contiguity
 * checks keep using the ACTUAL frame top (the band is adjacent to it).
 * History: an earlier content-following regime computed room from the real
 * (high) frame top, saw zero room on the first commit, and misrouted it into
 * the overflow path (duplicated echo line + lost card body). Measuring room
 * against the bottom-pinned position is the guard against exactly that.
 *
 * Contract (in-flight commit): commitAbove's Phase 2 repaint runs BEFORE
 * Phase 3 appends the new rows to the band. `pendingContentRows` carries the
 * band length Phase 3 will leave, so Phase 2 places the frame below the rows
 * Phase 3 is about to paint (Phase 3 paints relative to that frame top).
 */

import type { FramePlacementMode } from './terminal-compositor.types.js';

/** State slice the content-hug helpers read. */
export interface ContentHugHost {
  placementMode: FramePlacementMode;
  anchorRow: number | undefined;
  committedBand: string[];
  pendingContentRows: number | null;
  lastMeasuredFrameBottom: number;
  bandGeometryStale: boolean;
}

/**
 * The row the live frame's top should occupy in content-hug mode: the row
 * directly below the committed content. During an in-flight commit this is
 * the post-commit band length (see module Contract).
 */
export function contentHugAnchor(
  self: Pick<ContentHugHost, 'anchorRow' | 'committedBand' | 'pendingContentRows'>,
): number {
  const floor = Math.max(self.anchorRow ?? 1, 1);
  const contentRows = self.pendingContentRows ?? self.committedBand.length;
  return floor + contentRows;
}

/**
 * Rows between the last-rendered frame bottom and the viewport floor
 * (`absoluteBottom`) in content-hug mode — how much further down a
 * bottom-pinned frame would sit. 0 in every other mode, before the first
 * repaint, or while geometry is stale after a resize (fall back to the
 * bottom-pinned routing the caller already implements).
 */
export function contentHugSlack(self: ContentHugHost, absoluteBottom: number): number {
  if (self.placementMode !== 'content-hug') return 0;
  if (self.bandGeometryStale || self.lastMeasuredFrameBottom <= 0) return 0;
  return Math.max(0, absoluteBottom - self.lastMeasuredFrameBottom);
}

/**
 * Content-hug frame target bottom: the frame's top at `anchor`, its bottom
 * `physicalRows - 1` below, clamped to `absoluteBottom` (bottom-pin once the
 * viewport is full). Mirrors cursor-follow's formula with the committed
 * content bottom as the anchor.
 */
export function contentHugTargetBottom(
  anchor: number,
  physicalRows: number,
  absoluteBottom: number,
): number {
  return Math.min(absoluteBottom, anchor - 1 + Math.max(1, physicalRows));
}

/** The placement regime commitAbove flips to on the first commit. */
export function postCommitPlacementMode(self: { readonly contentHug: boolean }): FramePlacementMode {
  return self.contentHug ? 'content-hug' : 'bottom-pinned';
}

/**
 * The committed-band length Phase 3 of this commit will leave (see module
 * Contract: in-flight commit). Mirrors the two Phase-3 arms: band-hold keeps
 * `overflowRun[archiveCount:]`; the band path merges the prior band when it
 * is contiguous with the frame and appends the painted text lines. An
 * over-estimate is safe (it only bottom-pins the frame); the frame never
 * lands above rows Phase 3 paints.
 */
export function projectedBandLength(
  self: { committedBand: string[]; committedBandBottomRow: number },
  geo: { fitsAboveFrame: boolean; frameTop: number; phase1EffectiveFrameTop: number },
  route: { useBandHold: boolean; overflowRun: string[]; archiveCount: number; lineCount: number },
): number {
  if (route.useBandHold) return Math.max(0, route.overflowRun.length - route.archiveCount);
  const priorContiguous =
    geo.fitsAboveFrame &&
    self.committedBand.length > 0 &&
    (self.committedBandBottomRow === geo.frameTop - 1 ||
      self.committedBandBottomRow === geo.phase1EffectiveFrameTop - 1);
  return (priorContiguous ? self.committedBand.length : 0) + route.lineCount;
}

/**
 * Invariant (hide-on-growth, not archive): when a hugging frame grows upward
 * over the band (a full viewport), the covered rows stay in the band model as
 * PENDING instead of being archived to scrollback — exactly like band-hold's
 * commit-time pending rows. Archiving would make them unrecoverable on screen,
 * so the next frame shrink would leave the band short and the prompt would jump
 * up mid-screen on every thinking-preview / tool-card cycle.
 * repositionCommittedBand re-pins the model bottom-aligned (newest rows hug the
 * grown frame, oldest hidden) and repaints them as the frame shrinks. The model
 * stays bounded: band-hold archives beyond maxBandModel on the next commit, the
 * collapse branch of preserveRowsBeforeFrameRender archives genuine overflow
 * once the frame is SETTLED (below), and disarm flushes any remainder
 * (flushPendingCommittedBand).
 *
 * Settled means the frame's room is a capacity worth archiving against. An
 * open autocomplete dropdown or picker is a brief, user-initiated input-region
 * growth: archiving against it would leave the band ~9 rows short when it
 * closes (the prompt jumps up mid-screen), so its covered rows stay pending
 * until it does. A live spinner deliberately does NOT count as unsettled:
 * keeping rows pending for a whole turn hides them from BOTH screen and
 * scrollback (a hole in history — the PTY scenario multi-commit-gap caught
 * exactly this), which is worse than the prompt ending 1–2 rows short of the
 * bottom when the spinner stops. The overlay-empty half of the rule stays with
 * the caller. Returns true outside content-hug (no extra condition).
 */
export function contentHugFrameSettled(self: {
  placementMode: FramePlacementMode;
  inputMode: string;
  renderDropdownRows(): string[];
}): boolean {
  // Outside content-hug the legacy overlay-empty rule alone decides.
  if (self.placementMode !== 'content-hug') return true;
  return self.inputMode !== 'picker' && self.renderDropdownRows().length === 0;
}

/** `pendingContentRows` for commitAbove's Phase-2 repaint: the projected band
 *  length under content-hug, null (no override) in every other mode. */
export function phase2PendingContentRows(
  self: { placementMode: FramePlacementMode } & Parameters<typeof projectedBandLength>[0],
  geo: Parameters<typeof projectedBandLength>[1],
  route: Parameters<typeof projectedBandLength>[2],
): number | null {
  return self.placementMode === 'content-hug' ? projectedBandLength(self, geo, route) : null;
}
