/**
 * Unit tests for `truncateContent` and `getPreviewConfig` in
 * stream-consumer.preview.ts, covering configurable head/tail preview sizing.
 *
 * Tests mutate `process.env` per-case (restored in afterEach) to exercise the
 * lazy getter pattern — env vars are re-read on each `getPreviewConfig()` call,
 * so no module reload is needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { truncateContent, getPreviewConfig } from './stream-consumer.preview.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeLines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

// Capture and restore env vars around each test.
let savedTail: string | undefined;
let savedHead: string | undefined;

beforeEach(() => {
  savedTail = process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
  savedHead = process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
  delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
  delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
});

afterEach(() => {
  if (savedTail === undefined) delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
  else process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = savedTail;
  if (savedHead === undefined) delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
  else process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = savedHead;
});

// ── getPreviewConfig ──────────────────────────────────────────────────────────

describe('getPreviewConfig', () => {
  it('returns defaults (tail=7, head=0) when no env vars are set', () => {
    const cfg = getPreviewConfig();
    expect(cfg.tailLines).toBe(7);
    expect(cfg.headLines).toBe(0);
  });

  it('reads AFK_BASH_PREVIEW_TAIL_LINES when set to a valid value', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '10';
    expect(getPreviewConfig().tailLines).toBe(10);
  });

  it('reads AFK_BASH_PREVIEW_HEAD_LINES when set to a valid value', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '3';
    expect(getPreviewConfig().headLines).toBe(3);
  });

  it('clamps tail count = 0 up to minimum of 1', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '0';
    expect(getPreviewConfig().tailLines).toBe(1);
  });

  it('clamps tail count = 999 down to maximum of 50', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '999';
    expect(getPreviewConfig().tailLines).toBe(50);
  });

  it('clamps tail count = -5 up to minimum of 1', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '-5';
    expect(getPreviewConfig().tailLines).toBe(1);
  });

  it('clamps head count = 999 down to maximum of 50', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '999';
    expect(getPreviewConfig().headLines).toBe(50);
  });

  it('head count = 0 stays at 0 (disabled)', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '0';
    expect(getPreviewConfig().headLines).toBe(0);
  });

  it('falls back to default tail=7 on invalid (non-numeric) env var', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = 'banana';
    expect(getPreviewConfig().tailLines).toBe(7);
  });

  it('falls back to default head=0 on invalid env var', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = 'nope';
    expect(getPreviewConfig().headLines).toBe(0);
  });

  it('falls back to defaults on empty-string env vars', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '';
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '';
    const cfg = getPreviewConfig();
    expect(cfg.tailLines).toBe(7);
    expect(cfg.headLines).toBe(0);
  });
});

// ── truncateContent — defaults ────────────────────────────────────────────────

describe('truncateContent defaults (tail=7, head=0)', () => {
  it('returns 7 tail lines for 20-line input', () => {
    const result = truncateContent(makeLines(20));
    expect(result.tailPreview).toBeDefined();
    expect(result.tailPreview).toHaveLength(7);
    expect(result.tailPreview![6]).toBe('line 20');
    expect(result.tailPreview![0]).toBe('line 14');
  });

  it('does not set headPreview when head=0 (default)', () => {
    const result = truncateContent(makeLines(20));
    expect(result.headPreview).toBeUndefined();
  });

  it('hiddenLineCount is lineCount - tailLen with no head', () => {
    const content = makeLines(10);
    const result = truncateContent(content);
    const lines = content.split('\n');
    // 10 non-empty lines → tail=7 → hidden = 10 - 7 = 3
    expect(result.hiddenLineCount).toBe(lines.length - 7);
  });

  it('short output (≤ tail count): all lines in tailPreview, hiddenLineCount=0', () => {
    const result = truncateContent('a\nb\nc');
    expect(result.tailPreview).toBeDefined();
    // 3 non-empty lines, tail=7 → all 3 shown
    expect(result.tailPreview).toHaveLength(3);
    expect(result.hiddenLineCount).toBe(0);
    expect(result.headPreview).toBeUndefined();
  });

  it('single-line content: no tailPreview or headPreview', () => {
    const result = truncateContent('just one line');
    expect(result.tailPreview).toBeUndefined();
    expect(result.headPreview).toBeUndefined();
    expect(result.hiddenLineCount).toBeUndefined();
  });
});

// ── truncateContent — custom tail ─────────────────────────────────────────────

describe('truncateContent custom tail count', () => {
  it('respects AFK_BASH_PREVIEW_TAIL_LINES=3', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '3';
    const content = makeLines(10);
    const result = truncateContent(content);
    expect(result.tailPreview).toHaveLength(3);
    expect(result.tailPreview![2]).toBe('line 10');
    expect(result.tailPreview![0]).toBe('line 8');
  });

  it('tail=50 on 20-line input yields all 20 non-empty lines', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '50';
    const result = truncateContent(makeLines(20));
    expect(result.tailPreview).toHaveLength(20);
    expect(result.hiddenLineCount).toBe(0);
  });
});

// ── truncateContent — head lines ──────────────────────────────────────────────

describe('truncateContent head lines', () => {
  it('headPreview contains first M lines when head=3', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '3';
    const content = makeLines(10);
    const result = truncateContent(content);
    expect(result.headPreview).toBeDefined();
    expect(result.headPreview).toHaveLength(3);
    expect(result.headPreview![0]).toBe('line 1');
    expect(result.headPreview![2]).toBe('line 3');
  });

  it('tailPreview still present when head is enabled', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '3';
    const content = makeLines(10);
    const result = truncateContent(content);
    expect(result.tailPreview).toBeDefined();
    expect(result.tailPreview).toHaveLength(7);
    expect(result.tailPreview![6]).toBe('line 10');
  });

  it('hiddenLineCount accounts for both head and tail when both are set', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '3';
    // tail default=7, head=3, 20-line input → displayed=10, hidden = lines - 10
    const content = makeLines(20);
    const result = truncateContent(content);
    const lines = content.split('\n');
    // displayed: head=3 + tail=7 = 10 non-empty; hidden = lines.length - 10
    expect(result.hiddenLineCount).toBe(lines.length - 10);
  });

  it('head=0 disables headPreview even when env var is explicitly "0"', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '0';
    const result = truncateContent(makeLines(10));
    expect(result.headPreview).toBeUndefined();
  });
});

// ── truncateContent — overlap deduplication ───────────────────────────────────

describe('truncateContent overlap deduplication', () => {
  it('overlap (head=5, tail=8, 10 lines): collapsed to one block, hiddenLineCount=0', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '8';
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '5';
    // head(5) + tail(8) = 13 ≥ 10 non-empty lines → full output, no gap
    const result = truncateContent(makeLines(10));
    // All 10 non-empty lines in tailPreview; headPreview collapsed to undefined
    expect(result.tailPreview).toHaveLength(10);
    expect(result.headPreview).toBeUndefined();
    expect(result.hiddenLineCount).toBe(0);
  });

  it('exact overlap (head + tail == total): no hidden, no duplication', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '5';
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '5';
    // head(5) + tail(5) = 10 == 10 non-empty → full merge
    const content = makeLines(10);
    const result = truncateContent(content);
    expect(result.tailPreview).toHaveLength(10);
    expect(result.headPreview).toBeUndefined();
    expect(result.hiddenLineCount).toBe(0);
  });

  it('no overlap (head=2, tail=3, 20 lines): separate blocks with gap', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '3';
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '2';
    const content = makeLines(20);
    const result = truncateContent(content);
    expect(result.headPreview).toHaveLength(2);
    expect(result.tailPreview).toHaveLength(3);
    // hidden = lines.length - (head + tail) = 20 - 5 = 15
    const lines = content.split('\n');
    expect(result.hiddenLineCount).toBe(lines.length - 5);
    expect(result.hiddenLineCount).toBeGreaterThan(0);
  });
});

// ── truncateContent — hiddenLineCount accuracy ────────────────────────────────

describe('truncateContent hiddenLineCount accuracy', () => {
  it('hiddenLineCount is 0 for output shorter than tail count', () => {
    const result = truncateContent(makeLines(4)); // 4 < 7 default tail
    expect(result.hiddenLineCount).toBe(0);
  });

  it('hiddenLineCount matches lines.length - tailPreview.length in tail-only mode', () => {
    const content = makeLines(15);
    const lines = content.split('\n');
    const result = truncateContent(content);
    // default tail=7
    expect(result.hiddenLineCount).toBe(lines.length - 7);
  });

  it('hiddenLineCount uses lines.length denominator (not nonEmpty.length), matching lineCount', () => {
    // Intersperse blank lines to create a gap between lines.length and nonEmpty.length
    const content = 'a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng\n\nh\n\ni\n\nj\n';
    const lines = content.split('\n');
    const nonEmpty = lines.filter(l => l.trim() !== '');
    const result = truncateContent(content);
    // tail default=7, nonEmpty.length=10 → tailPreview=7 non-empty lines
    // hiddenLineCount = lines.length - tailPreview.length (7 non-empty selected)
    // The test checks the contract: lineCount === lines.length and
    // hiddenLineCount = lines.length - tailPreview.length
    expect(result.lineCount).toBe(lines.length);
    expect(result.tailPreview).toBeDefined();
    const tailLen = result.tailPreview!.length;
    expect(result.hiddenLineCount).toBe(lines.length - tailLen);
    // Sanity: all tailPreview entries are non-empty
    expect(result.tailPreview!.every(l => l.trim() !== '')).toBe(true);
    // Non-empty count check
    expect(nonEmpty.length).toBe(10);
  });
});
