import { describe, expect, it } from 'vitest';
import { isPrintableGrapheme } from './printable.js';

describe('isPrintableGrapheme', () => {
  it('accepts a single ASCII printable character', () => {
    expect(isPrintableGrapheme('a')).toBe(true);
    expect(isPrintableGrapheme('Z')).toBe(true);
    expect(isPrintableGrapheme(' ')).toBe(true); // space is the low bound (>= ' ')
  });

  it('accepts a multi-UTF-16-unit emoji as one grapheme (the bug the shared helper fixes)', () => {
    // '😀' is a surrogate pair (length 2). The old `length === 1` test dropped
    // it; isPrintableGrapheme admits it as a single grapheme cluster.
    expect('😀'.length).toBe(2);
    expect(isPrintableGrapheme('😀')).toBe(true);
  });

  it('rejects control characters', () => {
    expect(isPrintableGrapheme('\x1b')).toBe(false); // ESC
    expect(isPrintableGrapheme('\x00')).toBe(false); // NUL
    expect(isPrintableGrapheme('\t')).toBe(false); // tab (< ' ')
    expect(isPrintableGrapheme('\n')).toBe(false); // newline (< ' ')
  });

  it('rejects multi-character fragments', () => {
    expect(isPrintableGrapheme('ab')).toBe(false);
    expect(isPrintableGrapheme('\x1b[A')).toBe(false); // an escape sequence
  });

  it('rejects the empty string', () => {
    expect(isPrintableGrapheme('')).toBe(false);
  });
});
