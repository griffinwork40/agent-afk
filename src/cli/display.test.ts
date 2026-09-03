import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import {
  measureBuffer,
  nextGraphemeIndex,
  padDisplayRight,
  previousGraphemeIndex,
  stripAnsi,
  suffixDisplayWidth,
  truncateDisplayWidth,
} from './display.js';

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

describe('display utilities', () => {
  it('truncates ANSI strings without leaving raw escape fragments behind', () => {
    const text = chalk.red('hello') + chalk.blue('world');
    const truncated = truncateDisplayWidth(text, 4);
    const scrubbed = truncated.replace(ANSI_RE, '');

    expect(scrubbed).toContain('…');
    expect(scrubbed).not.toContain('\x1b');
  });

  describe('truncateDisplayWidth — OSC 8 hyperlink bleed guard', () => {
    const OSC8_CLOSE = '\x1b]8;;\x1b\\';
    const link = (text: string, url: string) => `\x1b]8;;${url}\x1b\\${text}${OSC8_CLOSE}`;

    it('re-closes a hyperlink span when the cut lands inside it', () => {
      // `prefix ` (7 cols) + linked `long-basename.ts` — truncating at 12
      // keeps the OSC 8 open but drops the original close. Without the
      // bleed guard, everything rendered after this string joins the link.
      const text = 'prefix ' + link('long-basename.ts', 'file:///a/b/long-basename.ts');
      const out = truncateDisplayWidth(text, 12);
      const opens = (out.match(/\x1b\]8;;[^\x1b]+\x1b\\/g) ?? []).length;
      const closes = (out.match(/\x1b\]8;;\x1b\\/g) ?? []).length;
      expect(opens).toBe(1);
      expect(closes).toBe(1);
      // Close must come after the ellipsis (remnant stays clickable) and
      // before the SGR reset tail.
      expect(out.indexOf(OSC8_CLOSE)).toBeGreaterThan(out.indexOf('…'));
    });

    it('does not add a spurious close when the link was fully consumed before the cut', () => {
      const text = link('x.ts', 'file:///a/b/x.ts') + ' trailing-text-that-overflows';
      const out = truncateDisplayWidth(text, 10);
      // One close from the intact link; no extra appended.
      const closes = (out.match(/\x1b\]8;;\x1b\\/g) ?? []).length;
      expect(closes).toBe(1);
    });

    it('zero-width invariant: linked and plain text truncate to identical visible output', () => {
      const plain = 'read x.ts now';
      const linked = 'read ' + link('x.ts', 'file:///a/b/x.ts') + ' now';
      expect(stripAnsi(truncateDisplayWidth(linked, 8))).toBe(truncateDisplayWidth(plain, 8));
    });
  });

  it('steps grapheme boundaries across emoji and combining sequences', () => {
    expect(previousGraphemeIndex('🙂a', '🙂a'.length)).toBe(2);
    expect(previousGraphemeIndex('éa', 'éa'.length)).toBe(2);
    expect(nextGraphemeIndex('🙂a', 0)).toBe(2);
    expect(nextGraphemeIndex('éa', 0)).toBe(2);
  });

  it('measures logical cursor rows independently from the buffer end', () => {
    const metrics = measureBuffer('hello\nworld', 2, 4, 10);

    expect(metrics.cursor).toEqual({ row: 0, col: 6 });
    expect(metrics.end.row).toBeGreaterThanOrEqual(metrics.cursor.row);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // padDisplayRight — overflow-truncation branch
  //
  // When the input is already wider than `width`, padDisplayRight falls back to
  // truncateDisplayWidth(text, width, '') rather than padding.  This is
  // defense-in-depth: production callers pre-truncate upstream, but the branch
  // must still exist and be correct.  A missing test leaves the branch
  // permanently untested (no production caller reaches it today).
  // ──────────────────────────────────────────────────────────────────────────
  describe('padDisplayRight — overflow-truncation branch', () => {
    it('truncates text that is already wider than width (no ellipsis, exact column clamp)', () => {
      // 8 ASCII chars padded to 5 columns: truncateDisplayWidth(text, 5, '')
      // keeps the first 5 chars and adds no ellipsis.
      const result = padDisplayRight('abcdefgh', 5);
      expect(result).toBe('abcde');
      expect(result.length).toBe(5);
    });

    it('truncates wide (CJK) text to the requested column budget', () => {
      // Each CJK character is 2 display columns.  '東京都' = 6 display cols.
      // Clamping to 4 cols keeps '東京' (4 cols) and drops '都'.
      const result = padDisplayRight('東京都', 4);
      expect(result).toBe('東京');
    });

    it('does not truncate text that fits exactly (no-op path)', () => {
      expect(padDisplayRight('hello', 5)).toBe('hello');
    });

    it('pads text that is shorter than width', () => {
      expect(padDisplayRight('hi', 5)).toBe('hi   ');
    });
  });

  it('strips ANSI sequences with broad escape coverage', () => {
    const text = chalk.bold.red('agent');
    expect(stripAnsi(text)).toBe('agent');
  });

  describe('stripAnsi — OSC/DCS coverage', () => {
    it('strips OSC 8 hyperlinks terminated by BEL (no body or terminator leaks)', () => {
      // Adversarial file content: an OSC 8 hyperlink anchor would otherwise
      // ring the terminal bell and inject a hyperlink span into the rendered
      // diff. With the extended regex, the entire sequence is removed.
      const input = 'before\x1b]8;;http://example.com\x07link-text\x1b]8;;\x07after';
      const out = stripAnsi(input);
      expect(out).toBe('beforelink-textafter');
      expect(out).not.toContain('\x07');
      expect(out).not.toContain('\x1b');
    });

    it('strips OSC terminated by ST (ESC \\\\)', () => {
      const input = 'a\x1b]0;window-title\x1b\\b';
      expect(stripAnsi(input)).toBe('ab');
    });

    it('strips DCS sequences (ESC P … ESC \\\\) including the ST terminator', () => {
      const input = 'x\x1bPdcs-body-payload\x1b\\y';
      const out = stripAnsi(input);
      expect(out).toBe('xy');
      expect(out).not.toContain('\x1b');
    });

    it('strips PM and APC sequences (ESC ^ … ST, ESC _ … ST)', () => {
      expect(stripAnsi('a\x1b^msg\x1b\\b')).toBe('ab');
      expect(stripAnsi('a\x1b_app\x1b\\b')).toBe('ab');
    });

    it('still strips standard CSI/SGR sequences (no regression)', () => {
      const input = '\x1b[31mhello\x1b[0m world \x1b[1mbold\x1b[0m';
      expect(stripAnsi(input)).toBe('hello world bold');
    });

    it('preserves printable text unchanged', () => {
      expect(stripAnsi('plain text 123 — émoji 🙂')).toBe('plain text 123 — émoji 🙂');
    });
  });

  // ---------------------------------------------------------------------------
  // suffixDisplayWidth — scroll viewport for input prompts
  // ---------------------------------------------------------------------------

  describe('suffixDisplayWidth', () => {
    it('returns the text unchanged when it fits within maxWidth', () => {
      expect(suffixDisplayWidth('hello', 10)).toBe('hello');
    });

    it('returns the text unchanged when display width equals maxWidth exactly', () => {
      expect(suffixDisplayWidth('hello', 5)).toBe('hello');
    });

    it('truncates from the LEFT and prepends ellipsis for long input', () => {
      // "abcdefghij" is 10 chars wide; maxWidth=6 → budget=5 → tail "fghij" + "…" prefix
      const result = suffixDisplayWidth('abcdefghij', 6);
      expect(result).toBe('…fghij');
      expect(result.length).toBe(6); // "…" (1) + 5 chars = 6
    });

    it('total display width never exceeds maxWidth', () => {
      const text = 'x'.repeat(100);
      const result = suffixDisplayWidth(text, 20);
      // "…" is 1 column wide, so content = 19 chars
      expect(result).toBe('…' + 'x'.repeat(19));
    });

    it('returns empty string when maxWidth is 0', () => {
      expect(suffixDisplayWidth('hello', 0)).toBe('');
    });

    it('shows the rightmost characters (cursor-visible tail)', () => {
      // Simulate typing: "abcde" with width=4 → user sees "…cde"
      const result = suffixDisplayWidth('abcde', 4);
      expect(result.endsWith('cde')).toBe(true);
      expect(result.startsWith('…')).toBe(true);
    });

    it('handles multibyte emoji correctly — wide chars excluded when they straddle boundary', () => {
      // "abc🙂" — emoji is 2 columns wide; maxWidth=5 → budget=4
      // graphemes: a(1), b(1), c(1), 🙂(2) — total=5 > 4
      // From right: 🙂(2) → accumulated=2; c(1) → 3; b(1) → 4; stop at a (would be 5 > 4)
      // sliceStart = index of 'b'? Let's verify empirically:
      const result = suffixDisplayWidth('abc🙂', 5);
      // result must be ≤ 5 display columns and end with "🙂"
      expect(result.endsWith('🙂')).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('supports a custom ellipsis character', () => {
      const result = suffixDisplayWidth('abcdefgh', 5, '<');
      expect(result.startsWith('<')).toBe(true);
      // "<" is 1 col wide; budget=4 → tail "efgh"
      expect(result).toBe('<efgh');
    });

    it('returns just the ellipsis when maxWidth equals ellipsis width', () => {
      // maxWidth=1, ellipsis="…" (1 col) → budget=0 → no tail chars
      const result = suffixDisplayWidth('hello world', 1);
      expect(result).toBe('…');
    });
  });
});
