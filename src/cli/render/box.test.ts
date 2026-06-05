/**
 * Behaviour tests for the drawBox primitive (src/cli/render/box.ts).
 *
 * Verifies framing (rounded corners + vertical bars), rectangularity (all rows
 * equal display width) under wrapping/titles/padding, and the caller-sanitised
 * contract (drawBox does NOT strip escapes). Imports via the `../render.js`
 * barrel to also assert the index.ts re-export is wired.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawBox } from '../render.js';
import { displayWidth } from '../display.js';

/** Strip SGR color codes so shape assertions are chalk-level agnostic. */
function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('drawBox', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('frames content with rounded corners and vertical bars', () => {
    const rows = strip(drawBox('hello')).split('\n');
    expect(rows[0]?.startsWith('╭')).toBe(true);
    expect(rows[0]?.endsWith('╮')).toBe(true);
    expect(rows[rows.length - 1]?.startsWith('╰')).toBe(true);
    expect(rows[rows.length - 1]?.endsWith('╯')).toBe(true);
    expect(rows[1]?.startsWith('│')).toBe(true);
    expect(rows[1]?.endsWith('│')).toBe(true);
    expect(rows[1]).toContain('hello');
  });

  it('produces a rectangular box (all rows equal display width)', () => {
    const widths = strip(drawBox(['short', 'a longer line here']))
      .split('\n')
      .map((r) => displayWidth(r));
    const first = widths[0] ?? 0;
    for (const w of widths) expect(w).toBe(first);
  });

  it('word-wraps content wider than the inner width into multiple rows', () => {
    const rows = strip(drawBox('alpha beta gamma delta', { width: 7 })).split('\n');
    const bodyRows = rows.slice(1, -1);
    expect(bodyRows.length).toBeGreaterThanOrEqual(2);
    const widths = rows.map((r) => displayWidth(r));
    const first = widths[0] ?? 0;
    for (const w of widths) expect(w).toBe(first);
  });

  it('truncates an unbreakable over-wide token with an ellipsis (stays rectangular)', () => {
    const rows = strip(drawBox('abcdefghij', { width: 4 })).split('\n');
    const bodyRows = rows.slice(1, -1);
    expect(bodyRows.length).toBe(1);
    expect(bodyRows[0]).toContain('…');
    const widths = rows.map((r) => displayWidth(r));
    const first = widths[0] ?? 0;
    for (const w of widths) expect(w).toBe(first);
  });

  it('renders a title chip in the top border', () => {
    const rows = strip(drawBox('body', { title: 'INFO' })).split('\n');
    expect(rows[0]).toContain('INFO');
    expect(rows[0]?.startsWith('╭')).toBe(true);
    expect(rows[0]?.endsWith('╮')).toBe(true);
  });

  it('stays rectangular even with a title', () => {
    const widths = strip(drawBox(['a', 'b'], { title: 'TITLE' }))
      .split('\n')
      .map((r) => displayWidth(r));
    const first = widths[0] ?? 0;
    for (const w of widths) expect(w).toBe(first);
  });

  it('accepts a multi-line string and splits on \\n', () => {
    const body = strip(drawBox('line1\nline2')).split('\n').slice(1, -1);
    expect(body.length).toBe(2);
    expect(body[0]).toContain('line1');
    expect(body[1]).toContain('line2');
  });

  it('honours the padding option (wider horizontal run)', () => {
    const tightW = displayWidth(strip(drawBox('x', { width: 3, padding: 0 })).split('\n')[0] ?? '');
    const paddedW = displayWidth(strip(drawBox('x', { width: 3, padding: 2 })).split('\n')[0] ?? '');
    expect(paddedW).toBe(tightW + 4); // +2 padding on each side
  });

  it('does NOT strip escape sequences in content (caller-sanitised contract)', () => {
    expect(drawBox('a\x1b[31mb')).toContain('\x1b[31m');
  });

  it('clamps an over-wide title so the box stays rectangular (narrow terminal)', () => {
    // maxInnerBoxWidth() floors at 22, so a terminal narrower than the title
    // forces the overflow path: without clamping, the full chip is emitted
    // while `dashes` bottoms out at 0, making the top border wider than the
    // body rows. The chip must be truncated to fit the top border.
    Object.defineProperty(process.stdout, 'columns', { value: 24, configurable: true });
    const longTitle = 'a-very-long-dynamic-task-name-that-exceeds-the-narrow-box';
    const rows = strip(drawBox('body', { title: longTitle })).split('\n');
    const widths = rows.map((r) => displayWidth(r));
    const first = widths[0] ?? 0;
    for (const w of widths) expect(w).toBe(first);
    // The title chip was truncated with an ellipsis to fit the top border.
    expect(rows[0]).toContain('…');
  });
});
