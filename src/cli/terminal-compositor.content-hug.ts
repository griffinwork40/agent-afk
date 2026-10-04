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
 * frame WOULD have if bottom-pinned: `prevTopRow + hugSlack` (where hugSlack
 * is how far the last-rendered frame bottom sits above `absoluteBottom`).
 * Contiguity checks keep using the ACTUAL frame top (the band is adjacent to it).
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
 * Invariant (archive-and-retain, 2026-10-03): when a hugging frame grows upward
 * over the band (a full viewport), the covered rows are archived to scrollback
 * on that repaint, and rows committed while the overlay is tall are archived
 * on the next one (preserveRowsBeforeFrameRender / pendingEvictionAllowed), so
 * history never has a hole. They are ALSO retained in the band model as the
 * archived prefix (terminal-compositor.band-archived-prefix.ts), hidden while
 * covered and re-shown when the frame shrinks, so the screen refills instead
 * of leaving a blank gap below the prompt. They are never written to
 * scrollback twice; while re-shown they exist at the scrollback tail and on
 * screen (the seam overlap, docs/scrollback.md).
 * History: pre-#2804 they stayed PENDING only (a hole at the scrollback seam
 * for the rest of the turn); #2804 archived and DROPPED them (a blank gap
 * below the prompt after the collapse). Repros:
 * terminal-compositor.history-hole.repro.test.ts and
 * terminal-compositor.shrink-gap-ghost.repro.test.ts.
 *
 * Settled means the frame's room is a capacity worth archiving against. An
 * open autocomplete dropdown or picker is a brief, user-initiated input-region
 * growth: archiving against it would leave the band ~9 rows short when it
 * closes (the prompt jumps up mid-screen), so its covered rows stay pending
 * until it does. A live spinner deliberately does NOT count as unsettled:
 * keeping rows pending for a whole turn hides them from BOTH screen and
 * scrollback (a hole in history — the PTY scenario multi-commit-gap caught
 * exactly this), which is worse than the prompt ending 1–2 rows short of the
 * bottom when the spinner stops. The overlay-empty half of the rule applies to
 * bottom-pinned only and lives in the caller (frame-preserve.ts
 * pendingEvictionAllowed). Returns true outside content-hug (no extra condition).
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

/**
 * Invariant (band reserve): in content-hug mode, when a large overlay causes
 * the hugging frame to rise over the committed band, the covered rows go PENDING
 * (hidden from both screen and scrollback) rather than being archived. The
 * newest committed output — including the user's prompt echo — therefore
 * disappears for the whole duration of a fan-out. Reducing the overlay budget
 * by this reserve shortens trimmedOverlay and therefore the frame, keeping the
 * newest band rows on screen. The existing pending/re-pin machinery adapts
 * without further changes.
 *
 * The reserve is `Math.min(committedBand.length, Math.max(3, Math.floor(rows / 4)))`:
 * - `Math.floor(rows / 4)` gives roughly a quarter of the terminal height, which
 *   is enough to keep the prompt echo plus surrounding context visible.
 * - The floor of 3 ensures at least 3 rows are reserved on very small terminals.
 * - The cap at `committedBand.length` prevents reserving more rows than exist in
 *   the band (no-op when the band is empty).
 *
 * Decision — pendingContentRows vs committedBand.length: `pendingContentRows` is
 * the projected post-commit band length during an in-flight commit (Phase 2); it
 * is non-null only inside commitAbove and captures rows about to be painted, not
 * yet visible. Using it here would over-reserve during the Phase 2 repaint and
 * under-reserve between commits (null → 0). committedBand.length is the already-
 * painted, always-available band length, which is exactly the set of rows at risk
 * of going pending — the correct basis for this reserve.
 *
 * Known limit: band rows older than the reserve can still go pending during a
 * fan-out whose overlay exceeds (avail - reserve). Only the newest `reserve` rows
 * are guaranteed to stay visible.
 *
 * Returns 0 outside content-hug (no-op for all other placement modes).
 */
export function contentHugBandReserve(
  self: Pick<ContentHugHost, 'placementMode' | 'committedBand'>,
  rows: number,
): number {
  if (self.placementMode !== 'content-hug') return 0;
  const bandLen = self.committedBand.length;
  if (bandLen === 0) return 0;
  return Math.min(bandLen, Math.max(3, Math.floor(rows / 4)));
}
