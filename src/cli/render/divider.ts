import { displayWidth } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { palette } from '../palette.js';
import { contentBand } from './measure.js';

// ─── Divider ─────────────────────────────────────────────────────────────────

/**
 * Render a horizontal line with an optional centered title.
 *
 * Without a title the full line is a dim horizontal rule. With a title the
 * text is embedded near the start: `── Title ──────…`
 *
 * @param title - Optional label to embed in the line.
 * @param maxWidth - Override the default cap. Pass a narrower value (e.g. 100)
 *   for components that render inside a bounded region.
 *
 * Contract (centering): when AFK_CENTER_CONTENT is active the default cap is
 * the content band width (cols - marginCols) rather than 120, so the rule
 * aligns with the band's right edge instead of overshooting it. A caller-
 * supplied `maxWidth` is honoured as-is and is not further widened by the band.
 * When centering is off the behaviour is byte-identical to the previous code:
 * width = min(tw, 120) for the default, or min(tw, maxWidth) for an override.
 */
export function divider(title?: string, maxWidth?: number): string {
  const tw = getTerminalWidth();
  const band = contentBand(tw);
  // In centered mode cap to the band width so the rule aligns with content.
  // In non-centered mode band.width === tw, so the cap is min(tw, 120) —
  // identical to the previous code.
  const defaultCap = Math.min(band.width, 120);
  const width = Math.min(tw, maxWidth ?? defaultCap);

  if (title === undefined) {
    return palette.dim('─'.repeat(width));
  }

  const prefix = palette.dim('──') + ' ' + palette.bold(title) + ' ';
  const prefixPlain = '── ' + title + ' ';
  const remaining = Math.max(0, width - displayWidth(prefixPlain));
  return prefix + palette.dim('─'.repeat(remaining));
}
