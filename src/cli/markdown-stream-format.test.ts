import { describe, it, expect } from 'vitest';
import {
  isInOpenTable,
  isInOpenCodeFence,
  formatPendingBuffer,
} from './markdown-stream-format.js';

/**
 * Tests for the pure formatting helpers behind StreamingMarkdownRenderer.
 *
 * Focus: the streaming-table placeholder guard. A markdown table has no
 * internal blank line, so the whole (growing) table accumulates in the pending
 * buffer and was painted into the live overlay every chunk. Once the table
 * exceeds the viewport height, the overlay's absolute-cursor erase can no
 * longer reclaim rows that scrolled into scrollback, leaving ghost tail rows
 * beside the final committed table. `formatPendingBuffer` now substitutes a
 * fixed-height placeholder for an in-progress table, mirroring the existing
 * open-code-fence guard.
 */

describe('isInOpenTable', () => {
  it('detects a basic GFM delimiter row', () => {
    expect(isInOpenTable('| A | B |\n|---|---|\n| 1 | 2 |')).toBe(true);
  });

  it('detects an alignment delimiter row (colons)', () => {
    expect(isInOpenTable('| L | C | R |\n| :--- | :--: | ---: |')).toBe(true);
  });

  it('detects a delimiter even before the first data row arrives', () => {
    // Mid-stream: header + delimiter present, rows still streaming.
    expect(isInOpenTable('| Col A | Col B |\n|-------|-------|\n')).toBe(true);
  });

  it('detects a no-outer-pipe delimiter row', () => {
    expect(isInOpenTable('A | B\n--- | ---\n1 | 2')).toBe(true);
  });

  it('returns false for a horizontal rule (no pipe)', () => {
    expect(isInOpenTable('above\n\n---\n\nbelow')).toBe(false);
  });

  it('returns false for prose containing a stray pipe (no dash-only row)', () => {
    expect(isInOpenTable('run `a | b` to pipe output')).toBe(false);
  });

  it('returns false for a setext underline', () => {
    expect(isInOpenTable('Heading\n=======')).toBe(false);
  });

  it('returns false for empty / whitespace buffers', () => {
    expect(isInOpenTable('')).toBe(false);
    expect(isInOpenTable('   \n  \n')).toBe(false);
  });

  it('returns false for a table header row alone (no delimiter yet)', () => {
    // A lone `| a | b |` is a paragraph until the delimiter row arrives — and
    // a single short line never overflows the viewport, so no guard needed.
    expect(isInOpenTable('| just | a | row |')).toBe(false);
  });
});

describe('formatPendingBuffer', () => {
  const WIDTH = 80;

  it('renders a compact placeholder for an in-progress table, not the table', () => {
    const tall = ['| Col A | Col B |', '|-------|-------|']
      .concat(Array.from({ length: 40 }, (_, i) => `| row ${i} | value ${i} |`))
      .join('\n');

    const out = formatPendingBuffer(tall, WIDTH, true);

    expect(out).toContain('streaming table');
    // The actual table rows / borders must never reach the ephemeral overlay.
    expect(out).not.toContain('value 39');
    expect(out).not.toContain('│');
    // Placeholder is fixed-height regardless of table size (no ghost source).
    const nonEmptyLines = out.split('\n').filter((l) => l.trim().length > 0);
    expect(nonEmptyLines.length).toBeLessThanOrEqual(2);
  });

  it('still renders the open-code-fence placeholder (precedence over table)', () => {
    // A fenced block whose body looks table-ish must be treated as code, not a
    // table — the code-fence guard is checked first.
    const out = formatPendingBuffer('```\n|---|---|\n| a | b |', WIDTH, true);
    expect(out).toContain('streaming code');
    expect(out).not.toContain('streaming table');
  });

  it('renders plain prose normally (no placeholder)', () => {
    const out = formatPendingBuffer('hello world', WIDTH, true);
    expect(out).toContain('hello world');
    expect(out).not.toContain('streaming');
  });

  it('returns empty string when shouldRender is false', () => {
    expect(formatPendingBuffer('| A |\n|---|\n| 1 |', WIDTH, false)).toBe('');
  });

  it('returns empty string for a whitespace-only buffer', () => {
    expect(formatPendingBuffer('   ', WIDTH, true)).toBe('');
  });
});

describe('isInOpenCodeFence (precedence sanity)', () => {
  it('is true for an unclosed fence even when it contains table-like rows', () => {
    expect(isInOpenCodeFence('```\n|---|---|\n')).toBe(true);
  });
});
