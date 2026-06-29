import { describe, expect, it } from 'vitest';
import { isSoftNewlineEnter, endsWithBackslashContinuation } from './enter-decision.js';

describe('isSoftNewlineEnter', () => {
  it('is true for shift+Enter (key.shift)', () => {
    expect(isSoftNewlineEnter({ shift: true }, undefined)).toBe(true);
  });

  it('is true for alt/option+Enter (key.meta)', () => {
    expect(isSoftNewlineEnter({ meta: true }, undefined)).toBe(true);
  });

  it('is true for the kitty shift+Enter sequence \\x1b[13;2u even without key.shift', () => {
    expect(isSoftNewlineEnter(undefined, '\x1b[13;2u')).toBe(true);
    expect(isSoftNewlineEnter({}, '\x1b[13;2u')).toBe(true);
  });

  it('is false for plain Enter (no modifiers, no special sequence)', () => {
    expect(isSoftNewlineEnter({}, undefined)).toBe(false);
    expect(isSoftNewlineEnter({ shift: false, meta: false }, '\r')).toBe(false);
  });

  it('is false for an undefined key with no kitty sequence', () => {
    expect(isSoftNewlineEnter(undefined, undefined)).toBe(false);
    expect(isSoftNewlineEnter(undefined, '\r')).toBe(false);
  });
});

describe('endsWithBackslashContinuation', () => {
  it('is true when the buffer ends in a backslash', () => {
    expect(endsWithBackslashContinuation('foo\\')).toBe(true);
    expect(endsWithBackslashContinuation('\\')).toBe(true);
  });

  it('is true when the buffer ends in two backslashes (still ends with a backslash)', () => {
    // Matches the original reader.ts semantics: a simple trailing-char test,
    // not an even/odd escape count.
    expect(endsWithBackslashContinuation('foo\\\\')).toBe(true);
  });

  it('is false when the buffer does not end in a backslash', () => {
    expect(endsWithBackslashContinuation('foo')).toBe(false);
    expect(endsWithBackslashContinuation('a\\b')).toBe(false);
  });

  it('is false for an empty buffer', () => {
    expect(endsWithBackslashContinuation('')).toBe(false);
  });
});
