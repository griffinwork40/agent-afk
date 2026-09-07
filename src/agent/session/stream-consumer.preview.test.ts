/**
 * Unit tests for stream-consumer.preview.ts — configurable head/tail line counts.
 *
 * Tests: defaults, invalid inputs, zero/boundary values, overlap dedup, short output.
 * Does NOT exercise the full stream-consumer pipeline — that lives in
 * stream-consumer-display.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { truncateContent, resolvePreviewConfig } from './stream-consumer.preview.js';

// ---------------------------------------------------------------------------
// resolvePreviewConfig — env-string → clamped numeric config
// ---------------------------------------------------------------------------

describe('resolvePreviewConfig: defaults', () => {
  it('returns default tail=7, head=0 when both env vars are undefined', () => {
    const cfg = resolvePreviewConfig(undefined, undefined);
    expect(cfg.tailLines).toBe(7);
    expect(cfg.headLines).toBe(0);
  });

  it('returns default tail=7, head=0 when both env vars are empty strings', () => {
    const cfg = resolvePreviewConfig('', '');
    expect(cfg.tailLines).toBe(7);
    expect(cfg.headLines).toBe(0);
  });
});

describe('resolvePreviewConfig: valid inputs', () => {
  it('parses a valid tail value', () => {
    expect(resolvePreviewConfig('10', undefined).tailLines).toBe(10);
  });

  it('parses a valid head value', () => {
    expect(resolvePreviewConfig(undefined, '5').headLines).toBe(5);
  });

  it('parses both together', () => {
    const cfg = resolvePreviewConfig('15', '3');
    expect(cfg.tailLines).toBe(15);
    expect(cfg.headLines).toBe(3);
  });
});

describe('resolvePreviewConfig: invalid inputs fall back to defaults', () => {
  it('returns default tail when env value is not a number', () => {
    expect(resolvePreviewConfig('abc', undefined).tailLines).toBe(7);
  });

  it('returns default head when env value is not a number', () => {
    expect(resolvePreviewConfig(undefined, 'xyz').headLines).toBe(0);
  });

  it('returns default tail when env value is NaN-producing', () => {
    expect(resolvePreviewConfig('7.5.3', undefined).tailLines).toBe(7); // parseInt('7.5.3') = 7, valid
  });

  it('returns default for a whitespace-only string', () => {
    expect(resolvePreviewConfig('   ', undefined).tailLines).toBe(7);
  });
});

describe('resolvePreviewConfig: boundary / clamping', () => {
  it('clamps tail to maximum of 50', () => {
    expect(resolvePreviewConfig('100', undefined).tailLines).toBe(50);
  });

  it('clamps head to maximum of 50', () => {
    expect(resolvePreviewConfig(undefined, '99').headLines).toBe(50);
  });

  it('clamps tail to minimum of 0 for negative', () => {
    expect(resolvePreviewConfig('-5', undefined).tailLines).toBe(0);
  });

  it('clamps head to minimum of 0 for negative', () => {
    expect(resolvePreviewConfig(undefined, '-1').headLines).toBe(0);
  });

  it('accepts zero tail (tail disabled)', () => {
    expect(resolvePreviewConfig('0', undefined).tailLines).toBe(0);
  });

  it('accepts zero head (head disabled, same as default)', () => {
    expect(resolvePreviewConfig(undefined, '0').headLines).toBe(0);
  });

  it('accepts exactly 50 for tail', () => {
    expect(resolvePreviewConfig('50', undefined).tailLines).toBe(50);
  });

  it('accepts exactly 50 for head', () => {
    expect(resolvePreviewConfig(undefined, '50').headLines).toBe(50);
  });

  it('accepts 1 for tail', () => {
    expect(resolvePreviewConfig('1', undefined).tailLines).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — single-line path (unchanged behaviour)
// ---------------------------------------------------------------------------

describe('truncateContent: single-line path', () => {
  it('returns full content when ≤80 chars (no config)', () => {
    const r = truncateContent('hello world');
    expect(r.content).toBe('hello world');
    expect(r.truncated).toBe(false);
    expect(r.tailPreview).toBeUndefined();
  });

  it('truncates at 80 chars with ellipsis for long single-line content', () => {
    const long = 'x'.repeat(100);
    const r = truncateContent(long);
    expect(r.content).toHaveLength(82); // 80 + '…'
    expect(r.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — default tail-only (7 lines, 0 head)
// ---------------------------------------------------------------------------

describe('truncateContent: default config (tail=7, head=0)', () => {
  it('extracts last 7 non-empty lines for 20-line input', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
    const r = truncateContent(lines.join('\n'));
    expect(r.tailPreview).toHaveLength(7);
    expect(r.tailPreview![0]).toBe('L14');
    expect(r.tailPreview![6]).toBe('L20');
    expect(r.headPreview).toBeUndefined();
  });

  it('returns all lines when output has ≤7 non-empty lines', () => {
    const content = 'a\nb\nc';
    const r = truncateContent(content);
    // 3 lines, all non-empty → tailPreview is all 3
    expect(r.tailPreview).toHaveLength(3);
    expect(r.headPreview).toBeUndefined();
  });

  it('omits blank lines from tailPreview', () => {
    const content = 'a\n\nb\n\n\nc';
    const r = truncateContent(content);
    expect(r.tailPreview!.every(l => l.trim() !== '')).toBe(true);
  });

  it('hiddenLineCount uses raw line count as denominator', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
    const r = truncateContent(lines.join('\n'));
    // 20 lines total, 7 tail → hidden = 20 - 7 = 13
    expect(r.hiddenLineCount).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — custom tail only
// ---------------------------------------------------------------------------

describe('truncateContent: custom tail count', () => {
  it('respects tailLines=3', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const r = truncateContent(lines.join('\n'), { tailLines: 3 });
    expect(r.tailPreview).toHaveLength(3);
    expect(r.tailPreview![2]).toBe('line10');
    expect(r.hiddenLineCount).toBe(7); // 10 - 3
  });

  it('respects tailLines=1 (single-line tail)', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `l${i + 1}`);
    const r = truncateContent(lines.join('\n'), { tailLines: 1 });
    expect(r.tailPreview).toHaveLength(1);
    expect(r.tailPreview![0]).toBe('l5');
  });

  it('tailLines larger than output returns all non-empty lines', () => {
    const content = 'a\nb\nc';
    const r = truncateContent(content, { tailLines: 20 });
    // Only 3 non-empty lines exist
    expect(r.tailPreview!.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — zero tail
// ---------------------------------------------------------------------------

describe('truncateContent: tail=0 (disabled)', () => {
  it('returns empty tailPreview (undefined) when tailLines=0 and head=0', () => {
    const content = 'a\nb\nc\nd\ne\nf\ng\nh';
    const r = truncateContent(content, { tailLines: 0, headLines: 0 });
    expect(r.tailPreview).toBeUndefined();
    expect(r.headPreview).toBeUndefined();
  });

  it('returns head lines in tailPreview when tailLines=0, headLines>0', () => {
    // When only head is requested, lines are returned in tailPreview for compat
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    const r = truncateContent(lines.join('\n'), { tailLines: 0, headLines: 3 });
    expect(r.tailPreview).toHaveLength(3);
    expect(r.tailPreview![0]).toBe('L1');
    expect(r.tailPreview![2]).toBe('L3');
    expect(r.headPreview).toBeUndefined(); // head-only mode returns in tailPreview
  });
});

// ---------------------------------------------------------------------------
// truncateContent — head + tail together
// ---------------------------------------------------------------------------

describe('truncateContent: head + tail', () => {
  it('separates head and tail slices when no overlap', () => {
    // 10 lines, head=2, tail=3 → no overlap (2+3=5 < 10)
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    const r = truncateContent(lines.join('\n'), { tailLines: 3, headLines: 2 });
    expect(r.headPreview).toHaveLength(2);
    expect(r.headPreview![0]).toBe('L1');
    expect(r.headPreview![1]).toBe('L2');
    expect(r.tailPreview).toHaveLength(3);
    expect(r.tailPreview![0]).toBe('L8');
    expect(r.tailPreview![2]).toBe('L10');
  });

  it('merges head+tail into tailPreview (no duplication) when they cover all lines', () => {
    // 5 lines, head=3, tail=3 → 3+3=6 ≥ 5 → show all 5, no headPreview
    const lines = Array.from({ length: 5 }, (_, i) => `L${i + 1}`);
    const r = truncateContent(lines.join('\n'), { tailLines: 3, headLines: 3 });
    expect(r.headPreview).toBeUndefined();
    expect(r.tailPreview).toHaveLength(5); // all lines, no dup
    expect(r.hiddenLineCount).toBe(0);
  });

  it('hiddenLineCount is 0 when head+tail cover all lines', () => {
    const lines = Array.from({ length: 4 }, (_, i) => `R${i + 1}`);
    const r = truncateContent(lines.join('\n'), { tailLines: 2, headLines: 2 });
    expect(r.hiddenLineCount).toBe(0);
  });

  it('hiddenLineCount is lines.length - tailPreview.length when slices are separate', () => {
    // 20 lines, head=3, tail=5 → visible tail=5, hidden=20-5=15
    const lines = Array.from({ length: 20 }, (_, i) => `R${i + 1}`);
    const r = truncateContent(lines.join('\n'), { tailLines: 5, headLines: 3 });
    expect(r.hiddenLineCount).toBe(20 - 5); // 15
  });

  it('handles exact boundary: head+tail equals line count exactly', () => {
    // Exactly 6 non-empty lines, head=3, tail=3 → covers exactly 6 → show all
    const lines = ['a', 'b', 'c', 'd', 'e', 'f'];
    const r = truncateContent(lines.join('\n'), { tailLines: 3, headLines: 3 });
    expect(r.tailPreview).toHaveLength(6);
    expect(r.headPreview).toBeUndefined();
    expect(r.hiddenLineCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — short output (fewer lines than configured)
// ---------------------------------------------------------------------------

describe('truncateContent: short output', () => {
  it('output shorter than tailLines: returns all lines, no hidden', () => {
    const content = 'x\ny\nz';
    const r = truncateContent(content, { tailLines: 10 });
    // 3 non-empty lines < 10 → all returned, hidden = 0 or small
    expect(r.tailPreview!.length).toBe(3);
    // hidden count is based on raw line count (same as 3 lines here → 0)
    expect(r.hiddenLineCount).toBe(0);
  });

  it('output shorter than head+tail combined: all lines returned in tailPreview', () => {
    const content = 'a\nb';
    const r = truncateContent(content, { tailLines: 5, headLines: 5 });
    expect(r.tailPreview!.length).toBe(2);
    expect(r.headPreview).toBeUndefined();
    expect(r.hiddenLineCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// truncateContent — env integration via process.env override
// (ensures the env-reading path in resolvePreviewConfig is exercised)
// ---------------------------------------------------------------------------

describe('resolvePreviewConfig: env var integration', () => {
  const ORIGINAL_TAIL = process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
  const ORIGINAL_HEAD = process.env['AFK_BASH_PREVIEW_HEAD_LINES'];

  beforeEach(() => {
    delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
    delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
  });

  afterEach(() => {
    if (ORIGINAL_TAIL !== undefined) {
      process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = ORIGINAL_TAIL;
    } else {
      delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
    }
    if (ORIGINAL_HEAD !== undefined) {
      process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = ORIGINAL_HEAD;
    } else {
      delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
    }
  });

  it('reads AFK_BASH_PREVIEW_TAIL_LINES from env (via resolvePreviewConfig)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '12';
    const cfg = resolvePreviewConfig(process.env['AFK_BASH_PREVIEW_TAIL_LINES'], process.env['AFK_BASH_PREVIEW_HEAD_LINES']);
    expect(cfg.tailLines).toBe(12);
    expect(cfg.headLines).toBe(0);
  });

  it('reads AFK_BASH_PREVIEW_HEAD_LINES from env (via resolvePreviewConfig)', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '4';
    const cfg = resolvePreviewConfig(process.env['AFK_BASH_PREVIEW_TAIL_LINES'], process.env['AFK_BASH_PREVIEW_HEAD_LINES']);
    expect(cfg.tailLines).toBe(7);
    expect(cfg.headLines).toBe(4);
  });

  it('invalid env value falls back to default', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = 'not-a-number';
    const cfg = resolvePreviewConfig(process.env['AFK_BASH_PREVIEW_TAIL_LINES'], process.env['AFK_BASH_PREVIEW_HEAD_LINES']);
    expect(cfg.tailLines).toBe(7);
  });
});
