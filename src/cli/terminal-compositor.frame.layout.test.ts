/**
 * Unit tests for `truncateOverlayPreservingHead`, `computeViewportLayout`,
 * and `computePickerViewportLayout` in terminal-compositor.frame.layout.ts.
 *
 * The primary concern is the spine-breakage fix: when the overlay exceeds the
 * viewport budget on a short/wide terminal the compositor must preserve the
 * head rows (root `◉`/`○` anchor context) instead of blindly tail-slicing
 * them away.
 *
 * truncateOverlayPreservingHead behaviour
 * ----------------------------------------
 *   budget <= lines.length  → unchanged (no truncation)
 *   budget <= 3             → plain tail-slice fallback
 *   budget >= 4             → head (≈25%, min 1, max 5) +
 *                             dim indicator + tail fills the rest
 *
 * computeViewportLayout / computePickerViewportLayout
 * ----------------------------------------------------
 *   When overlayLines.length > overlayBudget the trimmedOverlay output is
 *   produced by truncateOverlayPreservingHead, not a raw tail-slice.
 */

import type { ChalkInstance } from 'chalk';
import { describe, expect, it } from 'vitest';
import {
  hiddenIndicatorGutter,
  truncateOverlayPreservingHead,
  computeViewportLayout,
  computePickerViewportLayout,
  type ChromeRows,
} from './terminal-compositor.frame.layout.js';
import { stripAnsi } from './display.js';
import { palette } from './palette.js';
import { ASCII_GLYPHS, UNICODE_GLYPHS } from './commands/interactive/tool-lane-render.js';

// ---------------------------------------------------------------------------
// Sentinel chalk helper — lets us assert WHICH palette role was applied
// without depending on Chalk's ANSI output (disabled under NO_COLOR/non-TTY).
// ---------------------------------------------------------------------------
function sentinelChalk(tag: string): ChalkInstance {
  return ((...text: unknown[]) => `${tag}:${text.join(' ')}`) as ChalkInstance;
}

// ---------------------------------------------------------------------------
// Chrome stub factories
// ---------------------------------------------------------------------------
function bareChrome(lines: string[]): ChromeRows {
  return { overlayLines: lines, spinnerRow: null, tipRow: null, attachmentRow: null };
}

// Minimal scroll-region guard that reports zero extra rows.
const noScrollRegion = undefined;

// ---------------------------------------------------------------------------
// truncateOverlayPreservingHead — pure unit tests
// ---------------------------------------------------------------------------

describe('truncateOverlayPreservingHead', () => {
  it('returns the lines array unchanged when length <= budget', () => {
    const lines = ['a', 'b', 'c'];
    const result = truncateOverlayPreservingHead(lines, 5);
    expect(result).toBe(lines); // same reference
  });

  it('returns the lines array unchanged when length === budget (exact fit)', () => {
    const lines = ['a', 'b', 'c'];
    const result = truncateOverlayPreservingHead(lines, 3);
    expect(result).toBe(lines);
  });

  // -- small-budget fallback -------------------------------------------------

  it('falls back to tail-slice when budget is 0', () => {
    const lines = ['a', 'b', 'c'];
    expect(truncateOverlayPreservingHead(lines, 0)).toEqual([]);
  });

  it('falls back to tail-slice when budget is 1', () => {
    const lines = ['head', 'mid', 'tail'];
    expect(truncateOverlayPreservingHead(lines, 1)).toEqual(['tail']);
  });

  it('falls back to tail-slice when budget is 2', () => {
    const lines = ['head', 'mid', 'tail'];
    expect(truncateOverlayPreservingHead(lines, 2)).toEqual(['mid', 'tail']);
  });

  it('falls back to tail-slice when budget is 3', () => {
    const lines = ['a', 'b', 'c', 'd', 'e'];
    expect(truncateOverlayPreservingHead(lines, 3)).toEqual(['c', 'd', 'e']);
  });

  // -- head-preserving split (budget >= 4) ----------------------------------

  it('preserves the first line (head) and keeps the tail for budget=4', () => {
    // headCount = floor(4*0.25) = 1, tailCount = 4-1-1 = 2, indicator = 1
    const lines = ['◉ root', 'child A', 'child B', 'child C', 'child D'];
    const result = truncateOverlayPreservingHead(lines, 4);
    expect(result.length).toBe(4);
    expect(result[0]).toBe('◉ root');
    expect(stripAnsi(result[1])).toContain('earlier lines hidden');
    expect(result[result.length - 2]).toBe('child C');
    expect(result[result.length - 1]).toBe('child D');
  });

  it('inserts a "N earlier lines hidden" indicator between head and tail', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const result = truncateOverlayPreservingHead(lines, 10);
    // headCount = floor(10*0.25)=2, tailCount = 10-2-1=7, hidden = 20-2-7=11
    const indicatorIdx = 2; // right after the 2 head lines
    expect(stripAnsi(result[indicatorIdx])).toContain('11 earlier lines hidden');
  });

  it('uses palette.dim for the indicator line (sentinel pattern)', () => {
    const savedDim = palette.dim;
    try {
      palette.dim = sentinelChalk('DIM');
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
      const result = truncateOverlayPreservingHead(lines, 5);
      // 1 head + 1 indicator + 3 tail = 5
      const indicator = result[1];
      expect(indicator).toContain('DIM:');
    } finally {
      palette.dim = savedDim;
    }
  });

  it('caps head at 5 even for very large budgets', () => {
    // budget=40: headCount = min(5, floor(40*0.25)=10) = 5
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const result = truncateOverlayPreservingHead(lines, 40);
    // First 5 lines must be the original head
    expect(result.slice(0, 5)).toEqual(lines.slice(0, 5));
    // Total output length must equal the budget
    expect(result.length).toBe(40);
  });

  it('hidden count is correct (total - head - tail)', () => {
    // 20 lines, budget=8: headCount=floor(8*0.25)=2, tailCount=8-2-1=5, hidden=13
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const result = truncateOverlayPreservingHead(lines, 8);
    expect(stripAnsi(result[2])).toContain('13 earlier lines hidden');
  });

  it('output length always equals the budget when truncation occurs', () => {
    for (const budget of [4, 5, 8, 10, 20]) {
      const lines = Array.from({ length: 50 }, (_, i) => `l${i}`);
      const result = truncateOverlayPreservingHead(lines, budget);
      expect(result.length).toBe(budget);
    }
  });

  it('tail lines are the last N lines of the original array', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    // budget=8: tailCount=5, so last 5 lines
    const result = truncateOverlayPreservingHead(lines, 8);
    expect(result.slice(-5)).toEqual(lines.slice(-5));
  });
});

// ---------------------------------------------------------------------------
// computeViewportLayout — spine-truncation integration
// ---------------------------------------------------------------------------

describe('computeViewportLayout — spine truncation', () => {
  it('passes overlay through unchanged when it fits in the budget', () => {
    // rows=30, no fixed chrome: budget is very large
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`);
    const chrome = bareChrome(lines);
    const layout = computeViewportLayout(chrome, 0, false, 30, noScrollRegion);
    expect(layout.trimmedOverlay).toBe(lines);
  });

  it('uses head-preserving truncation (not raw tail-slice) on short terminal', () => {
    // 20-line overlay on a 10-row terminal
    // fixedRows: gapRow(1) + input(1) = 2, budget = (10-1) - 2 = 7
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const chrome = bareChrome(lines);
    const layout = computeViewportLayout(chrome, 0, false, 10, noScrollRegion);
    const { trimmedOverlay } = layout;

    // budget=7: headCount=floor(7*0.25)=1, tailCount=7-1-1=5, hidden=14
    expect(trimmedOverlay.length).toBe(7);
    // First row is preserved from original head
    expect(trimmedOverlay[0]).toBe('line 0');
    // Indicator is present in middle
    expect(stripAnsi(trimmedOverlay[1])).toContain('earlier lines hidden');
    // Tail is the last 5 lines
    expect(trimmedOverlay.slice(-5)).toEqual(lines.slice(-5));
  });

  it('root anchor line is always the first row of trimmedOverlay on short terminal', () => {
    const root = '◉ Turn 1';
    const lines = [root, ...Array.from({ length: 19 }, (_, i) => `child ${i}`)];
    const chrome = bareChrome(lines);
    const layout = computeViewportLayout(chrome, 0, false, 10, noScrollRegion);
    expect(layout.trimmedOverlay[0]).toBe(root);
  });

  it('falls back to tail-slice when budget is very small (<=3)', () => {
    // rows=5, no fixed chrome, gapRow=1, input=1 → budget = (5-1) - 2 = 2
    const lines = ['head', 'mid', 'tail'];
    const chrome = bareChrome(lines);
    const layout = computeViewportLayout(chrome, 0, false, 5, noScrollRegion);
    // budget=2 ≤ 3, so tail-slice applies
    expect(layout.trimmedOverlay).toEqual(['mid', 'tail']);
  });

  it('renderGap is false when overlay is fully trimmed to zero', () => {
    // rows=3, budget = (3-1) - 2 = 0
    const lines = ['line0', 'line1'];
    const chrome = bareChrome(lines);
    const layout = computeViewportLayout(chrome, 0, false, 3, noScrollRegion);
    expect(layout.renderGap).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computePickerViewportLayout — spine-truncation integration
// ---------------------------------------------------------------------------

describe('computePickerViewportLayout — spine truncation', () => {
  it('passes overlay through unchanged when it fits in the budget', () => {
    const lines = Array.from({ length: 3 }, (_, i) => `line ${i}`);
    const chrome = bareChrome(lines);
    const layout = computePickerViewportLayout(chrome, 5, 30, noScrollRegion);
    expect(layout.trimmedOverlay).toBe(lines);
  });

  it('uses head-preserving truncation on short terminal (picker mode)', () => {
    // 20-line overlay, 10-row terminal, 5 picker rows
    // fixedRows: gapRow(1) + pickerRows(5) = 6, budget = (10-1) - 6 = 3
    // budget=3 ≤ 3 → tail-slice fallback
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const chrome = bareChrome(lines);
    const layout = computePickerViewportLayout(chrome, 5, 10, noScrollRegion);
    expect(layout.trimmedOverlay.length).toBe(3);
    // tail-slice: last 3
    expect(layout.trimmedOverlay).toEqual(lines.slice(-3));
  });

  it('preserves head when budget is large enough (budget >= 4)', () => {
    // 20-line overlay, 20-row terminal, 2 picker rows
    // fixedRows: gapRow(1) + pickerRows(2) = 3, budget = (20-1) - 3 = 16
    const root = '◉ Turn 1';
    const lines = [root, ...Array.from({ length: 19 }, (_, i) => `child ${i}`)];
    const chrome = bareChrome(lines);
    const layout = computePickerViewportLayout(chrome, 2, 20, noScrollRegion);
    expect(layout.trimmedOverlay.length).toBe(16);
    expect(layout.trimmedOverlay[0]).toBe(root);
    expect(stripAnsi(layout.trimmedOverlay[Math.floor(16 * 0.25)]))
      .toContain('earlier lines hidden');
  });
});

// ---------------------------------------------------------------------------
// Indicator gutter: the hidden-lines row must continue the tree spine and sit
// inside the content margin (regression: "17 earlier lines hidden" rendered at
// col 6, outside the margin, severing every `│` rail it crossed).
// ---------------------------------------------------------------------------

describe('hidden-lines indicator gutter', () => {
  const M = '          '; // content margin (10 cols)

  it('carries every rail of the row below and respects the content margin', () => {
    const lines = [
      `${M}◉ skill(pr-triage)`,
      `${M}  ◉ Agent(A) [worker]`,
      `${M}  │  ├─ ◆ skill(review) ✓ 170 lines`,
      ...Array.from({ length: 17 }, (_, i) => `${M}  │  │      hidden ${i}`),
      `${M}  │  │      - Whether a stated intent`,
      `${M}  │  ╰─ ▸ bash ×3 — 3 done`,
      `${M}  ◉ Agent(B) [worker]`,
    ];
    const result = truncateOverlayPreservingHead(lines, 8).map((l) => stripAnsi(l));
    const row = result.find((l) => l.includes('earlier lines hidden'))!;
    expect(row).toBeDefined();
    expect(row.startsWith(M)).toBe(true);
    const below = result[result.indexOf(row) + 1]!;
    // Every rail column in the next row must also be a rail on the indicator row.
    [...below].forEach((ch, i) => {
      if (ch === '│' || ch === '├' || ch === '╰') expect(row[i], `col ${i}\n${result.join('\n')}`).toBe('│');
    });
  });

  it('draws the parent rail through a nested node glyph directly below', () => {
    expect(hiddenIndicatorGutter(`${M}  │  ╰─ bash`, `${M}  ◉ Agent(B)`)).toBe(`${M}  │ `);
  });

  it('does not invent a rail above a top-level node', () => {
    expect(hiddenIndicatorGutter(`${M}plain text`, `${M}◉ skill(x)`)).toBe(M);
  });

  it('turns horizontal connector runs into spaces', () => {
    expect(hiddenIndicatorGutter('', '│  ├─ ◆ x')).toBe('│  │  ');
  });

  it('skips blank tail rows when picking the reference row', () => {
    const lines = ['◉ root', ...Array.from({ length: 10 }, () => 'x'), '', `${M}│ tail`, `${M}│ tail2`];
    const result = truncateOverlayPreservingHead(lines, 5).map((l) => stripAnsi(l));
    expect(result[1]).toBe(`${M}│ 10 earlier lines hidden`);
  });

  // Finding #5 from issue #2509: blank-tail-skip test only covered headCount=1
  // (budget 5).  Add a variant with a larger budget to exercise headCount > 1.
  it('skips blank tail rows when picking the reference row (budget=8, headCount=2)', () => {
    // budget=8: headCount=floor(8*0.25)=2, tailCount=8-2-1=5
    // Make the first 2 tail rows blank so `below` must skip them.
    const lines = [
      '◉ root',
      '◉ turn 2',
      ...Array.from({ length: 10 }, () => 'x'),
      '',
      '',
      `${M}│ tail-a`,
      `${M}│ tail-b`,
      `${M}│ tail-c`,
    ];
    const result = truncateOverlayPreservingHead(lines, 8).map((l) => stripAnsi(l));
    const indicatorIdx = 2; // after 2 head lines
    expect(result[indicatorIdx]).toContain('earlier lines hidden');
    // The gutter must be derived from the first non-blank tail row (tail-a) which
    // carries a `│` rail at the content-margin column.
    expect(result[indicatorIdx].startsWith(`${M}│`)).toBe(true);
  });

  // Finding #4 from issue #2509: integrate the node-on-rail branch of
  // `hiddenIndicatorGutter` (line 176 of the source: `node.has(ch) &&
  // railDown.has(up)`) through `truncateOverlayPreservingHead` end-to-end.
  // Previously this branch was only exercised by a direct `hiddenIndicatorGutter`
  // call; this test verifies the same path fires inside the full truncation flow.
  //
  // Setup: budget=4 → headCount=1, tailCount=2.
  //   head[0]  = '│  ╰─ bash'   (last connector — `│` at col 0 is in RAIL_DOWN)
  //   tail[0]  = '◉ Agent(B)'   (node glyph at col 0 — directly below the `│`)
  //
  // The loop in `hiddenIndicatorGutter` reaches `◉` at col 0, finds `above[0]`
  // is `│` (RAIL_DOWN), and appends the rail — producing gutter `'│ '`.
  it('node-on-rail: indicator carries the parent rail through a ◉ node in the first non-blank tail row (integration)', () => {
    const lines = [
      '│  ╰─ bash',                     // head (last visible head row; `│` at col 0)
      ...Array.from({ length: 5 }, (_, i) => `│  hidden ${i}`),  // hidden rows
      '◉ Agent(B)',                      // first tail row — node at col 0 under `│`
      '│  ├─ tool ×1',                  // second tail row
    ];
    // budget=4: headCount=1, tailCount=2, hidden=5
    const result = truncateOverlayPreservingHead(lines, 4);
    expect(result.length).toBe(4);
    const indicator = stripAnsi(result[1]);
    expect(indicator).toContain('5 earlier lines hidden');
    // Gutter must be `│ ` — the node-on-rail branch fired.
    expect(indicator.startsWith('│')).toBe(true);
  });
});

describe('hidden-lines indicator gutter (ASCII glyph mode)', () => {
  it('continues ASCII rails when the ASCII glyph set is active', () => {
    expect(hiddenIndicatorGutter('', '|  +- o x', ASCII_GLYPHS)).toBe('|  |  ');
    expect(hiddenIndicatorGutter('  |  \\- bash', '  o Agent', ASCII_GLYPHS)).toBe('  | ');
  });

  it('does not treat ASCII lookalikes as rails under the Unicode set', () => {
    expect(hiddenIndicatorGutter('', '  | a | b |', UNICODE_GLYPHS)).toBe('  ');
    expect(hiddenIndicatorGutter('', '  +2 more', UNICODE_GLYPHS)).toBe('  ');
  });

  it('keeps a content bullet that is not preceded by a connector', () => {
    expect(hiddenIndicatorGutter('', '│  │      - Whether', UNICODE_GLYPHS)).toBe('│  │      ');
    expect(hiddenIndicatorGutter('', '|  - item', ASCII_GLYPHS)).toBe('|  ');
  });
});
