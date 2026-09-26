/**
 * ANSI-aware segmentation for the smoke-text reveal mask.
 *
 * Split out of `smoke-reveal.ts` so the mask logic stays readable and so the
 * escape-sequence walker can be unit-tested on its own.
 *
 * Contract: `segmentAnsi(s)` returns segments that concatenate back to `s`
 * byte-for-byte. A `raw` segment is anything that occupies no cell of its
 * own (CSI/SGR escapes, OSC sequences such as OSC 8 hyperlinks, lone ESC
 * pairs, zero-width combining marks). A `char` segment is exactly one code
 * point that paints a cell; `ws` marks whitespace (spaces, newlines), which
 * the mask never animates and never counts.
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
const ZERO_WIDTH_RE = /^[\p{M}\u200B-\u200D\uFE00-\uFE0F]$/u;
const WS_RE = /^\s$/u;

/** Length of the escape sequence starting at `i` (which holds ESC). */
function escapeLength(s: string, i: number): number {
  const next = s[i + 1];
  if (next === '[') {
    const m = CSI_RE.exec(s.slice(i));
    return m ? m[0].length : 2;
  }
  if (next === ']') {
    // OSC runs until BEL or ST (ESC \). Unterminated: swallow the rest so a
    // truncated hyperlink never leaks its URL bytes into the visible count.
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === BEL) return j - i + 1;
      if (s[j] === ESC && s[j + 1] === '\\') return j - i + 2;
    }
    return s.length - i;
  }
  return next === undefined ? 1 : 2;
}

/** Segment `s` into escape/zero-width runs and single visible code points. */
export function segmentAnsi(s: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      const len = escapeLength(s, i);
      out.push({ kind: 'raw', text: s.slice(i, i + len) });
      i += len;
      continue;
    }
    const cp = s.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (ZERO_WIDTH_RE.test(ch)) out.push({ kind: 'raw', text: ch });
    else out.push({ kind: 'char', text: ch, ws: WS_RE.test(ch) });
  }
  return out;
}

/** Number of non-whitespace code points in plain text (no escapes expected). */
export function countVisible(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!WS_RE.test(ch) && !ZERO_WIDTH_RE.test(ch)) n++;
  }
  return n;
}
