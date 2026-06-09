import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import {
  measureBuffer,
  nextGraphemeIndex,
  previousGraphemeIndex,
  stripAnsi,
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
});
