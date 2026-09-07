/**
 * Unit tests for stream-consumer.preview — configurable head/tail line counts.
 *
 * The key invariants:
 *   - Default: 7 tail lines, 0 head lines.
 *   - AFK_BASH_PREVIEW_TAIL_LINES env var overrides the tail default.
 *   - AFK_BASH_PREVIEW_HEAD_LINES env var enables head lines.
 *   - Explicit tailLines/headLines arguments take precedence over env vars.
 *   - Overlap (head + tail >= total non-empty lines): show all lines as tail,
 *     no headPreview, hiddenLineCount = 0.
 *   - Zero tail disables tailPreview; zero head disables headPreview.
 *   - Invalid env values fall back to the default.
 *   - Single-line output has no tailPreview/headPreview.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  truncateContent,
  resolveTailLines,
  resolveHeadLines,
  DEFAULT_TAIL_PREVIEW_LINES,
  MAX_PREVIEW_LINES,
} from './stream-consumer.preview.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContent(lineCount: number, prefix = 'line'): string {
  return Array.from({ length: lineCount }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

// ---------------------------------------------------------------------------
// resolveTailLines / resolveHeadLines unit tests
// ---------------------------------------------------------------------------

describe('resolveTailLines', () => {
  const originalTail = process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
  const originalHead = process.env['AFK_BASH_PREVIEW_HEAD_LINES'];

  afterEach(() => {
    // Restore env state after each test.
    if (originalTail === undefined) delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
    else process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = originalTail;
    if (originalHead === undefined) delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
    else process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = originalHead;
  });

  it('returns DEFAULT_TAIL_PREVIEW_LINES when env var is absent', () => {
    delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
    expect(resolveTailLines()).toBe(DEFAULT_TAIL_PREVIEW_LINES);
  });

  it('returns 7 as the hard-coded default', () => {
    expect(DEFAULT_TAIL_PREVIEW_LINES).toBe(7);
  });

  it('reads a valid env value', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '10';
    expect(resolveTailLines()).toBe(10);
  });

  it('allows 0 (disables tail preview)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '0';
    expect(resolveTailLines()).toBe(0);
  });

  it('allows MAX_PREVIEW_LINES', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = String(MAX_PREVIEW_LINES);
    expect(resolveTailLines()).toBe(MAX_PREVIEW_LINES);
  });

  it('falls back to default for a value above MAX_PREVIEW_LINES', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = String(MAX_PREVIEW_LINES + 1);
    expect(resolveTailLines()).toBe(DEFAULT_TAIL_PREVIEW_LINES);
  });

  it('falls back to default for a negative value', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '-1';
    expect(resolveTailLines()).toBe(DEFAULT_TAIL_PREVIEW_LINES);
  });

  it('falls back to default for a non-numeric string', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = 'abc';
    expect(resolveTailLines()).toBe(DEFAULT_TAIL_PREVIEW_LINES);
  });

  it('falls back to default for a float string', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '7.5';
    expect(resolveTailLines()).toBe(DEFAULT_TAIL_PREVIEW_LINES);
  });

  it('falls back to default for an empty string', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '';
    expect(resolveTailLines()).toBe(DEFAULT_TAIL_PREVIEW_LINES);
  });

  it('config value overrides env var when valid', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '20';
    expect(resolveTailLines(5)).toBe(5);
  });

  it('ignores invalid config value and falls through to env', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '12';
    // Passing a value outside the valid range — treated as "not set".
    expect(resolveTailLines(999)).toBe(12);
  });
});

describe('resolveHeadLines', () => {
  const originalHead = process.env['AFK_BASH_PREVIEW_HEAD_LINES'];

  afterEach(() => {
    if (originalHead === undefined) delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
    else process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = originalHead;
  });

  it('returns 0 by default (head disabled)', () => {
    delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
    expect(resolveHeadLines()).toBe(0);
  });

  it('reads a valid env value', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '3';
    expect(resolveHeadLines()).toBe(3);
  });

  it('falls back to default (0) for a negative value', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '-5';
    expect(resolveHeadLines()).toBe(0);
  });

  it('falls back to default for a non-numeric string', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = 'nope';
    expect(resolveHeadLines()).toBe(0);
  });

  it('config value overrides env var', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '5';
    expect(resolveHeadLines(2)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — default behaviour (7 tail, 0 head)
// ---------------------------------------------------------------------------

describe('truncateContent — default 7-tail', () => {
  it('single-line output: no tailPreview or headPreview', () => {
    const result = truncateContent('hello', 7, 0);
    expect(result.tailPreview).toBeUndefined();
    expect(result.headPreview).toBeUndefined();
    expect(result.lineCount).toBeUndefined();
  });

  it('multi-line output (20 lines): tailPreview has last 7 non-empty lines', () => {
    const content = makeContent(20);
    const result = truncateContent(content, 7, 0);
    expect(result.tailPreview).toHaveLength(7);
    expect(result.tailPreview![0]).toBe('line 14');
    expect(result.tailPreview![6]).toBe('line 20');
    expect(result.headPreview).toBeUndefined();
  });

  it('fewer lines than requested tail: shows all lines', () => {
    const content = makeContent(5);
    const result = truncateContent(content, 7, 0);
    // 5 lines available, requested 7 → get all 5
    expect(result.tailPreview).toHaveLength(5);
    expect(result.hiddenLineCount).toBe(0);
  });

  it('exactly 7 lines: tailPreview equals all lines, hiddenLineCount = 0', () => {
    const content = makeContent(7);
    const result = truncateContent(content, 7, 0);
    expect(result.tailPreview).toHaveLength(7);
    expect(result.hiddenLineCount).toBe(0);
  });

  it('ignores trailing blank lines when building tailPreview', () => {
    const content = makeContent(10) + '\n\n\n';
    const result = truncateContent(content, 7, 0);
    expect(result.tailPreview!.every(l => l.trim() !== '')).toBe(true);
  });

  it('hiddenLineCount = total lines - tail length', () => {
    // 20 non-empty + 0 blanks, tail = 7 → hidden = 13
    const content = makeContent(20);
    const result = truncateContent(content, 7, 0);
    expect(result.hiddenLineCount).toBe(20 - 7);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — zero tail (disabled)
// ---------------------------------------------------------------------------

describe('truncateContent — tail = 0 (disabled)', () => {
  it('multi-line output with tail=0: tailPreview is undefined', () => {
    const content = makeContent(10);
    const result = truncateContent(content, 0, 0);
    expect(result.tailPreview).toBeUndefined();
    expect(result.headPreview).toBeUndefined();
  });

  it('lineCount is still set even when tail=0', () => {
    const content = makeContent(10);
    const result = truncateContent(content, 0, 0);
    expect(result.lineCount).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — head lines
// ---------------------------------------------------------------------------

describe('truncateContent — head lines > 0', () => {
  it('head=3, tail=7: shows first 3 and last 7 of 20 lines', () => {
    const content = makeContent(20);
    const result = truncateContent(content, 7, 3);
    expect(result.headPreview).toHaveLength(3);
    expect(result.headPreview![0]).toBe('line 1');
    expect(result.headPreview![2]).toBe('line 3');
    expect(result.tailPreview).toHaveLength(7);
    expect(result.tailPreview![0]).toBe('line 14');
    expect(result.tailPreview![6]).toBe('line 20');
  });

  it('hiddenLineCount = total - head - tail displayed', () => {
    const content = makeContent(20);
    const result = truncateContent(content, 7, 3);
    // lines.length is 20 (no blank separating lines), visible = 3 + 7 = 10 → hidden = 10
    expect(result.hiddenLineCount).toBe(20 - 7 - 3);
  });

  it('head=0, tail>0: no headPreview', () => {
    const content = makeContent(10);
    const result = truncateContent(content, 5, 0);
    expect(result.headPreview).toBeUndefined();
    expect(result.tailPreview).toHaveLength(5);
  });

  it('head>0, tail=0: headPreview set, tailPreview absent', () => {
    const content = makeContent(10);
    const result = truncateContent(content, 0, 3);
    expect(result.headPreview).toHaveLength(3);
    expect(result.tailPreview).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// truncateContent — overlap (head + tail >= total non-empty lines)
// ---------------------------------------------------------------------------

describe('truncateContent — head+tail overlap', () => {
  it('head + tail > total lines: shows all as tail, no headPreview, hiddenLineCount=0', () => {
    // 5 lines, head=3, tail=7 → overlap
    const content = makeContent(5);
    const result = truncateContent(content, 7, 3);
    expect(result.headPreview).toBeUndefined();
    expect(result.tailPreview).toBeDefined();
    expect(result.hiddenLineCount).toBe(0);
  });

  it('head + tail == total lines: no hidden, all shown as tail', () => {
    // 10 lines, head=3, tail=7 → exactly 10
    const content = makeContent(10);
    const result = truncateContent(content, 7, 3);
    expect(result.headPreview).toBeUndefined();
    expect(result.tailPreview).toBeDefined();
    expect(result.hiddenLineCount).toBe(0);
  });

  it('head + tail just below total: hidden > 0', () => {
    // 11 lines, head=3, tail=7 → 1 hidden
    const content = makeContent(11);
    const result = truncateContent(content, 7, 3);
    expect(result.headPreview).toHaveLength(3);
    expect(result.tailPreview).toHaveLength(7);
    expect(result.hiddenLineCount).toBe(1);
  });

  it('all blank except a few: short non-empty set triggers overlap correctly', () => {
    // 3 non-empty lines with lots of blank lines, head=2, tail=2 → overlap
    const content = 'a\n\n\nb\n\n\nc\n\n\n';
    const result = truncateContent(content, 2, 2);
    // non-empty: ['a','b','c'] — 3 lines; head+tail = 4 >= 3 → overlap
    expect(result.headPreview).toBeUndefined();
    expect(result.hiddenLineCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — boundary / edge cases
// ---------------------------------------------------------------------------

describe('truncateContent — boundary and edge cases', () => {
  it('single-line content (no \\n): no preview fields', () => {
    const result = truncateContent('only one line', 7, 0);
    expect(result.tailPreview).toBeUndefined();
    expect(result.headPreview).toBeUndefined();
    expect(result.lineCount).toBeUndefined();
    expect(result.hiddenLineCount).toBeUndefined();
  });

  it('two-line content: multi-line path engaged', () => {
    const result = truncateContent('line1\nline2', 7, 0);
    expect(result.lineCount).toBe(2);
    expect(result.tailPreview).toBeDefined();
  });

  it('sizeBytes and sizeLabel are always present', () => {
    const result = truncateContent('hello', 7, 0);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sizeLabel).toMatch(/\d+B/);
  });

  it('large tail count (50) accepted without overflow', () => {
    const content = makeContent(20);
    const result = truncateContent(content, MAX_PREVIEW_LINES, 0);
    // 20 lines total; capped at 20 since MAX_PREVIEW_LINES > 20
    expect(result.tailPreview).toHaveLength(20);
    expect(result.hiddenLineCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — env var integration (via explicit arguments mirroring env)
// ---------------------------------------------------------------------------

describe('truncateContent — env var integration', () => {
  const originalTail = process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
  const originalHead = process.env['AFK_BASH_PREVIEW_HEAD_LINES'];

  afterEach(() => {
    if (originalTail === undefined) delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
    else process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = originalTail;
    if (originalHead === undefined) delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
    else process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = originalHead;
  });

  it('env AFK_BASH_PREVIEW_TAIL_LINES=3 changes tail count (no explicit args)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '3';
    delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
    const content = makeContent(10);
    // Call without explicit args so resolveTailLines() / resolveHeadLines() are used.
    const result = truncateContent(content);
    expect(result.tailPreview).toHaveLength(3);
  });

  it('env AFK_BASH_PREVIEW_HEAD_LINES=2 enables head preview (no explicit args)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '3';
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '2';
    const content = makeContent(10);
    const result = truncateContent(content);
    expect(result.headPreview).toHaveLength(2);
    expect(result.tailPreview).toHaveLength(3);
  });

  it('invalid env value: falls back to default 7', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = 'bad';
    delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
    const content = makeContent(20);
    const result = truncateContent(content);
    expect(result.tailPreview).toHaveLength(7);
  });
});
