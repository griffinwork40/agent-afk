/**
 * Characterization tests for errorBox (src/cli/render/error-box.ts).
 *
 * Added alongside the drawBox unification: errorBox now delegates to the shared
 * drawBox primitive instead of hand-rolling its border math. These tests pin
 * the visible contract (red ' Error ' chip, title + optional dim detail rows,
 * rounded corners, rectangularity) so the delegation can't silently regress —
 * and assert that an over-wide unbreakable title at a narrow terminal stays
 * rectangular (the prior hand-rolled math let it overflow the border).
 *
 * Imports via the `../render.js` barrel to also exercise the index re-export.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { errorBox } from '../render.js';
import { displayWidth } from '../display.js';

/** Strip SGR color codes so shape assertions are chalk-level agnostic. */
function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('errorBox', () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('frames with rounded corners, vertical bars, and an Error chip', () => {
    const rows = strip(errorBox('Something broke')).split('\n');
    expect(rows[0]?.startsWith('╭')).toBe(true);
    expect(rows[0]?.endsWith('╮')).toBe(true);
    expect(rows[0]).toContain('Error');
    expect(rows[rows.length - 1]?.startsWith('╰')).toBe(true);
    expect(rows[rows.length - 1]?.endsWith('╯')).toBe(true);
    expect(rows[1]?.startsWith('│')).toBe(true);
    expect(rows[1]?.endsWith('│')).toBe(true);
    expect(rows[1]).toContain('Something broke');
  });

  it('renders the optional detail line below the title', () => {
    const rows = strip(errorBox('Connection failed', 'Host refused the connection')).split('\n');
    const body = rows.slice(1, -1).join('\n');
    expect(body).toContain('Connection failed');
    expect(body).toContain('Host refused the connection');
  });

  it('omits the detail row when no details are given (only title rows)', () => {
    const rows = strip(errorBox('Just a title')).split('\n');
    // top + one title row + bottom = 3 rows for a short single-line title.
    expect(rows.length).toBe(3);
    expect(rows[1]).toContain('Just a title');
  });

  it('produces a rectangular box (all rows equal display width)', () => {
    const widths = strip(errorBox('A short error', 'with some detail text here'))
      .split('\n')
      .map((r) => displayWidth(r));
    const first = widths[0] ?? 0;
    for (const w of widths) expect(w).toBe(first);
  });

  it('stays rectangular with an over-wide unbreakable title at a narrow terminal', () => {
    // A 60-char no-space token at cols=50 cannot word-wrap; drawBox truncates it
    // with an ellipsis so the box stays rectangular (the prior hand-rolled math
    // let the body row overflow past the border).
    Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true });
    const rows = strip(errorBox('A'.repeat(60), 'detail')).split('\n');
    const widths = rows.map((r) => displayWidth(r));
    const first = widths[0] ?? 0;
    for (const w of widths) expect(w).toBe(first);
    expect(rows.some((r) => r.includes('…'))).toBe(true);
  });
});
