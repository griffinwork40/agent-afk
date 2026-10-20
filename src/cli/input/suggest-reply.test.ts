import { describe, it, expect } from 'vitest';
import {
  dropPartialWord,
  joinContinuation,
  normalizeReply,
  trailingWord,
  trimTruncatedLine,
} from './suggest-reply.js';

describe('normalizeReply', () => {
  it('treats a bare string as a finished reply (no stop reason known)', () => {
    expect(normalizeReply('git status')).toEqual({ text: 'git status', truncated: false });
  });

  it('flags only a max_tokens stop as truncated', () => {
    expect(normalizeReply({ text: 'a', stopReason: 'max_tokens' }).truncated).toBe(true);
    expect(normalizeReply({ text: 'a', stopReason: 'end' }).truncated).toBe(false);
    expect(normalizeReply({ text: 'a', stopReason: 'other' }).truncated).toBe(false);
  });
});

describe('trailingWord', () => {
  it('returns the partial word being typed, or empty after a space', () => {
    expect(trailingWord('fix th')).toBe('th');
    expect(trailingWord('fix the ')).toBe('');
    expect(trailingWord('git')).toBe('git');
  });
});

describe('joinContinuation', () => {
  it('joins a reply that starts with the trailing word (the prompted shape)', () => {
    expect(joinContinuation('fix th', 'the failing test')).toBe('fix the failing test');
    expect(joinContinuation('fix the', 'the failing test')).toBe('fix the failing test');
  });

  it('appends the reply verbatim when the buffer ends in whitespace', () => {
    expect(joinContinuation('fix the ', 'failing test')).toBe('fix the failing test');
  });

  it('strips a repeated last word when the buffer ends in whitespace (non-compliant model)', () => {
    // Model non-compliantly repeats the preceding word "bar" followed by new text:
    // "foo bar " + "bar baz" must yield "foo bar baz", not "foo bar bar baz".
    expect(joinContinuation('foo bar ', 'bar baz')).toBe('foo bar baz');
    // A bare echo of just the preceding word with nothing new must be rejected.
    expect(joinContinuation('foo bar ', 'bar')).toBeNull();
    // A different word is kept verbatim.
    expect(joinContinuation('foo bar ', 'baz qux')).toBe('foo bar baz qux');
  });

  it('still accepts a reply that echoes the whole buffer (non-compliant model)', () => {
    expect(joinContinuation('git st', 'git status')).toBe('git status');
  });

  it('rejects unrelated text, empty text, and replies that add nothing', () => {
    expect(joinContinuation('hel', 'something completely different')).toBeNull();
    expect(joinContinuation('hel', '')).toBeNull();
    expect(joinContinuation('hel', 'hel')).toBeNull();
  });

  it('overlap comparison is case-insensitive; output preserves continuation casing', () => {
    // trailing word 'bar', reply starts with 'Bar' (different case) — should join
    expect(joinContinuation('foo bar', 'Bar baz')).toBe('foo Bar baz');
    // trailing word 'BAR', reply starts with 'bar' — should join
    expect(joinContinuation('foo BAR', 'bar baz')).toBe('foo bar baz');
    // no overlap at all — still rejected
    expect(joinContinuation('foo bar', 'Qux')).toBeNull();
  });
});

describe('dropPartialWord / trimTruncatedLine', () => {
  it('drops the cut-off final word', () => {
    expect(dropPartialWord('run the te')).toBe('run the');
    expect(dropPartialWord('run')).toBe('');
  });

  it('keeps the completed part of the user\'s own partial word', () => {
    expect(trimTruncatedLine('fix th', 'fix the failing te')).toBe('fix the failing');
  });

  it('returns null when no complete new word survives', () => {
    expect(trimTruncatedLine('fix the', 'fix the fail')).toBeNull();
    expect(trimTruncatedLine('fix th', 'fix the')).toBeNull();
  });
});
