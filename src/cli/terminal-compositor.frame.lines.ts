/**
 * Frame line assembly for the terminal compositor.
 *
 * Extracted from `terminal-compositor.frame.ts` to isolate the concern of
 * assembling the ordered list of display lines that make up one compositor
 * frame — separate from viewport-budget computation (frame.layout.ts) and
 * physical row positioning (frame.position.ts).
 *
 * Pure functions — no side effects, no mutations to FrameHost state.
 */

import type { ChromeRows } from './terminal-compositor.frame.layout.js';

/**
 * Assemble the ordered frame lines for a normal (non-picker) repaint.
 *
 * Layout (top → bottom):
 *   trimmedOverlay lines
 *   spinnerRow (if any)
 *   tipRow (if any)
 *   attachmentRow (if any)
 *   '' gap row (when chrome or overlay is present)
 *   dropdownRows
 *   hintRow (when non-null — includes '' reserved slot for un-hinted candidates)
 *   inputLine  ← must be the last entry (DECSTBM bottom-row anchor)
 *
 * Invariant: the input line MUST be the last entry so it consistently lands
 * at the bottom of the log-update region — which the DECSTBM scroll region
 * pins one row above the status line. This is the "input pinned, content
 * rises" geometry — dropdown opening, attachment ack, and spinner activation
 * never shift the cursor row the user is typing on.
 */
export function buildFrameLines(
  chrome: ChromeRows,
  trimmedOverlay: string[],
  renderGap: boolean,
  dropdownRows: string[],
  hintRow: string | null,
  inputLine: string,
): string[] {
  const { spinnerRow, tipRow, attachmentRow } = chrome;
  const frameLines: string[] = [];
  frameLines.push(...trimmedOverlay);
  if (spinnerRow) frameLines.push(spinnerRow);
  if (tipRow) frameLines.push(tipRow);
  if (attachmentRow) frameLines.push(attachmentRow);
  // Gap row sits between chrome and the (dropdown→hint→input) cluster
  // so the input + its completion popup stay visually adjacent (the
  // "input pinned, content rises" invariant above). With no chrome, no
  // gap — keeps the prompt flush against the top of an idle viewport.
  if (renderGap) frameLines.push('');
  frameLines.push(...dropdownRows);
  // `hintRow !== null` keeps the reserved blank-row slot for
  // un-hinted candidates so the dropdown above doesn't shift up by 1
  // row when the user navigates across a hinted ↔ un-hinted boundary.
  if (hintRow !== null) frameLines.push(hintRow);
  frameLines.push(inputLine);
  return frameLines;
}

/**
 * Assemble the ordered frame lines for a picker-mode repaint.
 *
 * The picker rents the input region (dropdown + hint + input line all
 * suppressed) and supplies its own rows via `renderRows()`. Overlay/spinner/
 * tip/attachment rows still stack above — picker mode only displaces the
 * bottom cluster the picker visually replaces.
 *
 * Invariant: the picker's last `renderRows()` entry is the bottom-pinned row
 * — typically the help line ("↑/↓ navigate · enter select").
 */
export function buildPickerFrameLines(
  chrome: ChromeRows,
  trimmedOverlay: string[],
  renderGap: boolean,
  pickerRows: string[],
): string[] {
  const { spinnerRow, tipRow, attachmentRow } = chrome;
  const frameLines: string[] = [];
  frameLines.push(...trimmedOverlay);
  if (spinnerRow) frameLines.push(spinnerRow);
  if (tipRow) frameLines.push(tipRow);
  if (attachmentRow) frameLines.push(attachmentRow);
  if (renderGap) frameLines.push('');
  frameLines.push(...pickerRows);
  return frameLines;
}
