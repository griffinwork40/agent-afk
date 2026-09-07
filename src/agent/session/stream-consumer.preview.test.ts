/**
 * Tests for configurable bash output preview size (head/tail line counts).
 *
 * Covers: default behavior, custom tail/head, tail=0, head+tail overlap,
 * short output, invalid env values, zero boundary, and hiddenLineCount formula.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { truncateContent } from './stream-consumer.preview.js';

// Helper that builds a multi-line string with the given number of lines.
// Lines are numbered "line-1\nline-2\n…" (non-empty so they count).
function makeLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line-${i + 1}`).join('\n');
}

describe('truncateContent – preview size configuration', () => {
  // Capture the original values so we can restore them after each test.
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.AFK_BASH_PREVIEW_TAIL_LINES = process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
    originalEnv.AFK_BASH_PREVIEW_HEAD_LINES = process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
    // Start each test with defaults unset so env.ts lazy getters see undefined.
    delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
    delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
  });

  afterEach(() => {
    // Restore original values.
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // ── Default behavior ────────────────────────────────────────────────────────

  it('default: shows last 7 non-empty lines, no head lines', () => {
    const input = makeLines(20); // 20 non-empty lines
    const result = truncateContent(input);

    expect(result.tailPreview).toHaveLength(7);
    expect(result.tailPreview).toEqual(['line-14', 'line-15', 'line-16', 'line-17', 'line-18', 'line-19', 'line-20']);
    expect(result.headPreview).toBeUndefined();
    // hiddenLineCount = 20 (lines.length) - 0 (head) - 7 (tail) = 13
    expect(result.hiddenLineCount).toBe(13);
  });

  it('default: output shorter than 7 lines shows all lines in tail', () => {
    const input = makeLines(4);
    const result = truncateContent(input);

    // 4 non-empty lines < 7 → all shown in tail
    expect(result.tailPreview).toHaveLength(4);
    expect(result.tailPreview).toEqual(['line-1', 'line-2', 'line-3', 'line-4']);
    expect(result.headPreview).toBeUndefined();
    // hiddenLineCount = 4 - 0 - 4 = 0
    expect(result.hiddenLineCount).toBe(0);
  });

  // ── Custom tail count ───────────────────────────────────────────────────────

  it('custom tail count via env var (3 lines)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '3';
    const input = makeLines(10);
    const result = truncateContent(input);

    expect(result.tailPreview).toHaveLength(3);
    expect(result.tailPreview).toEqual(['line-8', 'line-9', 'line-10']);
    expect(result.headPreview).toBeUndefined();
    // hiddenLineCount = 10 - 0 - 3 = 7
    expect(result.hiddenLineCount).toBe(7);
  });

  // ── Custom head count ───────────────────────────────────────────────────────

  it('custom head count via env var (2 lines)', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '2';
    const input = makeLines(15);
    const result = truncateContent(input);

    expect(result.headPreview).toHaveLength(2);
    expect(result.headPreview).toEqual(['line-1', 'line-2']);
    // default tail = 7
    expect(result.tailPreview).toHaveLength(7);
    expect(result.tailPreview).toEqual(['line-9', 'line-10', 'line-11', 'line-12', 'line-13', 'line-14', 'line-15']);
    // hiddenLineCount = 15 - 2 - 7 = 6
    expect(result.hiddenLineCount).toBe(6);
  });

  // ── Tail = 0 ────────────────────────────────────────────────────────────────

  it('tail=0 suppresses tail preview entirely', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '0';
    const input = makeLines(10);
    const result = truncateContent(input);

    expect(result.tailPreview).toBeUndefined();
    expect(result.headPreview).toBeUndefined();
    // hiddenLineCount = 10 - 0 - 0 = 10
    expect(result.hiddenLineCount).toBe(10);
  });

  // ── Head + tail overlap / deduplication ────────────────────────────────────

  it('head + tail >= total non-empty lines: all lines shown without duplication', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '5';
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '5';
    const input = makeLines(8); // 8 lines < 5+5=10

    const result = truncateContent(input);

    // When combined budget >= total, show all in one window (head takes priority
    // to represent "all lines").
    // headPreview should be all 8 lines; tailPreview empty (no duplication).
    expect(result.headPreview).toHaveLength(8);
    expect(result.tailPreview).toBeUndefined();
    expect(result.hiddenLineCount).toBe(0);
  });

  it('head + tail == total non-empty lines exactly: all shown, zero hidden', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '3';
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '3';
    const input = makeLines(6); // exactly 3+3

    const result = truncateContent(input);

    // head + tail == 6 → overlap boundary → show all in head window.
    expect(result.headPreview).toHaveLength(6);
    expect(result.tailPreview).toBeUndefined();
    expect(result.hiddenLineCount).toBe(0);
  });

  it('head + tail < total non-empty lines: separate, non-overlapping windows', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '2';
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '2';
    const input = makeLines(10); // 10 > 2+2

    const result = truncateContent(input);

    expect(result.headPreview).toEqual(['line-1', 'line-2']);
    expect(result.tailPreview).toEqual(['line-9', 'line-10']);
    // hiddenLineCount = 10 - 2 - 2 = 6
    expect(result.hiddenLineCount).toBe(6);
  });

  // ── Invalid env var values → fall back to defaults ──────────────────────────

  it('non-numeric tail env var falls back to default (7)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = 'notanumber';
    const input = makeLines(20);
    const result = truncateContent(input);

    expect(result.tailPreview).toHaveLength(7);
  });

  it('non-numeric head env var falls back to default (0)', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = 'bad';
    const input = makeLines(10);
    const result = truncateContent(input);

    expect(result.headPreview).toBeUndefined();
  });

  it('out-of-range tail value (> 50) falls back to default (7)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '99';
    const input = makeLines(20);
    const result = truncateContent(input);

    expect(result.tailPreview).toHaveLength(7);
  });

  it('negative tail value falls back to default (7)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '-3';
    const input = makeLines(20);
    const result = truncateContent(input);

    expect(result.tailPreview).toHaveLength(7);
  });

  it('non-integer tail value falls back to default (7)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '3.5';
    const input = makeLines(20);
    const result = truncateContent(input);

    expect(result.tailPreview).toHaveLength(7);
  });

  // ── Zero boundary ───────────────────────────────────────────────────────────

  it('tail=0 and head=0: both previews suppressed, all lines hidden', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '0';
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '0';
    const input = makeLines(5);
    const result = truncateContent(input);

    expect(result.tailPreview).toBeUndefined();
    expect(result.headPreview).toBeUndefined();
    // hiddenLineCount = 5 (lines.length) - 0 - 0 = 5
    expect(result.hiddenLineCount).toBe(5);
  });

  it('tail=50 (max) shows up to 50 lines', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '50';
    const input = makeLines(60);
    const result = truncateContent(input);

    expect(result.tailPreview).toHaveLength(50);
  });

  // ── hiddenLineCount formula correctness ────────────────────────────────────

  it('hiddenLineCount accounts for both head and tail displayed lines', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '2';
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '3';
    const input = makeLines(20);
    const result = truncateContent(input);

    // lines.length = 20, headPreview.length = 2, tailPreview.length = 3
    expect(result.hiddenLineCount).toBe(20 - 2 - 3);
    expect(result.hiddenLineCount).toBe(15);
  });

  it('hiddenLineCount uses lines.length (including empty lines), not nonEmptyLines.length', () => {
    // 5 non-empty lines with blank lines interspersed → total 9 lines
    const input = 'line-1\n\nline-2\n\nline-3\n\nline-4\n\nline-5';
    const result = truncateContent(input);

    // lines.length = 9, tailPreview = 5 non-empty lines (all, since 5 < 7 default)
    expect(result.lineCount).toBe(9);
    expect(result.tailPreview).toHaveLength(5);
    // hiddenLineCount = 9 - 0 - 5 = 4 (the 4 blank lines are "hidden")
    expect(result.hiddenLineCount).toBe(4);
  });

  // ── Single-line path is unaffected ─────────────────────────────────────────

  it('single-line output returns no preview fields', () => {
    const result = truncateContent('just one line');

    expect(result.tailPreview).toBeUndefined();
    expect(result.headPreview).toBeUndefined();
    expect(result.hiddenLineCount).toBeUndefined();
    expect(result.lineCount).toBeUndefined();
  });

  // ── Truncated (>80-char) multi-line still exposes previews ─────────────────

  it('long multi-line output still exposes head and tail previews', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '2';
    // Build output that exceeds 80 chars total
    const longLine = 'x'.repeat(100);
    const input = Array.from({ length: 15 }, (_, i) => `${longLine}-${i + 1}`).join('\n');
    const result = truncateContent(input);

    expect(result.truncated).toBe(true);
    expect(result.headPreview).toHaveLength(2);
    expect(result.tailPreview).toHaveLength(7);
  });
});
