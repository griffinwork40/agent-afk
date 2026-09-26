/**
 * ANSI-aware segmentation for the smoke-text reveal mask.
 *
 * Split out of `smoke-reveal.ts` so the mask logic stays readable and so the
 * escape-sequence walker can be unit-tested on its own.
 *
 * Contract: `segmentAnsi(s)` returns segments that concatenate back to `s`
 * byte-for-byte. A `raw` segment is anything that occupies no cell of its
 * own (CSI/SGR escapes, OSC sequences such as OSC 8 hyperlinks, lone ESC
 * pairs, a stray zero-width mark). A `char` segment is exactly one GRAPHEME
 * CLUSTER, never a bare code point: `👩‍💻`, `👍🏽`, and `é` (e + U+0301) are
 * each one segment, so the mask reveals and width-reserves them as a unit
 * (splitting a ZWJ sequence would make an unrevealed `👩‍💻` reserve 4 columns
 * instead of 2). `ws` marks whitespace (spaces, newlines), which the mask
 * never animates and never counts.
 *
 * @module cli/smoke-reveal.ansi
 */

export type AnsiSegment =
  | { kind: 'raw'; text: string }
  | { kind: 'char'; text: string; ws: boolean };

const ESC = '\u001b';
const BEL = '\u0007';
/** CSI: ESC [ params intermediates final-byte. */
const CSI_RE = /^\u001b\[[0-?]*[ -/]*[@-~]/;
/** Zero-width code points: combining marks, ZWJ/ZWNJ, variation selectors. */
const ZERO_WIDTH_RE = /^[\p{M}\u200B-\u200D\uFE00-\uFE0F]+$/u;
const WS_RE = /^\s+$/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Push the grapheme clusters of an escape-free text run onto `out`. */
function pushText(out: AnsiSegment[], text: string): void {
  for (const { segment } of graphemes.segment(text)) {
    if (ZERO_WIDTH_RE.test(segment)) out.push({ kind: 'raw', text: segment });
    else out.push({ kind: 'char', text: segment, ws: WS_RE.test(segment) });
  }
}

/**
 * Scan forward from `j` (the first payload byte of an ST-terminated sequence)
 * looking for BEL (U+0007) or the String Terminator `ESC \`. Returns the
 * total sequence length from `i` (the ESC that opened the sequence), or -1
 * if no terminator is found anywhere in the rest of the string.
 *
 * OSC also accepts BEL as an alternative terminator per xterm; all other
 * ST-terminated types (DCS, SOS, PM, APC) use ST only.
 */
function swallowToST(s: string, i: number, j: number, acceptBEL: boolean): number {
  for (; j < s.length; j++) {
    if (acceptBEL && s[j] === BEL) return j - i + 1;
    if (s[j] === ESC && s[j + 1] === '\\') return j - i + 2;
  }
  return -1;
}

/** Length of the escape sequence starting at `i` (which holds ESC). */
function escapeLength(s: string, i: number): number {
  const next = s[i + 1];
  if (next === '[') {
    const m = CSI_RE.exec(s.slice(i));
    return m ? m[0].length : 2;
  }
  // OSC (ESC ]): terminated by BEL or ST per xterm. Scan the full remaining
  // string for the real terminator — no byte-count cap — so OSC payloads
  // longer than 254 bytes (e.g. long OSC 8 URLs) are treated as a single raw
  // segment rather than split at an arbitrary boundary. Only if no terminator
  // exists anywhere (e.g. a streaming chunk boundary) do we fall back to a
  // 2-byte literal so following text is not silently swallowed.
  if (next === ']') {
    const len = swallowToST(s, i, i + 2, /* acceptBEL */ true);
    return len === -1 ? 2 : len;
  }
  // DCS (ESC P), SOS (ESC X), PM (ESC ^), APC (ESC _): terminated by ST only.
  // When unterminated, swallow to end so payload bytes never leak into the
  // visible-char count (historic behaviour preserved).
  if (next === 'P' || next === 'X' || next === '^' || next === '_') {
    const len = swallowToST(s, i, i + 2, /* acceptBEL */ false);
    return len === -1 ? s.length - i : len;
  }
  // Any other ESC is a two-byte escape (ESC 7/8/c/=/>, SS2/SS3, ...) or a
  // lone trailing ESC. It is passed through unchanged as a zero-cell `raw`
  // segment: the mask only measures escapes, it never strips or rewrites them.
  return next === undefined ? 1 : 2;
}

/** Segment `s` into escape runs and single visible grapheme clusters. */
export function segmentAnsi(s: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let i = 0;
  let textStart = 0;
  while (i < s.length) {
    if (s[i] !== ESC) {
      i++;
      continue;
    }
    if (i > textStart) pushText(out, s.slice(textStart, i));
    const len = escapeLength(s, i);
    out.push({ kind: 'raw', text: s.slice(i, i + len) });
    i += len;
    textStart = i;
  }
  if (textStart < s.length) pushText(out, s.slice(textStart));
  return out;
}

/** Number of non-whitespace grapheme clusters in plain text (no escapes expected). */
export function countVisible(text: string): number {
  let n = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (!WS_RE.test(segment) && !ZERO_WIDTH_RE.test(segment)) n++;
  }
  return n;
}
