/**
 * Tests for bash-preview.ts — configurable head/tail preview line selection.
 *
 * Coverage:
 *   - selectPreviewLines: defaults, custom values, zero head/tail, overlap,
 *     short output, empty output, boundary values
 *   - parseLineCount: valid, invalid (non-numeric, negative, out-of-range),
 *     zero, undefined/empty
 *   - readPreviewConfig: env var resolution and fallback to defaults
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { selectPreviewLines, parseLineCount, readPreviewConfig } from './bash-preview.js';

// ── selectPreviewLines ────────────────────────────────────────────────────────

describe('selectPreviewLines', () => {
  it('returns empty head and tail for empty input', () => {
    const { head, tail } = selectPreviewLines([], 0, 7);
    expect(head).toEqual([]);
    expect(tail).toEqual([]);
  });

  it('returns empty head and tail when both counts are zero', () => {
    const lines = ['a', 'b', 'c'];
    const { head, tail } = selectPreviewLines(lines, 0, 0);
    expect(head).toEqual([]);
    expect(tail).toEqual([]);
  });

  // Default behaviour: tail=7, head=0 (mirrors PR #1500 fixed logic)
  it('default tail=7 head=0: returns last 7 lines when output is longer', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const { head, tail } = selectPreviewLines(lines, 0, 7);
    expect(head).toEqual([]);
    expect(tail).toEqual(lines.slice(-7));
    expect(tail).toHaveLength(7);
  });

  it('tail-only: returns all lines when total <= tailCount (short output)', () => {
    const lines = ['a', 'b', 'c'];
    const { head, tail } = selectPreviewLines(lines, 0, 7);
    expect(head).toEqual([]);
    expect(tail).toEqual(['a', 'b', 'c']);
  });

  it('head-only: returns first N lines without duplication', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const { head, tail } = selectPreviewLines(lines, 3, 0);
    expect(head).toEqual(['line 1', 'line 2', 'line 3']);
    expect(tail).toEqual([]);
  });

  it('head + tail no overlap: disjoint slices', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const { head, tail } = selectPreviewLines(lines, 3, 7);
    expect(head).toEqual(['line 1', 'line 2', 'line 3']);
    expect(tail).toEqual(['line 14', 'line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'line 20']);
    // No duplication
    const allShown = new Set([...head, ...tail]);
    expect(allShown.size).toBe(head.length + tail.length);
  });

  it('overlap: head + tail >= lines.length returns all lines without duplication', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    // 3 + 4 = 7 >= 5
    const { head, tail } = selectPreviewLines(lines, 3, 4);
    expect([...head, ...tail]).toEqual(['a', 'b', 'c', 'd', 'e']);
    // No duplicates
    const allShown = [...head, ...tail];
    expect(new Set(allShown).size).toBe(allShown.length);
  });

  it('exact overlap boundary: head + tail === lines.length covers all lines', () => {
    const lines = ['a', 'b', 'c', 'd'];
    const { head, tail } = selectPreviewLines(lines, 2, 2);
    expect([...head, ...tail]).toEqual(['a', 'b', 'c', 'd']);
    expect(head).toHaveLength(2);
    expect(tail).toHaveLength(2);
  });

  it('single line with tail=1 returns that line', () => {
    const { head, tail } = selectPreviewLines(['only'], 0, 1);
    expect(head).toEqual([]);
    expect(tail).toEqual(['only']);
  });

  it('hidden line count derived from selection is non-negative', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `L${i}`);
    const { head, tail } = selectPreviewLines(lines, 2, 5);
    const hidden = lines.length - (head.length + tail.length);
    expect(hidden).toBeGreaterThanOrEqual(0);
    expect(hidden).toBe(8); // 15 - (2 + 5)
  });

  it('large tail count exceeding line count returns all lines in tail', () => {
    const lines = ['x', 'y', 'z'];
    const { head, tail } = selectPreviewLines(lines, 0, 200);
    expect(head).toEqual([]);
    expect(tail).toEqual(['x', 'y', 'z']);
  });

  it('large head count exceeding line count returns all lines in head', () => {
    const lines = ['x', 'y', 'z'];
    const { head, tail } = selectPreviewLines(lines, 200, 0);
    expect([...head, ...tail]).toEqual(['x', 'y', 'z']);
  });
});

// ── parseLineCount ────────────────────────────────────────────────────────────

describe('parseLineCount', () => {
  it('returns default for undefined', () => {
    expect(parseLineCount(undefined, 7)).toBe(7);
  });

  it('returns default for empty string', () => {
    expect(parseLineCount('', 7)).toBe(7);
    expect(parseLineCount('   ', 7)).toBe(7);
  });

  it('returns default for non-numeric string', () => {
    expect(parseLineCount('abc', 7)).toBe(7);
    expect(parseLineCount('seven', 7)).toBe(7);
    expect(parseLineCount('7.5', 7)).toBe(7); // float, not integer
    expect(parseLineCount('NaN', 7)).toBe(7);
    expect(parseLineCount('Infinity', 7)).toBe(7);
  });

  it('returns default for negative values', () => {
    expect(parseLineCount('-1', 7)).toBe(7);
    expect(parseLineCount('-100', 7)).toBe(7);
  });

  it('returns default for values above MAX_LINES (200)', () => {
    expect(parseLineCount('201', 7)).toBe(7);
    expect(parseLineCount('1000', 7)).toBe(7);
  });

  it('accepts zero', () => {
    expect(parseLineCount('0', 7)).toBe(0);
  });

  it('accepts boundary value 200', () => {
    expect(parseLineCount('200', 7)).toBe(200);
  });

  it('accepts typical values', () => {
    expect(parseLineCount('7', 0)).toBe(7);
    expect(parseLineCount('3', 0)).toBe(3);
    expect(parseLineCount('10', 0)).toBe(10);
  });

  it('trims whitespace before parsing', () => {
    expect(parseLineCount('  7  ', 0)).toBe(7);
  });
});

// ── readPreviewConfig ─────────────────────────────────────────────────────────

describe('readPreviewConfig', () => {
  const originalTail = process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
  const originalHead = process.env['AFK_BASH_PREVIEW_HEAD_LINES'];

  beforeEach(() => {
    delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
    delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
  });

  afterEach(() => {
    if (originalTail === undefined) {
      delete process.env['AFK_BASH_PREVIEW_TAIL_LINES'];
    } else {
      process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = originalTail;
    }
    if (originalHead === undefined) {
      delete process.env['AFK_BASH_PREVIEW_HEAD_LINES'];
    } else {
      process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = originalHead;
    }
  });

  it('returns defaults when env vars are unset', () => {
    const config = readPreviewConfig();
    expect(config.tailCount).toBe(7);
    expect(config.headCount).toBe(0);
  });

  it('reads AFK_BASH_PREVIEW_TAIL_LINES', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '10';
    const config = readPreviewConfig();
    expect(config.tailCount).toBe(10);
    expect(config.headCount).toBe(0);
  });

  it('reads AFK_BASH_PREVIEW_HEAD_LINES', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '3';
    const config = readPreviewConfig();
    expect(config.headCount).toBe(3);
    expect(config.tailCount).toBe(7);
  });

  it('reads both vars independently', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '15';
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '5';
    const config = readPreviewConfig();
    expect(config.tailCount).toBe(15);
    expect(config.headCount).toBe(5);
  });

  it('falls back to default on invalid tail value', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = 'bogus';
    const config = readPreviewConfig();
    expect(config.tailCount).toBe(7);
  });

  it('falls back to default on invalid head value', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '-5';
    const config = readPreviewConfig();
    expect(config.headCount).toBe(0);
  });

  it('falls back to default for tail value out of range (>200)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '201';
    const config = readPreviewConfig();
    expect(config.tailCount).toBe(7);
  });

  it('accepts zero tail (disables tail preview)', () => {
    process.env['AFK_BASH_PREVIEW_TAIL_LINES'] = '0';
    const config = readPreviewConfig();
    expect(config.tailCount).toBe(0);
  });

  it('accepts zero head (default — no head block)', () => {
    process.env['AFK_BASH_PREVIEW_HEAD_LINES'] = '0';
    const config = readPreviewConfig();
    expect(config.headCount).toBe(0);
  });
});
