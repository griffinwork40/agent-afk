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

/**
 * Hard-wrap `text` to exactly `width` display columns by CHARACTER, matching a
 * terminal's auto-wrap: long unbreakable tokens ARE split at the column
 * boundary (no word awareness), and ANSI styling is preserved across rows.
 *
 * Use when the resulting row COUNT and per-row content must match what the
 * terminal will physically render — e.g. cursor-addressed (CUP) painting and
 * scroll-count math, where treating a wrapped line as a single row corrupts the
 * layout. `wrapToWidth` (word-wrap, `hard: false`) does NOT split long tokens,
 * so it under-counts physical rows and must not be used for that purpose.
 *
 * Non-finite or ≤0 `width` returns `text` unchanged.
 */
export function hardWrapToWidth(text: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0 || width === Number.POSITIVE_INFINITY) {
    return text;
  }
  return wrapAnsi(text, Math.floor(width), {
    hard: true,
    trim: false,
    wordWrap: false,
  });
}
