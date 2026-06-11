/**
 * Tests for src/cli/input/echo.ts
 *
 * Validates that formatSubmittedEcho() right-aligns user echoes in both the
 * inline and card paths so the content (or the trailing `│` bar) sits flush
 * against the right edge of the terminal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import stringWidth from 'string-width';

/** Remove ANSI escape sequences so assertions work in any chalk level. */
function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

// Lazily import after each test so module state is fresh for column overrides.
async function importEcho() {
  // Vitest module cache is stable within a test run; use the static import.
  const { formatSubmittedEcho } = await import('./echo.js');
  return formatSubmittedEcho;
}

describe('formatSubmittedEcho', () => {
  afterEach(() => {
    // Restore a sensible terminal width after any test that overrides it.
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('non-TTY path returns promptText + buffer verbatim', async () => {
    const fn = await importEcho();
    const result = fn({ buffer: 'hello', promptText: 'afk › ', isTTY: false });
    expect(result).toBe('afk › hello');
  });

  it('short single-line buffer right-pads so content ends at cols-1 (last-column safety)', async () => {
    const fn = await importEcho();
    const buffer = 'hi';
    const terminalWidth = 80;
    const result = strip(
      fn({ buffer, promptText: 'afk › ', isTTY: true, terminalWidth }),
    );
    // No prompt prefix in the echo; content ends ONE column short of the
    // terminal's final column. A printable glyph in the physical last column
    // triggers DECAWM deferred-wrap ghosting/tripling on real terminals — see
    // the last-column-safety invariant in echo.ts (mirrors render/card.ts).
    expect(result.endsWith(buffer)).toBe(true);
    expect(stringWidth(result)).toBe(terminalWidth - 1);
    expect(result).toBe('▶ ' + ' '.repeat(terminalWidth - 1 - stringWidth(buffer) - 2) + buffer);
  });

  it('card path: every content line ends flush right with the cyan bar', async () => {
    const fn = await importEcho();
    // Read the actual terminal width the card renderer will see — it pulls
    // `getTerminalWidth()` directly, not the explicit override. (The override
    // only steers the inline-vs-card decision inside `formatSubmittedEcho`.)
    const { getTerminalWidth } = await import('../terminal-size.js');
    const cols = getTerminalWidth();
    // Force the card path with a buffer wider than `cols`. Use space-separated
    // tokens so `wrap-ansi`'s word-wrap (hard:false) actually breaks the line —
    // otherwise an unbroken run of chars stays on a single overflow row.
    const buffer = ('word '.repeat(Math.ceil(cols / 5) + 5)).trim();
    const result = strip(
      fn({ buffer, promptText: 'afk › ', isTTY: true, terminalWidth: cols }),
    );
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // First line is the separator row (contains ─); remaining are content rows.
    const [sepRow, ...contentRows] = lines;
    expect(sepRow).toContain('─');
    // All content rows must share the same width so the right edge is uniform.
    const widths = contentRows.map((l) => stringWidth(l));
    for (const w of widths) expect(w).toBe(widths[0]);
    for (const line of contentRows) {
      expect(line.endsWith(' │')).toBe(true);
      expect(stringWidth(line)).toBeLessThanOrEqual(cols);
    }
  });

  it('multiline buffer triggers card path', async () => {
    const fn = await importEcho();
    const prompt = 'afk › ';
    const result = strip(fn({ buffer: 'line one\nline two', promptText: prompt, isTTY: true, terminalWidth: 80 }));
    // Card path: output contains │ bar characters
    expect(result).toContain('│');
    // Content is present
    expect(result).toContain('line one');
    expect(result).toContain('line two');
    // Separator row is first; content rows end with the right-edge bar.
    const lines = result.split('\n');
    const [, ...contentLines] = lines; // skip separator row
    for (const line of contentLines) {
      expect(line.endsWith(' │')).toBe(true);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // attachmentSummary regression — pre-fix the post-submit echo dropped
  // any acknowledgment that an image was attached. eraseDown wipes the
  // composition-time `renderStatusLine` indicator, and the echo had no
  // attachment parameter at all, so the user saw their text echo back
  // with zero confirmation the image went with the turn.
  // ────────────────────────────────────────────────────────────────────

  describe('attachmentSummary', () => {
    it('non-TTY: appends summary inline after the buffer', async () => {
      const fn = await importEcho();
      const result = fn({
        buffer: 'hello',
        promptText: 'afk › ',
        isTTY: false,
        attachmentSummary: '[image attached]',
      });
      expect(result).toBe('afk › hello [image attached]');
    });

    it('non-TTY: empty summary is treated as absent (no trailing space)', async () => {
      const fn = await importEcho();
      const result = fn({
        buffer: 'hello',
        promptText: 'afk › ',
        isTTY: false,
        attachmentSummary: '',
      });
      expect(result).toBe('afk › hello');
    });

    it('TTY short buffer: summary appears on its own line, right-aligned', async () => {
      const fn = await importEcho();
      const summary = '[image attached]';
      const terminalWidth = 80;
      const result = fn({
        buffer: 'hi',
        promptText: 'afk › ',
        isTTY: true,
        terminalWidth,
        attachmentSummary: summary,
      });
      const stripped = strip(result);
      const lines = stripped.split('\n');
      // Two lines: echoed buffer (right-aligned) + summary (right-aligned).
      // Whether chalk actually emits dim ANSI escapes depends on the test
      // env's color-support detection (TTY-less harnesses strip them), so
      // assertions stick to visible structure rather than ANSI bytes.
      expect(lines).toHaveLength(2);
      expect(lines[0]!.endsWith('hi')).toBe(true);
      expect(lines[1]!.endsWith(summary)).toBe(true);
      // Summary is right-aligned, ending at cols-1 (last-column safety — a
      // glyph in the physical final column triggers DECAWM wrap ghosting).
      expect(stringWidth(lines[1]!)).toBe(terminalWidth - 1);
    });

    it('TTY card path: summary appears below the card, right-aligned', async () => {
      const fn = await importEcho();
      const summary = '[2 images attached]';
      const terminalWidth = 80;
      const result = fn({
        buffer: 'line one\nline two',
        promptText: 'afk › ',
        isTTY: true,
        terminalWidth,
        attachmentSummary: summary,
      });
      const stripped = strip(result);
      const lines = stripped.split('\n');
      // Last line is the summary, right-aligned to cols-1 (last-column safety).
      const lastLine = lines[lines.length - 1]!;
      expect(lastLine.endsWith(summary)).toBe(true);
      expect(stringWidth(lastLine)).toBe(terminalWidth - 1);
      // The card's right-edge bar is still present on the content rows.
      // cardLines = all lines except the trailing summary line.
      const cardLines = lines.slice(0, -1);
      // First card line is the separator row (ends with ─, not │); skip it.
      const [, ...cardContentLines] = cardLines;
      for (const line of cardContentLines) {
        expect(line.endsWith(' │')).toBe(true);
      }
    });

    it('TTY: undefined summary leaves output identical to the no-summary path', async () => {
      const fn = await importEcho();
      const baseline = strip(fn({ buffer: 'hi', promptText: 'afk › ', isTTY: true, terminalWidth: 80 }));
      const withUndef = strip(
        fn({ buffer: 'hi', promptText: 'afk › ', isTTY: true, terminalWidth: 80, attachmentSummary: undefined }),
      );
      const withEmpty = strip(
        fn({ buffer: 'hi', promptText: 'afk › ', isTTY: true, terminalWidth: 80, attachmentSummary: '' }),
      );
      expect(withUndef).toBe(baseline);
      expect(withEmpty).toBe(baseline);
    });
  });
});

describe('visualCursorPos', () => {
  async function importPos() {
    const { visualCursorPos } = await import('./echo.js');
    return visualCursorPos;
  }

  it('single-line, no wrap: cursor at end → row 0, col = promptW + len', async () => {
    const fn = await importPos();
    // prompt width 17, buffer "hello" (5), cursor at end (5), cols=80 → row 0, col 22
    expect(fn('hello', 5, 17, 80)).toEqual({ row: 0, col: 22 });
  });

  it('single-line, no wrap: cursor mid-buffer', async () => {
    const fn = await importPos();
    expect(fn('hello world', 6, 17, 80)).toEqual({ row: 0, col: 23 });
  });

  it('single-line that wraps: cursor at end of first wrapped row lands on row 1', async () => {
    const fn = await importPos();
    // promptW=17, buffer 70 chars, cols=80 → total visible 87, wraps after col 80
    // First row holds promptW(17) + 63 chars; remaining 7 chars on row 1.
    // Cursor at end (idx=70) → visiblePrefix=87 → row=1, col=7
    const buffer = 'x'.repeat(70);
    expect(fn(buffer, 70, 17, 80)).toEqual({ row: 1, col: 7 });
  });

  it('single-line that wraps: cursor just past the wrap boundary', async () => {
    const fn = await importPos();
    // promptW=17, cursor at char 64 → visiblePrefix=81 → row 1, col 1
    const buffer = 'x'.repeat(70);
    expect(fn(buffer, 64, 17, 80)).toEqual({ row: 1, col: 1 });
  });

  it('exact wrap boundary: cursor reported at col 0 of next row (deferred wrap)', async () => {
    const fn = await importPos();
    // promptW=17, cursor at char 63 → visiblePrefix=80 → floor(80/80)=1, col=0
    const buffer = 'x'.repeat(70);
    expect(fn(buffer, 63, 17, 80)).toEqual({ row: 1, col: 0 });
  });

  it('multi-line buffer: cursor on second line', async () => {
    const fn = await importPos();
    // "abc\ndef", cursor at idx 5 ('e' in "def"). Line 0 = "abc" (3 cols + promptW),
    // line 1 starts at col 0. Cursor offset within line 1 = 5 - 4 = 1.
    expect(fn('abc\ndef', 5, 17, 80)).toEqual({ row: 1, col: 1 });
  });

  it('multi-line buffer: cursor at end of second line', async () => {
    const fn = await importPos();
    // "abc\ndef", cursor at idx 7 (end). Line 1 has "def" (3 cols). row=1, col=3.
    expect(fn('abc\ndef', 7, 17, 80)).toEqual({ row: 1, col: 3 });
  });

  it('multi-line + wrap: second line wraps too', async () => {
    const fn = await importPos();
    // line 0 = "" (just prompt at 17 cols), line 1 = 70 chars of 'x'
    // (continuation lines have no prompt). Cursor at end → idx = 1 + 70 = 71.
    // Line 1 visiblePrefix = 70 < 80 → row offset 0 on line 1.
    // But line 0 occupies 1 row. So total row = 1 + 0 = 1, col = 70.
    const buffer = '\n' + 'x'.repeat(70);
    expect(fn(buffer, 71, 17, 80)).toEqual({ row: 1, col: 70 });
  });
});
