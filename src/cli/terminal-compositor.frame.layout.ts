/**
 * Viewport-budget computation for the frame compositor.
 *
 * Extracted from `terminal-compositor.frame.ts` to isolate the band-layout
 * concern: given the current terminal dimensions and chrome rows (spinner,
 * tip, attachment), compute the maximum overlay lines that fit and whether a
 * visual gap row is needed between chrome and the input cluster.
 *
 * Pure functions — no side effects, no mutations to FrameHost state.
 */

import { palette } from './palette.js';
import { renderStatusLine, type ImageAttachment } from './input/attachments.js';
import type { SpinnerController } from './input/spinner.js';
import type { CompositorScrollRegionGuard } from './terminal-compositor.types.js';

export interface ChromeRows {
  overlayLines: string[];
  spinnerRow: string | null;
  tipRow: string | null;
  attachmentRow: string | null;
}

/**
 * Gather the chrome rows that stack above the input cluster (overlay lines,
 * spinner, tip, attachment/clipboard-failure notice).
 *
 * The clipboard-failure message is consumed here (set to `null` on the host
 * ref) so it clears after one repaint, matching the original behaviour. Callers
 * must forward the returned `attachmentRow` to the frame-line assembler rather
 * than re-reading the host field.
 */
export function gatherChromeRows(
  overlay: string,
  spinnerController: SpinnerController,
  attachments: ImageAttachment[],
  clipboardFailureMsgRef: { value: string | null },
  cols: number,
): ChromeRows {
  const overlayLines = overlay ? overlay.split('\n') : [];
  const spinnerRow = spinnerController.renderSpinnerRow();
  const tipRow = spinnerController.renderTipRow(cols);
  let attachmentRow: string | null = null;
  if (attachments.length > 0) {
    attachmentRow = renderStatusLine(attachments);
  } else if (clipboardFailureMsgRef.value !== null) {
    attachmentRow = palette.dim(clipboardFailureMsgRef.value);
    clipboardFailureMsgRef.value = null;
  }
  return { overlayLines, spinnerRow, tipRow, attachmentRow };
}

export interface ViewportLayout {
  /** Maximum physical rows the compositor may paint (excludes bg-status reservation). */
  maxLines: number;
  /** 0 or 1 — whether a gap row is inserted between chrome and the input cluster. */
  gapRows: number;
  /** Overlay lines trimmed to the remaining budget after fixed chrome. */
  trimmedOverlay: string[];
  /** True when a gap row should be emitted in the assembled frame. */
  renderGap: boolean;
  /** Row count of the bg-status bar reservation (≥0). */
  extraRows: number;
}

/**
 * Truncate an overlay to `budget` rows while preserving the head (root anchor
 * context) and tail (most recently active content).
 *
 * When the overlay fits in the budget it is returned unchanged. When it must
 * be shortened:
 *
 * - `budget <= 3`: fall back to a plain tail-slice (too little room to split).
 * - Otherwise: allocate ~25% of the budget (min 1, max 5) to head rows, 1 row
 *   for a dim "N earlier lines hidden" indicator, and the remainder to tail rows.
 *
 * This keeps the root `◉`/`○` turn-anchor visible so the user always knows
 * which workflow they are in, while still showing the most recent activity at
 * the bottom — fixing the broken-spine appearance caused by pure tail-slicing.
 */
export function truncateOverlayPreservingHead(lines: string[], budget: number): string[] {
  if (lines.length <= budget) return lines;
  // Too small to split sensibly — fall back to tail slice.
  // Note: budget=0 must return [] (Array.slice(-0) returns the whole array).
  if (budget <= 3) return budget === 0 ? [] : lines.slice(-budget);
  const headCount = Math.min(5, Math.max(1, Math.floor(budget * 0.25)));
  // 1 row for the indicator; rest goes to tail.
  const tailCount = budget - headCount - 1;
  if (tailCount <= 0) return lines.slice(-budget);
  const hidden = lines.length - headCount - tailCount;
  const indicator = palette.dim(`      ${hidden} earlier lines hidden`);
  return [...lines.slice(0, headCount), indicator, ...lines.slice(-tailCount)];
}

/**
 * Compute the viewport layout budget for a normal (non-picker) repaint.
 *
 * @param chrome          Chrome rows gathered by {@link gatherChromeRows}.
 * @param dropdownLength  Number of dropdown candidate rows currently visible.
 * @param hasHintRow      Whether the hint slot is occupied (even when empty-string).
 * @param rows            `stdout.rows` (terminal height).
 * @param scrollRegion    Optional bg-status-bar guard for DECSTBM reservation.
 */
export function computeViewportLayout(
  chrome: ChromeRows,
  dropdownLength: number,
  hasHintRow: boolean,
  rows: number,
  scrollRegion: CompositorScrollRegionGuard | undefined,
): ViewportLayout {
  const { overlayLines, spinnerRow, tipRow, attachmentRow } = chrome;
  // Invariant: the bg status bar (when active) owns rows (rows-extraRows)..(rows-1).
  // Compositor frame must stay above that region or the two writers race the same physical row
  // every spinner tick, producing flicker. Mirrors DECSTBM math in status-line.ts:287.
  const extraRows = scrollRegion?.getExtraRows() ?? 0;
  const maxLines = Math.max(1, rows - 1 - extraRows);
  const hasFixedChrome = !!spinnerRow || !!tipRow || !!attachmentRow;
  const hasContentAboveInput = hasFixedChrome || overlayLines.length > 0;
  // hintRow is '' (a reserved blank slot) for un-hinted candidates and
  // a non-empty `↳ …` string for hinted ones — both occupy one row.
  // Test against `hasHintRow` (null → false) so the empty-string slot still counts.
  const gapRows = hasContentAboveInput ? 1 : 0;
  const fixedRows = (spinnerRow ? 1 : 0) + (tipRow ? 1 : 0)
    + (attachmentRow ? 1 : 0) + gapRows + dropdownLength
    + (hasHintRow ? 1 : 0) + 1; // +1 for the input line
  const overlayBudget = Math.max(0, maxLines - fixedRows);
  const trimmedOverlay = overlayLines.length > overlayBudget
    ? truncateOverlayPreservingHead(overlayLines, overlayBudget)
    : overlayLines;
  // Re-derive after trimming: if the overlay was the only thing above
  // input and got entirely trimmed away by the viewport budget, suppress
  // the gap. (fixedRows over-reserved by 1 in that edge case, harmless.)
  const renderGap = hasFixedChrome || trimmedOverlay.length > 0;
  return { maxLines, gapRows, trimmedOverlay, renderGap, extraRows };
}

/**
 * Compute the viewport layout budget for a picker-mode repaint.
 *
 * Picker rows replace the input cluster (dropdown + hint + input line), so
 * `fixedRows` is calculated differently from {@link computeViewportLayout}.
 */
export function computePickerViewportLayout(
  chrome: ChromeRows,
  pickerRowCount: number,
  rows: number,
  scrollRegion: CompositorScrollRegionGuard | undefined,
): Omit<ViewportLayout, 'gapRows'> {
  const { overlayLines, spinnerRow, tipRow, attachmentRow } = chrome;
  const extraRows = scrollRegion?.getExtraRows() ?? 0;
  const maxLines = Math.max(1, rows - 1 - extraRows);
  const hasFixedChrome = !!spinnerRow || !!tipRow || !!attachmentRow;
  const hasContentAboveInput = hasFixedChrome || overlayLines.length > 0;
  const gapRows = hasContentAboveInput ? 1 : 0;
  const fixedRows = (spinnerRow ? 1 : 0) + (tipRow ? 1 : 0)
    + (attachmentRow ? 1 : 0) + gapRows + pickerRowCount;
  const overlayBudget = Math.max(0, maxLines - fixedRows);
  const trimmedOverlay = overlayLines.length > overlayBudget
    ? truncateOverlayPreservingHead(overlayLines, overlayBudget)
    : overlayLines;
  const renderGap = hasFixedChrome || trimmedOverlay.length > 0;
  return { maxLines, trimmedOverlay, renderGap, extraRows };
}
