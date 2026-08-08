import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi-strip.js';
import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';

// The escape-sequence-family coverage (OSC/DCS/CSI 7-bit/8-bit, bare ESC) is
// already exhaustively tested in `src/utils/terminal-sanitize.test.ts` for
// the wrapped `stripEscapeSequences` function. These tests only confirm this
// module's contract: it delegates to that function verbatim (no new regex)
// and preserves multi-line structure, since the web transcript renders
// multi-line tool output.
describe('stripAnsi', () => {
  it('removes a basic SGR color sequence', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('preserves newlines in multi-line tool output', () => {
    const input = '\x1b[32mline1\x1b[0m\nline2\n';
    expect(stripAnsi(input)).toBe('line1\nline2\n');
  });

  it('leaves escape-free text untouched', () => {
    const input = 'plain output, no escapes here';
    expect(stripAnsi(input)).toBe(input);
  });

  it('delegates to the canonical stripEscapeSequences (same output, no local regex)', () => {
    const input = '\x1b]8;;https://example.com\x07label\x1b]8;;\x07 done\x9b1mtail\x9b0m';
    expect(stripAnsi(input)).toBe(stripEscapeSequences(input));
  });
});
