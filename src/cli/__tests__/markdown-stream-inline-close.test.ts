import { describe, it, expect } from 'vitest';
import { closePendingInlineSyntax } from '../markdown-stream-inline-close.js';

describe('closePendingInlineSyntax', () => {
  it('returns empty string unchanged', () => {
    expect(closePendingInlineSyntax('')).toBe('');
  });

  it('returns text with no markers unchanged', () => {
    expect(closePendingInlineSyntax('hello world')).toBe('hello world');
  });

  // ── bold (**) ──────────────────────────────────────────────────────────────

  it('appends ** for a single unclosed bold marker', () => {
    expect(closePendingInlineSyntax('**bold text')).toBe('**bold text**');
  });

  it('leaves closed bold unchanged', () => {
    expect(closePendingInlineSyntax('**bold**')).toBe('**bold**');
  });

  it('leaves even count of ** unchanged', () => {
    // two openers, two closers → four ** total (even)
    expect(closePendingInlineSyntax('**a** **b**')).toBe('**a** **b**');
  });

  // ── italic (*) ─────────────────────────────────────────────────────────────

  it('appends * for a single unclosed italic marker', () => {
    expect(closePendingInlineSyntax('*italic text')).toBe('*italic text*');
  });

  it('leaves closed italic unchanged', () => {
    expect(closePendingInlineSyntax('*italic*')).toBe('*italic*');
  });

  // ── inline code (`) ────────────────────────────────────────────────────────

  it('appends ` for a single unclosed backtick', () => {
    expect(closePendingInlineSyntax('`code')).toBe('`code`');
  });

  it('leaves closed inline code unchanged', () => {
    expect(closePendingInlineSyntax('`code`')).toBe('`code`');
  });

  // ── strikethrough (~~) ─────────────────────────────────────────────────────

  it('appends ~~ for a single unclosed strikethrough marker', () => {
    expect(closePendingInlineSyntax('~~strike')).toBe('~~strike~~');
  });

  it('leaves closed strikethrough unchanged', () => {
    expect(closePendingInlineSyntax('~~strike~~')).toBe('~~strike~~');
  });

  // ── multiple unclosed markers ───────────────────────────────────────────────

  it('closes multiple unclosed markers in one pass', () => {
    // unclosed ** and unclosed * and unclosed `
    const input = '**bold *italic `code';
    const result = closePendingInlineSyntax(input);
    // ** count=1 (odd→append **), * count=3 (odd→append *), ` count=1 (odd→append `)
    expect(result).toBe('**bold *italic `code***`');
  });

  it('closes unclosed bold and strikethrough together', () => {
    // MARKERS order is ['**', '~~', '*', '`'], so ** is appended before ~~.
    // Input has ** count=1 (odd) and ~~ count=1 (odd), so both get appended.
    expect(closePendingInlineSyntax('**bold ~~strike')).toBe('**bold ~~strike**~~');
  });

  // ── triple backtick (```) ───────────────────────────────────────────────────
  // Triple backtick in the pending buffer means an open code *fence*, which
  // formatPendingBuffer replaces with a placeholder before this function is
  // called. However, the helper should still handle odd counts gracefully.

  it('appends one ` when triple-backtick count is odd (3 is odd)', () => {
    // ``` has 3 backtick chars → countOccurrences('`') = 3 (odd) → appends `
    // ** and ~~ counts are 0, * count is 0
    const result = closePendingInlineSyntax('```code');
    expect(result).toBe('```code`');
  });

  it('does not append ` when triple-backtick pair makes even count (6 backticks)', () => {
    // ``` ... ``` → 6 backtick chars → even → no-op
    expect(closePendingInlineSyntax('```code```')).toBe('```code```');
  });

  // ── italic before strikethrough ─────────────────────────────────────────────

  it('closes both unclosed italic and strikethrough in fixed marker order', () => {
    // Input: one unclosed * (italic) and one unclosed ~~ (strikethrough).
    // MARKERS order: ['**', '~~', '*', '`'].
    // ** count in cleaned=0 (even→no append), ~~ count=1 (odd→append ~~),
    // then ~~ removed from cleaned; * count=1 (odd→append *), ` count=0.
    // Appended in order: ~~ then * → result is '*italic ~~strike~~*'.
    expect(closePendingInlineSyntax('*italic ~~strike')).toBe('*italic ~~strike~~*');
  });

  // ── pure-function guarantee ─────────────────────────────────────────────────

  it('does not mutate the input string', () => {
    const input = '**unclosed';
    const original = input;
    closePendingInlineSyntax(input);
    expect(input).toBe(original);
  });
});
