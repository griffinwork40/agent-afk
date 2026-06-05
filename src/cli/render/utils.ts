import { getTerminalWidth } from '../terminal-size.js';
import { truncateDisplayWidth } from '../display.js';

/** Maximum inner box width so borders (`+6` cols) fit in the terminal. */
export function maxInnerBoxWidth(): number {
  return Math.max(22, getTerminalWidth() - 6);
}

/** Truncate to a maximum display width (grapheme-aware via string-width). */
export function truncateDisplay(s: string, maxWidth: number): string {
  return truncateDisplayWidth(s, maxWidth);
}
