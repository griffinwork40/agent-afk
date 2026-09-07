/**
 * Unit tests for stream-consumer.preview.ts — configurable preview size.
 *
 * Covers: defaults, custom tail/head values, zero/boundary values,
 * head+tail overlap (no duplication), short output, and invalid inputs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { truncateContent } from './stream-consumer.preview.js';

// Helper: build a multi-line string of N lines (e.g. "line 1\nline 2\n...")
function makeLines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

// Save and restore process.env around env-var tests.
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {
    AFK_BASH_PREVIEW_TAIL: process.env['AFK_BASH_PREVIEW_TAIL'],
    AFK_BASH_PREVIEW_HEAD: process.env['AFK_BASH_PREVIEW_HEAD'],
  };
  delete process.env['AFK_BASH_PREVIEW_TAIL'];
  delete process.env['AFK_BASH_PREVIEW_HEAD'];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── Defaults ─────────────────────────────────────────────────────────────────

describe('truncateContent — defaults', () => {
  it('retains 7-line tail as default (no env var, no opts)', () => {
    const content = makeLines(20);
    const result = truncateContent(content);
    expect(result.tailPreview).toHaveLength(7);
    expect(result.tailPreview![0]).toBe('line 14');
    expect(result.tailPreview![6]).toBe('line 20');
  });

  it('default head is 0 (no head lines shown)', () => {
    // With default head=0, tailPreview contains only the tail lines.
    const content = makeLines(20);
    const result = truncateContent(content);
    // All 7 tail preview entries should be from the end, not the start.
    expect(result.tailPreview).not.toContain('line 1');
    expect(result.tailPreview).not.toContain('line 2');
  });

  it('hiddenLineCount defaults to total minus tail (7)', () => {
    const content = makeLines(20);
    const result = truncateContent(content);
    // lines.length = 20 (no trailing newline), tailPreview.length = 7
    expect(result.hiddenLineCount).toBe(13); // 20 - 7
  });

  it('single-line content: no tailPreview (unchanged behaviour)', () => {
    const result = truncateContent('just one line');
    expect(result.tailPreview).toBeUndefined();
    expect(result.hiddenLineCount).toBeUndefined();
  });
});

// ── Custom tail line count via opts ──────────────────────────────────────────

describe('truncateContent — custom tail via opts', () => {
  it('respects tailLines: 3', () => {
    const content = makeLines(20);
    const result = truncateContent(content, { tailLines: 3 });
    expect(result.tailPreview).toHaveLength(3);
    expect(result.tailPreview![2]).toBe('line 20');
    expect(result.tailPreview![0]).toBe('line 18');
  });

  it('respects tailLines: 15 (more than default)', () => {
    const content = makeLines(20);
    const result = truncateContent(content, { tailLines: 15 });
    expect(result.tailPreview).toHaveLength(15);
    expect(result.tailPreview![14]).toBe('line 20');
    expect(result.tailPreview![0]).toBe('line 6');
  });

  it('tailLines larger than total shows all lines', () => {
    const content = makeLines(5);
    const result = truncateContent(content, { tailLines: 10 });
    expect(result.tailPreview).toHaveLength(5);
    expect(result.hiddenLineCount).toBe(0); // 5 - 5 = 0
  });
});

// ── Custom head line count via opts ──────────────────────────────────────────

describe('truncateContent — custom head via opts', () => {
  it('respects headLines: 3 with default tail (7)', () => {
    const content = makeLines(20);
    const result = truncateContent(content, { headLines: 3 });
    // Should have head(3) + tail(7) = 10 entries (no overlap at 20 lines)
    expect(result.tailPreview).toHaveLength(10);
    // First 3 are head lines
    expect(result.tailPreview![0]).toBe('line 1');
    expect(result.tailPreview![1]).toBe('line 2');
    expect(result.tailPreview![2]).toBe('line 3');
    // Last 7 are tail lines
    expect(result.tailPreview![3]).toBe('line 14');
    expect(result.tailPreview![9]).toBe('line 20');
  });

  it('headLines only (tailLines: 0) shows only head', () => {
    const content = makeLines(20);
    const result = truncateContent(content, { tailLines: 0, headLines: 3 });
    expect(result.tailPreview).toHaveLength(3);
    expect(result.tailPreview![0]).toBe('line 1');
    expect(result.tailPreview![2]).toBe('line 3');
  });
});

// ── Zero and boundary values ──────────────────────────────────────────────────

describe('truncateContent — zero and boundary values', () => {
  it('tailLines: 0 and headLines: 0 → empty tailPreview', () => {
    const content = makeLines(20);
    const result = truncateContent(content, { tailLines: 0, headLines: 0 });
    expect(result.tailPreview).toHaveLength(0);
    // hiddenLineCount = lines.length - 0 = 20
    expect(result.hiddenLineCount).toBe(20);
  });

  it('tailLines: 0 disables tail, headLines: 0 disables head (default)', () => {
    const content = makeLines(10);
    const result = truncateContent(content, { tailLines: 0 });
    // head=0 (default), tail=0 → empty
    expect(result.tailPreview).toHaveLength(0);
  });

  it('tailLines: 1 shows exactly one tail line', () => {
    const content = makeLines(10);
    const result = truncateContent(content, { tailLines: 1 });
    expect(result.tailPreview).toHaveLength(1);
    expect(result.tailPreview![0]).toBe('line 10');
  });

  it('tailLines: 200 (max) is accepted', () => {
    const content = makeLines(50);
    const result = truncateContent(content, { tailLines: 200 });
    // Only 50 lines exist; tailPreview has all 50.
    expect(result.tailPreview).toHaveLength(50);
    expect(result.hiddenLineCount).toBe(0);
  });

  it('tailLines: 201 clamps to 200', () => {
    const content = makeLines(250);
    const result = truncateContent(content, { tailLines: 201 });
    expect(result.tailPreview).toHaveLength(200);
  });

  it('tailLines: -1 clamps to 0 (empty preview)', () => {
    const content = makeLines(10);
    const result = truncateContent(content, { tailLines: -1 });
    expect(result.tailPreview).toHaveLength(0);
  });
});

// ── Overlap: head + tail ≥ total ─────────────────────────────────────────────

describe('truncateContent — head/tail overlap avoidance', () => {
  it('no duplication when head + tail = total lines', () => {
    // 10 lines, head=5, tail=5 → head + tail = 10 = total
    const content = makeLines(10);
    const result = truncateContent(content, { headLines: 5, tailLines: 5 });
    expect(result.tailPreview).toHaveLength(10);
    // Lines are unique (no duplicates)
    const unique = new Set(result.tailPreview);
    expect(unique.size).toBe(10);
    expect(result.hiddenLineCount).toBe(0);
  });

  it('no duplication when head + tail exceeds total lines', () => {
    // 10 lines, head=7, tail=7 → head + tail = 14 > 10
    const content = makeLines(10);
    const result = truncateContent(content, { headLines: 7, tailLines: 7 });
    expect(result.tailPreview).toHaveLength(10);
    const unique = new Set(result.tailPreview);
    expect(unique.size).toBe(10);
    expect(result.hiddenLineCount).toBe(0);
  });

  it('no duplication when head + tail > total (edge: 1 head, 1 tail, 1 line)', () => {
    const content = 'only line\nsecond line';
    const result = truncateContent(content, { headLines: 1, tailLines: 1 });
    // 2 lines total, head+tail = 2 = total
    expect(result.tailPreview).toHaveLength(2);
    const unique = new Set(result.tailPreview);
    expect(unique.size).toBe(2);
  });

  it('hidden count correct when head + tail < total (no overlap)', () => {
    // 20 lines, head=2, tail=3 → 5 displayed, 15 hidden
    const content = makeLines(20);
    const result = truncateContent(content, { headLines: 2, tailLines: 3 });
    expect(result.tailPreview).toHaveLength(5);
    expect(result.hiddenLineCount).toBe(15); // 20 - 5
  });
});

// ── Short output (≤80 chars) ──────────────────────────────────────────────────

describe('truncateContent — short multi-line output', () => {
  it('short content (≤80 chars): tailPreview still set with custom tailLines', () => {
    // "a\nb\nc\nd" is well under 80 chars but multi-line.
    const result = truncateContent('a\nb\nc\nd', { tailLines: 2 });
    expect(result.truncated).toBe(false);
    // tailPreview uses the configured tail count
    expect(result.tailPreview).toHaveLength(2);
    expect(result.tailPreview![1]).toBe('d');
    expect(result.tailPreview![0]).toBe('c');
  });

  it('short content with head+tail shows both', () => {
    const result = truncateContent('a\nb\nc\nd\ne', { headLines: 1, tailLines: 1 });
    expect(result.truncated).toBe(false);
    expect(result.tailPreview).toHaveLength(2);
    expect(result.tailPreview![0]).toBe('a'); // head
    expect(result.tailPreview![1]).toBe('e'); // tail
  });
});

// ── Env var precedence ────────────────────────────────────────────────────────

describe('truncateContent — env var precedence', () => {
  it('AFK_BASH_PREVIEW_TAIL overrides opts.tailLines', () => {
    process.env['AFK_BASH_PREVIEW_TAIL'] = '3';
    const content = makeLines(20);
    const result = truncateContent(content, { tailLines: 10 });
    // env var (3) takes precedence over opts (10)
    expect(result.tailPreview).toHaveLength(3);
    expect(result.tailPreview![2]).toBe('line 20');
  });

  it('AFK_BASH_PREVIEW_HEAD overrides opts.headLines', () => {
    process.env['AFK_BASH_PREVIEW_HEAD'] = '2';
    const content = makeLines(20);
    const result = truncateContent(content, { headLines: 5, tailLines: 0 });
    // env var head (2) takes precedence over opts head (5), tail is 0 via opts
    // BUT AFK_BASH_PREVIEW_TAIL is unset, so default tail (7) applies
    // head(2) + tail(7) = 9, no overlap at 20 lines
    expect(result.tailPreview).toHaveLength(9);
    expect(result.tailPreview![0]).toBe('line 1');
    expect(result.tailPreview![1]).toBe('line 2');
  });

  it('AFK_BASH_PREVIEW_TAIL=0 disables tail', () => {
    process.env['AFK_BASH_PREVIEW_TAIL'] = '0';
    const content = makeLines(20);
    const result = truncateContent(content);
    // tail=0, head=0 (default) → empty preview
    expect(result.tailPreview).toHaveLength(0);
  });

  it('AFK_BASH_PREVIEW_TAIL with invalid value falls back to default (7)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL'] = 'notanumber';
    const content = makeLines(20);
    const result = truncateContent(content);
    expect(result.tailPreview).toHaveLength(7);
  });

  it('AFK_BASH_PREVIEW_TAIL with out-of-range value is clamped (e.g. 999 → 200)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL'] = '999';
    const content = makeLines(250);
    const result = truncateContent(content);
    expect(result.tailPreview).toHaveLength(200);
  });

  it('AFK_BASH_PREVIEW_TAIL with negative value clamps to 0', () => {
    process.env['AFK_BASH_PREVIEW_TAIL'] = '-5';
    const content = makeLines(20);
    const result = truncateContent(content);
    expect(result.tailPreview).toHaveLength(0);
  });
});

// ── Empty lines are excluded from preview ────────────────────────────────────

describe('truncateContent — empty line handling', () => {
  it('trailing empty lines are excluded from tailPreview', () => {
    const content = makeLines(10) + '\n\n\n';
    const result = truncateContent(content, { tailLines: 3 });
    // tailPreview should contain only non-empty lines
    expect(result.tailPreview!.every(l => l.trim() !== '')).toBe(true);
    expect(result.tailPreview![2]).toBe('line 10');
  });

  it('hiddenLineCount accounts for all lines including empty ones', () => {
    // 5 content lines + 3 empty lines = 8 total lines in lines.split('\n')
    // but with a trailing newline, split gives an extra empty entry
    const content = 'a\nb\nc\nd\ne\n\n\n';
    const result = truncateContent(content, { tailLines: 2 });
    // nonEmptyLines = ['a','b','c','d','e'], tailPreview = ['d','e']
    // lines = content.split('\n') which for 'a\nb\nc\nd\ne\n\n\n' gives 8 entries
    expect(result.tailPreview).toHaveLength(2);
    expect(result.tailPreview![1]).toBe('e');
    // hiddenLineCount = lines.length (8) - tailPreview.length (2) = 6
    expect(result.hiddenLineCount).toBe(6);
  });
});
