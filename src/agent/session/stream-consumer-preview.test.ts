/**
 * Unit tests for `truncateContent` — the configurable head/tail preview logic.
 *
 * Covers: defaults, custom tail, head+tail, overlap, zero tail,
 * short output, boundary values, and hiddenLineCount correctness.
 */

import { describe, it, expect } from 'vitest';
import { truncateContent, PREVIEW_LINES_MAX } from './stream-consumer.preview.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

// ── Default behaviour (no opts) ────────────────────────────────────────────

describe('truncateContent: defaults', () => {
  it('single-line ≤80 chars: no tail/head preview set', () => {
    const r = truncateContent('hello world');
    expect(r.tailPreview).toBeUndefined();
    expect(r.headPreview).toBeUndefined();
    expect(r.hiddenLineCount).toBeUndefined();
  });

  it('multi-line: tailPreview has at most 7 items, headPreview absent', () => {
    const content = makeLines(20);
    const r = truncateContent(content);
    expect(r.tailPreview).toBeDefined();
    expect(r.tailPreview!.length).toBe(7);
    expect(r.tailPreview![6]).toBe('line 20');
    expect(r.tailPreview![0]).toBe('line 14');
    expect(r.headPreview).toBeUndefined();
  });

  it('multi-line: hiddenLineCount = lines.length − tailPreview.length', () => {
    const content = makeLines(20);
    const r = truncateContent(content);
    // 20 non-empty lines, 7 in tail → 13 hidden (but lines.length also 20 with no blanks)
    expect(r.hiddenLineCount).toBe(20 - 7);
  });

  it('short output (fewer lines than 7): shows all, hiddenLineCount = 0', () => {
    const content = makeLines(4);
    const r = truncateContent(content);
    expect(r.tailPreview).toBeDefined();
    expect(r.tailPreview!.length).toBe(4);
    expect(r.hiddenLineCount).toBe(0);
  });

  it('exactly 7 lines: shows all 7, hiddenLineCount = 0', () => {
    const content = makeLines(7);
    const r = truncateContent(content);
    expect(r.tailPreview!.length).toBe(7);
    expect(r.hiddenLineCount).toBe(0);
  });
});

// ── Custom tail ─────────────────────────────────────────────────────────────

describe('truncateContent: custom tailLines', () => {
  it('tailLines: 3 → 3 tail lines', () => {
    const content = makeLines(20);
    const r = truncateContent(content, { tailLines: 3 });
    expect(r.tailPreview!.length).toBe(3);
    expect(r.tailPreview![2]).toBe('line 20');
    expect(r.hiddenLineCount).toBe(20 - 3);
  });

  it('tailLines: 0 → no tailPreview, all lines hidden', () => {
    const content = makeLines(10);
    const r = truncateContent(content, { tailLines: 0 });
    // When tailLines=0 and headLines=0: overlap check (0+0=0 < 10) so tailPreview=undefined
    expect(r.tailPreview).toBeUndefined();
    expect(r.hiddenLineCount).toBe(10); // all lines.length worth
  });

  it('tailLines: 50 (max allowed) → clamped at 50', () => {
    const content = makeLines(60);
    const r = truncateContent(content, { tailLines: 50 });
    expect(r.tailPreview!.length).toBe(50);
  });

  it('tailLines: 51 (above max) → clamped to 50', () => {
    const content = makeLines(60);
    const r = truncateContent(content, { tailLines: 51 });
    expect(r.tailPreview!.length).toBe(50);
  });

  it('tailLines: negative → falls back to default 7', () => {
    const content = makeLines(20);
    const r = truncateContent(content, { tailLines: -1 });
    expect(r.tailPreview!.length).toBe(7);
  });

  it('tailLines: NaN → falls back to default 7', () => {
    const content = makeLines(20);
    const r = truncateContent(content, { tailLines: NaN });
    expect(r.tailPreview!.length).toBe(7);
  });

  it('tailLines: 1.5 (non-integer) → falls back to default 7', () => {
    const content = makeLines(20);
    const r = truncateContent(content, { tailLines: 1.5 });
    expect(r.tailPreview!.length).toBe(7);
  });
});

// ── Head lines ──────────────────────────────────────────────────────────────

describe('truncateContent: headLines', () => {
  it('headLines: 2 with default tail → headPreview has 2 items, tailPreview has 7', () => {
    const content = makeLines(20);
    const r = truncateContent(content, { headLines: 2 });
    expect(r.headPreview).toBeDefined();
    expect(r.headPreview!.length).toBe(2);
    expect(r.headPreview![0]).toBe('line 1');
    expect(r.headPreview![1]).toBe('line 2');
    expect(r.tailPreview!.length).toBe(7);
    expect(r.hiddenLineCount).toBe(20 - 2 - 7);
  });

  it('headLines: 0 → headPreview absent', () => {
    const content = makeLines(20);
    const r = truncateContent(content, { headLines: 0 });
    expect(r.headPreview).toBeUndefined();
  });

  it('headLines: 3, tailLines: 3 → correct hiddenLineCount', () => {
    const content = makeLines(20);
    const r = truncateContent(content, { headLines: 3, tailLines: 3 });
    expect(r.headPreview!.length).toBe(3);
    expect(r.tailPreview!.length).toBe(3);
    expect(r.hiddenLineCount).toBe(20 - 3 - 3);
  });

  it('headLines: negative → falls back to default 0 (no head)', () => {
    const content = makeLines(20);
    const r = truncateContent(content, { headLines: -1 });
    expect(r.headPreview).toBeUndefined();
  });
});

// ── Overlap detection ───────────────────────────────────────────────────────

describe('truncateContent: overlap', () => {
  it('headLines + tailLines >= nonEmptyLines → show all, headPreview cleared', () => {
    // 6 non-empty lines, head=4, tail=4 → 8 >= 6 → overlap
    const content = makeLines(6);
    const r = truncateContent(content, { headLines: 4, tailLines: 4 });
    expect(r.headPreview).toBeUndefined();
    expect(r.tailPreview).toBeDefined();
    expect(r.tailPreview!.length).toBe(6); // all lines
    expect(r.hiddenLineCount).toBe(0);
  });

  it('headLines + tailLines === nonEmptyLines → show all (exact equality)', () => {
    const content = makeLines(10);
    const r = truncateContent(content, { headLines: 5, tailLines: 5 });
    expect(r.headPreview).toBeUndefined();
    expect(r.tailPreview!.length).toBe(10);
    expect(r.hiddenLineCount).toBe(0);
  });

  it('headLines + tailLines = 1 less than nonEmptyLines → NOT overlap', () => {
    const content = makeLines(10);
    const r = truncateContent(content, { headLines: 4, tailLines: 5 });
    // 4 + 5 = 9 < 10 → no overlap
    expect(r.headPreview!.length).toBe(4);
    expect(r.tailPreview!.length).toBe(5);
    expect(r.hiddenLineCount).toBe(10 - 4 - 5);
  });

  it('overlap with trailing blank lines: denominator is total lines count', () => {
    // 5 non-empty lines, 3 trailing blanks → lines.length=8, nonEmpty=5
    const content = 'a\nb\nc\nd\ne\n\n\n';
    const r = truncateContent(content, { headLines: 3, tailLines: 3 });
    // 3+3=6 >= 5 → overlap → show all non-empty
    expect(r.headPreview).toBeUndefined();
    expect(r.tailPreview!.length).toBe(5);
    expect(r.hiddenLineCount).toBe(0);
  });
});

// ── Short output (fewer lines than configured) ──────────────────────────────

describe('truncateContent: short output', () => {
  it('2 lines with tailLines=7 → shows both, hiddenLineCount=0', () => {
    const r = truncateContent('a\nb', { tailLines: 7 });
    expect(r.tailPreview!.length).toBe(2);
    expect(r.hiddenLineCount).toBe(0);
  });

  it('content fits 80 chars → verbatim content, lineCount+tailPreview still set', () => {
    const content = 'x\ny\nz';
    const r = truncateContent(content, { tailLines: 3 });
    expect(r.content).toBe(content);
    expect(r.truncated).toBe(false);
    expect(r.lineCount).toBe(3);
    expect(r.tailPreview!.length).toBe(3);
  });
});

// ── hiddenLineCount denominator consistency ─────────────────────────────────

describe('truncateContent: hiddenLineCount denominator', () => {
  it('blank lines count toward lines.length but not nonEmpty for tail sizing', () => {
    // 3 non-empty, 5 blank separators → lines.length = 9 (split on \n)
    const content = 'a\n\nb\n\nc\n\n\n\n';
    const r = truncateContent(content, { tailLines: 2 });
    // nonEmpty = ['a','b','c'], tail = last 2 = ['b','c']
    expect(r.tailPreview).toEqual(['b', 'c']);
    // hiddenLineCount = lines.length - headLen - tailLen
    // lines.length = 9 (split produces 9 parts), tailLen = 2
    const linesLength = content.split('\n').length;
    expect(r.hiddenLineCount).toBe(linesLength - 2);
  });
});

// ── PREVIEW_LINES_MAX export ────────────────────────────────────────────────

describe('PREVIEW_LINES_MAX', () => {
  it('is 50', () => {
    expect(PREVIEW_LINES_MAX).toBe(50);
  });
});
