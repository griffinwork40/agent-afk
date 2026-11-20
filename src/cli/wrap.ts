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
 * @param opts.breakLongWords - When true, a single token longer than `width` is
 *   broken at the column boundary instead of overflowing past it. Default false
 *   (soft word-wrap, the historical behavior). Set this for any sink that paints
 *   raw lines with no terminal CUP re-wrap, so a bare URL / long identifier
 *   cannot run off the right edge. Normal words (≤ width) wrap identically.
 */
export function wrapToWidth(
  text: string,
  width: number,
  opts: { breakLongWords?: boolean } = {},
): string {
  if (!Number.isFinite(width) || width <= 0) {
    return text;
  }
  if (width === Number.POSITIVE_INFINITY) {
    return text;
  }
  const w = Math.floor(width);
  return text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => {
      // wrap-ansi's trim mode removes source indentation along with wrap-boundary
      // whitespace. Protect only the source line's leading spaces with a private-use
      // marker absent from that line, then restore them after wrapping. This keeps
      // intentional list/blockquote indentation while removing generated edge spaces.
      const indentMarker = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0xE000 + i))
        .find((candidate) => !line.includes(candidate));
      const protectedLine = indentMarker
        ? line.replace(/^((?:\x1B\[[0-9;]*m)*)( +)/, (_match, ansi: string, spaces: string) =>
            ansi + indentMarker.repeat(spaces.length),
          )
        : line;
      const wrapped = wrapAnsi(protectedLine, w, {
        hard: opts.breakLongWords ?? false,
        trim: true,
        wordWrap: true,
      });
      return indentMarker ? wrapped.replaceAll(indentMarker, ' ') : wrapped;
    })
    .join('\n');
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

/**
 * Return `true` when `line` occupies exactly `width` display columns by
 * wrap-ansi's internal `string-width` measure — i.e. the cursor is in
 * pending-wrap state at the right margin after the line is painted.
 *
 * CupFrameRenderer uses this to decide whether to append EL0 (`\x1b[K`)
 * after a rendered line.  It must use the SAME width library that
 * `hardWrapToWidth` / `wrap-ansi` uses internally (currently `string-width`
 * 8.3.0 resolved by `wrap-ansi` 10.0.2).  Using `displayWidth` from
 * `display.ts` (which imports `string-width` 9.0.0) instead produces
 * disagreements on some code points (lone regional indicators, digit+VS16,
 * …): 9.0.0 rates them wider than 8.3.0, so a row that is one cell short of
 * full-width by the wrap measure looks full-width to `displayWidth` and the
 * EL0 is incorrectly skipped, leaving a stale cell at the last column.
 *
 * The predicate is: appending a one-cell ASCII sentinel and re-wrapping at
 * `width` causes a split (`\n` appears) iff the original line is ≥ `width`
 * cells by wrap-ansi's measure.  Lines shorter than `width` absorb the
 * sentinel without wrapping; lines at exactly `width` or wider cause a split.
 */
export function isFullWidthByWrap(line: string, width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return false;
  return wrapAnsi(line + 'x', Math.floor(width), {
    hard: true,
    trim: false,
    wordWrap: false,
  }).includes('\n');
}
