/**
 * ASCII block-art wordmark for the welcome banner.
 *
 * A small, purpose-built 5-row block font — just the glyphs needed to spell
 * the product name (`AGENT AFK`) plus a word space. Rendered full-block (`█`)
 * so it reads on any UTF-8 terminal regardless of color support and pairs with
 * the half-block goblin sprite (see mascot.ts) as a chunky logo over a
 * high-res mascot.
 *
 * The renderer is color-agnostic: it returns uncolored, equal-width rows; the
 * caller (welcome-banner.ts) applies the brand tone. Keeping it uncolored keeps
 * width math trivial (no ANSI to strip) and the glyph grid human-editable.
 *
 * Invariant: every glyph is exactly ASCII_WORDMARK_HEIGHT rows tall; all rows
 * of a glyph share one width (GLYPHS entries are pre-padded). Unknown
 * characters throw rather than render blank, so changing WORDMARK_TEXT without
 * adding the glyph fails a test instead of silently dropping a letter.
 */

/** Row count of every glyph (and therefore of a rendered wordmark). */
export const ASCII_WORDMARK_HEIGHT = 5;

/** Columns inserted between adjacent glyphs. */
const LETTER_SPACING = 1;

/**
 * 5-row block glyphs. Only the letters in {@link WORDMARK_TEXT} plus the space
 * are defined; add a glyph here before adding its letter to the wordmark. Each
 * entry's rows are equal width (the font is not monospaced across letters — a
 * space is narrower than a letter — but every row within one glyph matches).
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: [
    ' ██ ',
    '█  █',
    '████',
    '█  █',
    '█  █',
  ],
  G: [
    ' ███',
    '█   ',
    '█ ██',
    '█  █',
    ' ███',
  ],
  E: [
    '████',
    '█   ',
    '███ ',
    '█   ',
    '████',
  ],
  N: [
    '█  █',
    '██ █',
    '█ ██',
    '█  █',
    '█  █',
  ],
  T: [
    '████',
    ' ██ ',
    ' ██ ',
    ' ██ ',
    ' ██ ',
  ],
  F: [
    '████',
    '█   ',
    '███ ',
    '█   ',
    '█   ',
  ],
  K: [
    '█  █',
    '█ █ ',
    '██  ',
    '█ █ ',
    '█  █',
  ],
  // Word space — wider than the inter-letter gap so the two words read apart.
  ' ': [
    '   ',
    '   ',
    '   ',
    '   ',
    '   ',
  ],
};

/** The product wordmark rendered as block art in the hybrid banner header. */
export const WORDMARK_TEXT = 'AGENT AFK';

/**
 * Render `text` as an array of {@link ASCII_WORDMARK_HEIGHT} uncolored rows,
 * each padded to the wordmark's full display width. Throws on any character
 * without a defined glyph.
 */
export function renderAsciiWordmark(text: string): string[] {
  const rows: string[] = Array.from({ length: ASCII_WORDMARK_HEIGHT }, () => '');
  const chars = [...text.toUpperCase()];
  chars.forEach((ch, idx) => {
    const glyph = GLYPHS[ch];
    if (glyph === undefined) {
      throw new Error(`ascii-wordmark: no glyph for character ${JSON.stringify(ch)}`);
    }
    const gap = idx === 0 ? '' : ' '.repeat(LETTER_SPACING);
    for (let r = 0; r < ASCII_WORDMARK_HEIGHT; r++) {
      rows[r] += gap + (glyph[r] ?? '');
    }
  });
  return rows;
}

/** Display width (columns) of the rendered wordmark — all rows are equal. */
export function asciiWordmarkWidth(text: string): number {
  return renderAsciiWordmark(text)[0]?.length ?? 0;
}
