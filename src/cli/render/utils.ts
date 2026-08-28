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

/**
 * Format elapsed milliseconds as a compact human string.
 *
 * Examples: `<1s`, `4s`, `1m 23s`, `2m`
 *
 * Pure function — no side effects, no imports needed beyond this module.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}
