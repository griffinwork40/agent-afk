/**
 * Unit tests for src/utils/jsonl.ts — parseJsonlLines edge cases.
 *
 * Covers:
 *   - Empty / blank input
 *   - Malformed JSON lines
 *   - Trailing newlines
 *   - \r\n line endings
 *   - Null JSON values
 *   - onParseError callback firing
 *   - guard function filtering
 */

import { describe, it, expect, vi } from 'vitest';
import { parseJsonlLines } from './jsonl.js';

// ---------------------------------------------------------------------------
// Basic happy path
// ---------------------------------------------------------------------------

describe('parseJsonlLines — basic', () => {
  it('parses a single valid JSON object', () => {
    const result = parseJsonlLines('{"a":1}');
    expect(result).toEqual([{ a: 1 }]);
  });

  it('parses multiple newline-separated objects', () => {
    const input = '{"x":1}\n{"x":2}\n{"x":3}';
    expect(parseJsonlLines(input)).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });

  it('parses numbers, booleans, and strings (unknown type)', () => {
    const input = '42\ntrue\n"hello"';
    expect(parseJsonlLines(input)).toEqual([42, true, 'hello']);
  });
});

// ---------------------------------------------------------------------------
// Empty / blank input
// ---------------------------------------------------------------------------

describe('parseJsonlLines — empty / blank lines', () => {
  it('returns [] for an empty string', () => {
    expect(parseJsonlLines('')).toEqual([]);
  });

  it('returns [] for a string of only whitespace', () => {
    expect(parseJsonlLines('   \n   \n   ')).toEqual([]);
  });

  it('skips blank lines between valid lines', () => {
    const input = '{"a":1}\n\n{"b":2}\n';
    expect(parseJsonlLines(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips leading blank lines', () => {
    const input = '\n\n{"ok":true}';
    expect(parseJsonlLines(input)).toEqual([{ ok: true }]);
  });
});

// ---------------------------------------------------------------------------
// Trailing newlines
// ---------------------------------------------------------------------------

describe('parseJsonlLines — trailing newlines', () => {
  it('handles a single trailing newline', () => {
    expect(parseJsonlLines('{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it('handles multiple trailing newlines', () => {
    expect(parseJsonlLines('{"a":1}\n\n\n')).toEqual([{ a: 1 }]);
  });

  it('returns [] for a string that is only newlines', () => {
    expect(parseJsonlLines('\n\n\n')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// \r\n line endings
// ---------------------------------------------------------------------------

describe('parseJsonlLines — \\r\\n line endings', () => {
  it('parses CRLF-terminated JSONL', () => {
    const input = '{"a":1}\r\n{"b":2}\r\n';
    // trim() strips \r, so CRLF lines parse identically to LF lines.
    expect(parseJsonlLines(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('handles a mix of LF and CRLF', () => {
    const input = '{"a":1}\r\n{"b":2}\n{"c":3}';
    expect(parseJsonlLines(input)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON lines
// ---------------------------------------------------------------------------

describe('parseJsonlLines — malformed JSON', () => {
  it('skips a single malformed line', () => {
    const input = '{"ok":1}\nNOT_JSON\n{"ok":2}';
    expect(parseJsonlLines(input)).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it('skips multiple consecutive malformed lines', () => {
    const input = 'bad\nalso bad\n{"ok":true}';
    expect(parseJsonlLines(input)).toEqual([{ ok: true }]);
  });

  it('returns [] when all lines are malformed', () => {
    expect(parseJsonlLines('bad\nalso bad\n{broken')).toEqual([]);
  });

  it('skips a partial/truncated JSON object', () => {
    const input = '{"a":1}\n{"truncated":\n{"b":2}';
    expect(parseJsonlLines(input)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// Null JSON values
// ---------------------------------------------------------------------------

describe('parseJsonlLines — null JSON values', () => {
  it('includes bare null by default (no guard)', () => {
    expect(parseJsonlLines('null')).toEqual([null]);
  });

  it('includes null mixed with objects (no guard)', () => {
    const input = '{"a":1}\nnull\n{"b":2}';
    expect(parseJsonlLines(input)).toEqual([{ a: 1 }, null, { b: 2 }]);
  });

  it('guard can filter out null', () => {
    const input = '{"a":1}\nnull\n{"b":2}';
    const result = parseJsonlLines<Record<string, unknown>>(input, {
      guard: (x): x is Record<string, unknown> =>
        x !== null && typeof x === 'object' && !Array.isArray(x),
    });
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// onParseError callback
// ---------------------------------------------------------------------------

describe('parseJsonlLines — onParseError callback', () => {
  it('calls onParseError once per malformed line', () => {
    const onParseError = vi.fn();
    const input = 'good\nbad\nalso_bad\n{"ok":1}';
    parseJsonlLines(input, { onParseError });
    // "good", "bad", "also_bad" are all non-JSON bare words
    expect(onParseError).toHaveBeenCalledTimes(3);
  });

  it('passes the trimmed line to onParseError', () => {
    const captured: string[] = [];
    parseJsonlLines('  bad line  \n{"ok":1}', {
      onParseError: (line) => { captured.push(line); },
    });
    expect(captured).toEqual(['bad line']);
  });

  it('does not call onParseError for blank lines', () => {
    const onParseError = vi.fn();
    parseJsonlLines('\n\n\n', { onParseError });
    expect(onParseError).not.toHaveBeenCalled();
  });

  it('does not call onParseError for guard-rejected lines (guard drops silently)', () => {
    const onParseError = vi.fn();
    // null parses successfully but fails the guard — onParseError is NOT called.
    parseJsonlLines<Record<string, unknown>>('null\n{"ok":1}', {
      guard: (x): x is Record<string, unknown> =>
        x !== null && typeof x === 'object',
      onParseError,
    });
    expect(onParseError).not.toHaveBeenCalled();
  });

  it('still returns valid parsed values when some lines error', () => {
    const result = parseJsonlLines<number>('1\nnot-a-number\n2', {
      onParseError: vi.fn(),
    });
    expect(result).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// guard function filtering
// ---------------------------------------------------------------------------

describe('parseJsonlLines — guard filtering', () => {
  it('includes only values that pass the guard', () => {
    type Numbered = { n: number };
    const isNumbered = (x: unknown): x is Numbered =>
      typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>)['n'] === 'number';

    const input = '{"n":1}\n{"other":"x"}\n{"n":2}';
    expect(parseJsonlLines<Numbered>(input, { guard: isNumbered })).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  it('returns [] when no values pass the guard', () => {
    const neverTrue = (_x: unknown): _x is never => false;
    expect(parseJsonlLines('{"a":1}\n{"b":2}', { guard: neverTrue })).toEqual([]);
  });

  it('returns all values when guard always passes', () => {
    const alwaysTrue = (_x: unknown): _x is unknown => true;
    const input = '{"a":1}\n{"b":2}';
    expect(parseJsonlLines(input, { guard: alwaysTrue })).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  it('guard-rejected lines do not appear in output', () => {
    const onlyStrings = (x: unknown): x is string => typeof x === 'string';
    const input = '"hello"\n42\n"world"';
    expect(parseJsonlLines<string>(input, { guard: onlyStrings })).toEqual([
      'hello',
      'world',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Type safety — inferred vs. guarded
// ---------------------------------------------------------------------------

describe('parseJsonlLines — type narrowing', () => {
  it('returns unknown[] without a guard', () => {
    // TypeScript type: unknown[]. Runtime: the actual parsed values.
    const result = parseJsonlLines('1\n"two"\n[3]');
    // All three parse successfully.
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe('two');
    expect(result[2]).toEqual([3]);
  });

  it('returns T[] with a guard', () => {
    const isNum = (x: unknown): x is number => typeof x === 'number';
    const result = parseJsonlLines<number>('1\n"two"\n3', { guard: isNum });
    expect(result).toEqual([1, 3]);
  });
});
