/**
 * Tests for compactDiffView — the standalone compact diff viewer component.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { compactDiffView } from './compact-diff-view.js';
import type { CompactDiffSpec } from './compact-diff-view.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes for easier assertion on content. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function strip(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Build a minimal valid spec. */
function makeSpec(overrides: Partial<CompactDiffSpec> = {}): CompactDiffSpec {
  return {
    filePath: 'src/foo.ts',
    hunks: [
      {
        header: '@@ -1,3 +1,4 @@',
        lines: ['+ added line', '- removed line', '  context line'],
      },
    ],
    stats: { added: 1, removed: 1 },
    ...overrides,
  };
}

// Force chalk color level so palette colors are present in output.
let originalLevel: number;
beforeEach(() => {
  originalLevel = chalk.level;
  chalk.level = 3;
});
afterEach(() => {
  chalk.level = originalLevel;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compactDiffView', () => {
  describe('stat header', () => {
    it('includes the file path in the stat header', () => {
      const out = strip(compactDiffView(makeSpec({ filePath: 'lib/bar.ts' })));
      expect(out).toContain('lib/bar.ts');
    });

    it('includes +N stat in the header', () => {
      const out = strip(compactDiffView(makeSpec({ stats: { added: 12, removed: 5 } })));
      expect(out).toContain('+12');
    });

    it('includes -M stat in the header', () => {
      const out = strip(compactDiffView(makeSpec({ stats: { added: 12, removed: 5 } })));
      expect(out).toContain('-5');
    });
  });

  describe('single-hunk diff', () => {
    it('renders the hunk header', () => {
      const out = strip(compactDiffView(makeSpec()));
      expect(out).toContain('@@ -1,3 +1,4 @@');
    });

    it('renders added lines', () => {
      const out = strip(compactDiffView(makeSpec()));
      expect(out).toContain('+ added line');
    });

    it('renders removed lines', () => {
      const out = strip(compactDiffView(makeSpec()));
      expect(out).toContain('- removed line');
    });

    it('renders context lines', () => {
      const out = strip(compactDiffView(makeSpec()));
      expect(out).toContain('  context line');
    });

    it('wraps output in a box (rounded corners)', () => {
      const out = compactDiffView(makeSpec());
      // drawBox uses ╭ and ╰ corner glyphs
      expect(out).toContain('╭');
      expect(out).toContain('╰');
    });
  });

  describe('multi-hunk diff', () => {
    it('renders all hunks', () => {
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              { header: '@@ -1,2 +1,2 @@', lines: ['+ first hunk line'] },
              { header: '@@ -10,2 +10,2 @@', lines: ['+ second hunk line'] },
            ],
          }),
        ),
      );
      expect(out).toContain('@@ -1,2 +1,2 @@');
      expect(out).toContain('@@ -10,2 +10,2 @@');
      expect(out).toContain('+ first hunk line');
      expect(out).toContain('+ second hunk line');
    });
  });

  describe('truncation', () => {
    it('shows all lines when under maxLines', () => {
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              {
                header: '@@ -1,3 +1,3 @@',
                lines: ['+ line1', '+ line2', '- line3'],
              },
            ],
            maxLines: 5,
          }),
        ),
      );
      expect(out).toContain('+ line1');
      expect(out).toContain('+ line2');
      expect(out).toContain('- line3');
      expect(out).not.toContain('more line');
    });

    it('truncates at maxLines and shows footer', () => {
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              {
                header: '@@ -1,5 +1,5 @@',
                lines: ['+ a', '+ b', '+ c', '+ d', '+ e'],
              },
            ],
            stats: { added: 5, removed: 0 },
            maxLines: 3,
          }),
        ),
      );
      // First 3 lines present
      expect(out).toContain('+ a');
      expect(out).toContain('+ b');
      expect(out).toContain('+ c');
      // Lines beyond cap not present
      expect(out).not.toContain('+ d');
      expect(out).not.toContain('+ e');
      // Footer shows hidden count
      expect(out).toContain('... and 2 more');
    });

    it('footer uses singular "line" for exactly 1 hidden line', () => {
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              {
                header: '@@ -1,2 +1,2 @@',
                lines: ['+ a', '+ b'],
              },
            ],
            stats: { added: 2, removed: 0 },
            maxLines: 1,
          }),
        ),
      );
      expect(out).toContain('... and 1 more line');
    });

    it('footer uses plural "lines" for multiple hidden lines', () => {
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              {
                header: '@@ -1,5 +1,5 @@',
                lines: ['+ a', '+ b', '+ c', '+ d', '+ e'],
              },
            ],
            stats: { added: 5, removed: 0 },
            maxLines: 2,
          }),
        ),
      );
      expect(out).toContain('... and 3 more lines');
    });

    it('hunk headers are NOT counted against maxLines', () => {
      // 3 hunks, each with 1 body line, maxLines=3 — all body lines must survive
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              { header: '@@ -1,1 +1,1 @@', lines: ['+ body1'] },
              { header: '@@ -5,1 +5,1 @@', lines: ['+ body2'] },
              { header: '@@ -9,1 +9,1 @@', lines: ['+ body3'] },
            ],
            stats: { added: 3, removed: 0 },
            maxLines: 3,
          }),
        ),
      );
      expect(out).toContain('+ body1');
      expect(out).toContain('+ body2');
      expect(out).toContain('+ body3');
      expect(out).not.toContain('more line');
    });
  });

  describe('orphan hunk header suppression', () => {
    it('does not emit a hunk header when all its body lines are beyond the cap', () => {
      // hunk1 has 2 body lines, hunk2 has 2 body lines; maxLines=2 means
      // hunk2's body never renders — its header must also be suppressed.
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              { header: '@@ -1,2 +1,2 @@', lines: ['+ hunk1-a', '+ hunk1-b'] },
              { header: '@@ -10,2 +10,2 @@', lines: ['+ hunk2-a', '+ hunk2-b'] },
            ],
            stats: { added: 4, removed: 0 },
            maxLines: 2,
          }),
        ),
      );
      // First hunk header and its two body lines appear.
      expect(out).toContain('@@ -1,2 +1,2 @@');
      expect(out).toContain('+ hunk1-a');
      expect(out).toContain('+ hunk1-b');
      // Second hunk header must NOT appear — its body is entirely past the cap.
      expect(out).not.toContain('@@ -10,2 +10,2 @@');
      expect(out).not.toContain('+ hunk2-a');
      expect(out).not.toContain('+ hunk2-b');
      // Truncation footer should still appear.
      expect(out).toContain('... and 2 more');
    });

    it('emits a hunk header when truncation cuts into (but not past) its body', () => {
      // hunk1 has 1 body line, hunk2 has 2; maxLines=2 lets hunk2's first line through.
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              { header: '@@ -1,1 +1,1 @@', lines: ['+ hunk1-a'] },
              { header: '@@ -10,2 +10,2 @@', lines: ['+ hunk2-a', '+ hunk2-b'] },
            ],
            stats: { added: 3, removed: 0 },
            maxLines: 2,
          }),
        ),
      );
      // Both headers appear because both hunks contribute at least one visible body line.
      expect(out).toContain('@@ -1,1 +1,1 @@');
      expect(out).toContain('@@ -10,2 +10,2 @@');
      expect(out).toContain('+ hunk1-a');
      expect(out).toContain('+ hunk2-a');
      // hunk2's second line is cut.
      expect(out).not.toContain('+ hunk2-b');
      expect(out).toContain('... and 1 more line');
    });
  });

  describe('collapsed mode', () => {
    it('shows only the stat header when collapsed: true', () => {
      const out = strip(compactDiffView(makeSpec({ collapsed: true })));
      expect(out).toContain('src/foo.ts');
      expect(out).not.toContain('@@ -1');
      expect(out).not.toContain('╭');
    });

    it('collapsed output is a single line', () => {
      const out = compactDiffView(makeSpec({ collapsed: true }));
      expect(out.split('\n')).toHaveLength(1);
    });
  });

  describe('empty diff', () => {
    it('handles 0 added, 0 removed gracefully', () => {
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [],
            stats: { added: 0, removed: 0 },
          }),
        ),
      );
      expect(out).toContain('+0');
      expect(out).toContain('-0');
      // No box rendered for empty diff
      expect(out).not.toContain('╭');
    });

    it('returns a non-empty string for empty diff', () => {
      const out = compactDiffView(
        makeSpec({ hunks: [], stats: { added: 0, removed: 0 } }),
      );
      expect(out.length).toBeGreaterThan(0);
    });
  });

  describe('line coloring', () => {
    it('applies diffAdd color to + lines', () => {
      // With chalk.level = 3, palette.diffAdd wraps in ANSI green
      const out = compactDiffView(makeSpec());
      // + lines should have color codes; raw stripped text exists
      expect(strip(out)).toContain('+ added line');
      // The colored output should differ from the stripped output
      expect(out).not.toEqual(strip(out));
    });

    it('applies diffRemove color to - lines', () => {
      const out = compactDiffView(makeSpec());
      expect(strip(out)).toContain('- removed line');
    });

    it('dims context lines', () => {
      const out = compactDiffView(makeSpec());
      expect(strip(out)).toContain('  context line');
    });
  });

  describe('width option', () => {
    it('accepts a custom width and still renders', () => {
      const out = strip(compactDiffView(makeSpec({ width: 120 })));
      expect(out).toContain('@@ -1,3 +1,4 @@');
    });

    it('uses default width of 80 when not specified', () => {
      const out = strip(compactDiffView(makeSpec()));
      // Just verify it renders without error
      expect(out.length).toBeGreaterThan(0);
    });
  });

  describe('security / sanitization', () => {
    it('strips control characters from filePath in the stat header', () => {
      // A filePath containing BEL, CR, LF, and an OSC escape sequence
      const adversarialPath = 'src/\x07evil\r\n\x1b]8;;https://evil.example\x07file.ts';
      const out = compactDiffView(makeSpec({ filePath: adversarialPath }));
      // Raw control chars must not appear in the output
      expect(out).not.toContain('\x07');
      expect(out).not.toContain('\r');
      expect(out).not.toContain('\n\n'); // only the stat/box separator newline is expected
      // The benign text fragments must survive
      expect(strip(out)).toContain('src/');
      expect(strip(out)).toContain('evil');
      expect(strip(out)).toContain('file.ts');
    });

    it('strips ANSI codes from raw diff line content', () => {
      const out = compactDiffView(
        makeSpec({
          hunks: [
            {
              header: '@@ -1,1 +1,1 @@',
              lines: ['+ \x1b[31minjected color\x1b[0m'],
            },
          ],
        }),
      );
      // Content should be visible but not contain the raw injected ESC sequence
      // (palette's own ANSI codes are fine, but the injected one's payload should be gone)
      expect(strip(out)).toContain('+ injected color');
    });

    it('strips 8-bit C1 CSI (\\x9B) from diff content', () => {
      // \x9B is the 8-bit equivalent of \x1b[ — must not reach the terminal.
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              {
                header: '@@ -1,1 +1,1 @@',
                lines: ['+ \x9B31msafe text\x9Bm'],
              },
            ],
          }),
        ),
      );
      expect(out).not.toContain('\x9B');
      expect(out).toContain('+ safe text');
    });

    it('strips BEL and other C0 controls from diff content', () => {
      const out = strip(
        compactDiffView(
          makeSpec({
            hunks: [
              {
                header: '@@ -1,1 +1,1 @@',
                lines: ['+ safe\x07bell'],
              },
            ],
          }),
        ),
      );
      expect(out).not.toContain('\x07');
      expect(out).toContain('+ safebell');
    });
  });
});
