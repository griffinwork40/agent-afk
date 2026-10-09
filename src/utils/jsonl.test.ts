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

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseJsonlLines, readJsonlFile, IncrementalLineReader, appendJsonl } from './jsonl.js';

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

// ---------------------------------------------------------------------------
// readJsonlFile — streaming reader
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-afk-jsonl-test-'));
}

describe('readJsonlFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('yields zero values for a non-existent file (ENOENT-safe)', async () => {
    const results: unknown[] = [];
    for await (const v of readJsonlFile(join(dir, 'nonexistent.jsonl'))) {
      results.push(v);
    }
    expect(results).toEqual([]);
  });

  it('yields all parsed values from a valid JSONL file', async () => {
    const path = join(dir, 'test.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const results: unknown[] = [];
    for await (const v of readJsonlFile(path)) {
      results.push(v);
    }
    expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('skips blank lines', async () => {
    const path = join(dir, 'blanks.jsonl');
    writeFileSync(path, '{"a":1}\n\n{"b":2}\n');
    const results: unknown[] = [];
    for await (const v of readJsonlFile(path)) {
      results.push(v);
    }
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips malformed lines', async () => {
    const path = join(dir, 'malformed.jsonl');
    writeFileSync(path, '{"ok":1}\nBAD\n{"ok":2}\n');
    const results: unknown[] = [];
    for await (const v of readJsonlFile(path)) {
      results.push(v);
    }
    expect(results).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it('calls onParseError for malformed lines', async () => {
    const path = join(dir, 'errors.jsonl');
    writeFileSync(path, '{"ok":1}\nBAD_LINE\n{"ok":2}\n');
    const errors: string[] = [];
    const results: unknown[] = [];
    for await (const v of readJsonlFile(path, { onParseError: (l) => errors.push(l) })) {
      results.push(v);
    }
    expect(errors).toEqual(['BAD_LINE']);
    expect(results).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it('applies the guard to filter values', async () => {
    const path = join(dir, 'guard.jsonl');
    writeFileSync(path, '{"n":1}\n{"other":"x"}\n{"n":2}\n');
    type Numbered = { n: number };
    const isNumbered = (x: unknown): x is Numbered =>
      typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>)['n'] === 'number';
    const results: Numbered[] = [];
    for await (const v of readJsonlFile<Numbered>(path, { guard: isNumbered })) {
      results.push(v);
    }
    expect(results).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('handles an empty file (zero values)', async () => {
    const path = join(dir, 'empty.jsonl');
    writeFileSync(path, '');
    const results: unknown[] = [];
    for await (const v of readJsonlFile(path)) {
      results.push(v);
    }
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// IncrementalLineReader
// ---------------------------------------------------------------------------

describe('IncrementalLineReader', () => {
  it('returns complete lines from a single chunk', () => {
    const reader = new IncrementalLineReader();
    const lines = reader.feed('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.bufferedLength).toBe(0);
  });

  it('buffers an incomplete trailing fragment', () => {
    const reader = new IncrementalLineReader();
    const lines = reader.feed('{"a":1}\n{"b":');
    expect(lines).toEqual(['{"a":1}']);
    expect(reader.bufferedLength).toBeGreaterThan(0);
  });

  it('completes the fragment across two feeds', () => {
    const reader = new IncrementalLineReader();
    reader.feed('{"a":1}\n{"b":');
    const lines = reader.feed('2}\n');
    expect(lines).toEqual(['{"b":2}']);
    expect(reader.bufferedLength).toBe(0);
  });

  it('flush() drains the remaining buffer', () => {
    const reader = new IncrementalLineReader();
    reader.feed('{"a":1}\n{"no-newline"');
    const flushed = reader.flush();
    expect(flushed).toEqual(['{"no-newline"']);
    expect(reader.bufferedLength).toBe(0);
  });

  it('flush() returns [] when buffer is empty', () => {
    const reader = new IncrementalLineReader();
    expect(reader.flush()).toEqual([]);
  });

  it('handles multiple chunks that each lack a newline', () => {
    const reader = new IncrementalLineReader();
    reader.feed('part');
    reader.feed('ial');
    const flushed = reader.flush();
    expect(flushed).toEqual(['partial']);
  });

  it('handles empty string feed gracefully', () => {
    const reader = new IncrementalLineReader();
    const lines = reader.feed('');
    expect(lines).toEqual([]);
    expect(reader.bufferedLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// appendJsonl
// ---------------------------------------------------------------------------

describe('appendJsonl', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file and appends a JSON line', () => {
    const path = join(dir, 'out.jsonl');
    appendJsonl(path, { x: 1 });
    const content = readFileSync(path, 'utf-8');
    expect(content).toBe('{"x":1}\n');
  });

  it('appends multiple values in order', () => {
    const path = join(dir, 'out.jsonl');
    appendJsonl(path, { a: 1 });
    appendJsonl(path, { b: 2 });
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('silently ignores errors by default (errorPolicy: ignore)', () => {
    // Write to a non-existent directory — should not throw.
    expect(() =>
      appendJsonl('/nonexistent/path/file.jsonl', { x: 1 }),
    ).not.toThrow();
  });

  it('re-throws errors when errorPolicy is throw', () => {
    expect(() =>
      appendJsonl('/nonexistent/path/file.jsonl', { x: 1 }, { errorPolicy: 'throw' }),
    ).toThrow();
  });

  it('serializes various JSON values correctly', () => {
    const path = join(dir, 'types.jsonl');
    appendJsonl(path, null);
    appendJsonl(path, 42);
    appendJsonl(path, 'hello');
    appendJsonl(path, [1, 2]);
    const lines = readFileSync(path, 'utf-8').trim().split('\n');
    expect(lines).toEqual(['null', '42', '"hello"', '[1,2]']);
  });
});
