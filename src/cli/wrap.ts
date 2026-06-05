/**
 * Word-wrap helper that preserves ANSI escape sequences.
 *
 * Thin wrapper around `wrap-ansi` with project defaults.
 */

import wrapAnsi from 'wrap-ansi';

/**
 * Wrap `text` to at most `width` display columns, preserving ANSI styling.
 *
 * @param text  - Source string (may include chalk / ANSI codes).
 * @param width - Target column width; non-finite or ≤0 returns `text` unchanged.
 */
export function wrapToWidth(text: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) {
    return text;
  }
  if (width === Number.POSITIVE_INFINITY) {
    return text;
  }
  const w = Math.floor(width);
  return wrapAnsi(text, w, {
    hard: false,
    trim: false,
    wordWrap: true,
  });
}
