/**
 * Tests for the canonical terminal-display sanitiser (src/utils/terminal-sanitize.ts).
 *
 * Proves that dangerous terminal escape sequences — clear-screen, cursor
 * movement, OSC-8 hyperlinks, DEC private modes, 8-bit C1 CSI — are stripped,
 * that lone control bytes become spaces (word-boundary preservation), and that
 * benign text / Unicode is left intact.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeForDisplay, stripEscapeSequences } from './terminal-sanitize.js';

describe('sanitizeForDisplay', () => {
  it('strips clear-screen (CSI 2J)', () => {
    expect(sanitizeForDisplay('before\x1b[2Jafter')).toBe('beforeafter');
  });

  it('strips cursor-movement sequences', () => {
    expect(sanitizeForDisplay('\x1b[Hhome')).toBe('home');
    expect(sanitizeForDisplay('a\x1b[10;5Hb')).toBe('ab');
    expect(sanitizeForDisplay('up\x1b[2Adown')).toBe('updown');
  });

  it('strips DEC private mode sets (cursor hide, alt screen, bracketed paste)', () => {
    expect(sanitizeForDisplay('x\x1b[?25ly')).toBe('xy');
    expect(sanitizeForDisplay('x\x1b[?1049hy')).toBe('xy');
    expect(sanitizeForDisplay('x\x1b[?2004hy')).toBe('xy');
  });

  it('strips an OSC-8 hyperlink WITHOUT leaking the URL payload', () => {
    const osc8 = '\x1b]8;;https://evil.example/steal\x07click me\x1b]8;;\x07';
    const out = sanitizeForDisplay(osc8);
    expect(out).toBe('click me');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('https');
  });

  it('strips an iTerm2-style OSC terminated by ST', () => {
    expect(sanitizeForDisplay('\x1b]1337;File=name=x\x1b\\done')).toBe('done');
  });

  it('strips SGR color codes but keeps the text', () => {
    expect(sanitizeForDisplay('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips 8-bit C1 CSI sequences', () => {
    expect(sanitizeForDisplay('a\x9b2Jb')).toBe('ab');
  });

  it('replaces lone control chars with a space (preserves word boundaries)', () => {
    expect(sanitizeForDisplay('a\x07b')).toBe('a b'); // BEL
    expect(sanitizeForDisplay('a\x08b')).toBe('a b'); // backspace
    expect(sanitizeForDisplay('a\tb')).toBe('a b'); // tab
    expect(sanitizeForDisplay('a\x7fb')).toBe('a b'); // DEL
  });

  it('trims whitespace left behind after stripping', () => {
    expect(sanitizeForDisplay('  \x1b[2J  hello  ')).toBe('hello');
  });

  it('leaves benign text unchanged', () => {
    expect(sanitizeForDisplay('hello world')).toBe('hello world');
  });

  it('preserves non-ASCII Unicode (emoji, CJK, accents)', () => {
    expect(sanitizeForDisplay('café 日本語 🎉')).toBe('café 日本語 🎉');
  });

  it('neutralises a combined clear+home+text attack to just the text', () => {
    expect(sanitizeForDisplay('\x1b[2J\x1b[Hpwned')).toBe('pwned');
  });

  it('handles a lone trailing ESC', () => {
    expect(sanitizeForDisplay('text\x1b')).toBe('text');
  });

  it('strips a DCS (Device Control String) terminated by ST', () => {
    expect(sanitizeForDisplay('a\x1bP1;2;3|stuff\x1b\\b')).toBe('ab');
  });

  it('strips PM / APC / SOS strings terminated by ST', () => {
    expect(sanitizeForDisplay('x\x1b^privacy\x1b\\y')).toBe('xy'); // PM
    expect(sanitizeForDisplay('x\x1b_Gf=100,a=T\x1b\\y')).toBe('xy'); // APC (e.g. Kitty graphics)
    expect(sanitizeForDisplay('x\x1bXsos-data\x1b\\y')).toBe('xy'); // SOS
  });

  it('strips bare 2-byte ESC sequences (index / reverse-index / next-line)', () => {
    // arm 5 (\x1B[@-_]) consumes ESC + the second byte together (M/D/E are all
    // in 0x40-0x5F), so the whole 2-byte sequence is removed with no residue.
    expect(sanitizeForDisplay('a\x1bMb')).toBe('ab'); // ESC M = reverse index
    expect(sanitizeForDisplay('a\x1bDb')).toBe('ab'); // ESC D = index
    expect(sanitizeForDisplay('a\x1bEb')).toBe('ab'); // ESC E = next line
  });

  it('leaves no raw ESC/control bytes even for a malformed OSC (embedded ESC)', () => {
    // A malformed OSC whose body contains a non-terminator ESC may leave some
    // payload TEXT visible (the partial-strip wart documented in the source),
    // but the SECURITY guarantee still holds: no executable escape/control
    // byte survives to reach the terminal.
    const out = sanitizeForDisplay('\x1b]8;;http://evil\x1bXpayload\x1b\\tail');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(out).toContain('tail');
  });
});

describe('stripEscapeSequences', () => {
  it('strips CSI SGR color codes but keeps the text', () => {
    expect(stripEscapeSequences('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips an OSC-8 hyperlink wrapper, keeping only the visible label', () => {
    const osc8 = '\x1b]8;;https://example.com\x07label\x1b]8;;\x07';
    expect(stripEscapeSequences(osc8)).toBe('label');
  });

  it('strips a DCS sequence', () => {
    // DCS: ESC P <payload> ESC \\ (ST)
    expect(stripEscapeSequences('\x1bPsome-dcs-payload\x1b\\text')).toBe('text');
  });

  it('strips 8-bit C1 CSI sequences', () => {
    // 0x9B is the 8-bit CSI introducer
    expect(stripEscapeSequences('\x9b31mcolored\x9b0m')).toBe('colored');
  });

  it('PRESERVES newlines and tabs (does NOT collapse control bytes)', () => {
    const input = '\x1b[2Kline1\n\tline2';
    const result = stripEscapeSequences(input);
    expect(result).toBe('line1\n\tline2');
    expect(result).toContain('\n');
    expect(result).toContain('\t');
  });

  it('returns a benign multi-line string byte-identical (no trim)', () => {
    const input = 'line1\nline2\n';
    expect(stripEscapeSequences(input)).toBe(input);
  });

  it('contrast: sanitizeForDisplay collapses newlines to spaces and trims; stripEscapeSequences keeps them', () => {
    const multiLine = '\x1b[31mcolor\x1b[0m\nline2\n';
    // sanitizeForDisplay replaces \n with space and trims
    expect(sanitizeForDisplay(multiLine)).toBe('color line2');
    // stripEscapeSequences removes the escapes only, preserves \n
    expect(stripEscapeSequences(multiLine)).toBe('color\nline2\n');
  });
});
