import { displayWidth } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { palette } from '../palette.js';
import { maxInnerBoxWidth } from './utils.js';
import { drawBox } from './box.js';

// ─── Error Box ───────────────────────────────────────────────────────────────

/**
 * Render a red-bordered box for error display.
 *
 * Example output (no ANSI):
 * ```
 * ╭─ Error ───────────────────────────────╮
 * │  Something went wrong                 │
 * │  Details about the error here         │
 * ╰───────────────────────────────────────╯
 * ```
 *
 * @param title   - Primary error message shown inside the box.
 * @param details - Optional secondary detail line rendered in dim text.
 */
export function errorBox(title: string, details?: string): string {
  // Inner width: title / detail content + 4-char padding, capped to the
  // terminal width. drawBox re-clamps to maxInnerBoxWidth() and guarantees the
  // box stays rectangular for any input.
  const rawInner = Math.max(40, displayWidth(title), displayWidth(details ?? '')) + 4;
  let innerW = Math.min(rawInner, Math.min(getTerminalWidth() - 4, 100));
  innerW = Math.min(innerW, maxInnerBoxWidth());

  // The title row is rendered unstyled; the optional detail row is dimmed. Both
  // flow through the shared drawBox primitive (red border, bold ' Error ' chip,
  // 2-space padding). drawBox wraps each line and inherits the #622 title-clamp
  // crash-guard the hand-rolled '─'.repeat math lacked.
  const body = details !== undefined ? [title, palette.dim(details)] : [title];
  return drawBox(body, { border: palette.error, title: 'Error', width: innerW, padding: 2 });
}
