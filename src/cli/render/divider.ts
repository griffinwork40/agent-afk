import { displayWidth } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { palette } from '../palette.js';

// ─── Divider ─────────────────────────────────────────────────────────────────

/**
 * Render a horizontal line with an optional centered title.
 *
 * Without a title the full line is a dim horizontal rule. With a title the
 * text is embedded near the start: `── Title ──────…`
 *
 * @param title - Optional label to embed in the line.
 * @param maxWidth - Override the default 120-column cap. Pass a narrower
 *   value (e.g. 100) for components that render inside a bounded region.
 */
export function divider(title?: string, maxWidth?: number): string {
  const width = Math.min(getTerminalWidth(), maxWidth ?? 120);

  if (title === undefined) {
    return palette.dim('─'.repeat(width));
  }

  const prefix = palette.dim('──') + ' ' + palette.bold(title) + ' ';
  const prefixPlain = '── ' + title + ' ';
  const remaining = Math.max(0, width - displayWidth(prefixPlain));
  return prefix + palette.dim('─'.repeat(remaining));
}
