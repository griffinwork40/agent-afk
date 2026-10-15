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
 * Invariant (live-frame margin ownership, AFK_CENTER_CONTENT): the compositor
 * owns the centering margin of the rows it assembles itself — spinner, tip,
 * attachment/mode-notice and every picker row. Those producers return
 * UNMARGINED text and the margin is prefixed here exactly once, so no surface
 * can forget it (the old column-0 picker/tip/notice rows) or apply it twice.
 * Overlay rows are NOT margined here: their producers (tool lane, markdown
 * pending, thinking, progress banner, rails…) pad themselves, and several
 * deliberately draw into the margin. The input line, dropdown and hint rows
 * are margined by terminal-compositor.render.ts, which also budgets their
 * width against the margin. With centering off `margin` is '' and every row
 * is byte-identical to the unmargined text.
 */
function withMargin(row: string, margin: string): string {
  return margin && row ? margin + row : row;
}

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
  margin = '',
): string[] {
  const { spinnerRow, tipRow, attachmentRow } = chrome;
  const frameLines: string[] = [];
  frameLines.push(...trimmedOverlay);
  if (spinnerRow) frameLines.push(withMargin(spinnerRow, margin));
  if (tipRow) frameLines.push(withMargin(tipRow, margin));
  if (attachmentRow) frameLines.push(withMargin(attachmentRow, margin));
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
  margin = '',
): string[] {
  const { spinnerRow, tipRow, attachmentRow } = chrome;
  const frameLines: string[] = [];
  frameLines.push(...trimmedOverlay);
  if (spinnerRow) frameLines.push(withMargin(spinnerRow, margin));
  if (tipRow) frameLines.push(withMargin(tipRow, margin));
  if (attachmentRow) frameLines.push(withMargin(attachmentRow, margin));
  if (renderGap) frameLines.push('');
  for (const row of pickerRows) frameLines.push(withMargin(row, margin));
  return frameLines;
}
