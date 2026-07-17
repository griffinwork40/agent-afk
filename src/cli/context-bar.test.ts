/**
 * Tests for src/cli/context-bar.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import chalk from 'chalk';
import { formatContextBar } from './context-bar.js';
import { palette } from './palette.js';

/** Strip ANSI escape sequences from output. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// Enable chalk colors for testing
beforeEach(() => {
  chalk.level = 3;
});

describe('formatContextBar', () => {
  it('renders 20 empty cells for ratio: 0', () => {
    const result = formatContextBar({ ratio: 0, width: 200 });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('[░░░░░░░░░░░░░░░░░░░░]');
  });

  it('renders 20 filled cells for ratio: 1', () => {
    const result = formatContextBar({ ratio: 1, width: 200 });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('[████████████████████]');
  });

  it('renders 10 filled + 10 empty for ratio: 0.5', () => {
    const result = formatContextBar({ ratio: 0.5, width: 200 });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('[██████████░░░░░░░░░░]');
  });

  it('clamps out-of-range ratios (negative -> 0)', () => {
    const result = formatContextBar({ ratio: -0.5, width: 200 });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('[░░░░░░░░░░░░░░░░░░░░]');
  });

  it('clamps out-of-range ratios (> 1 -> 1)', () => {
    const result = formatContextBar({ ratio: 1.5, width: 200 });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('[████████████████████]');
  });

  it('includes red color code when ratio > 0.8', () => {
    const result = formatContextBar({ ratio: 0.85, width: 200 });
    // Should contain red ANSI code (31m is the standard red)
    expect(result).toContain('\x1b[31m');
  });

  it('includes orange/warning color code when ratio > 0.5 and <= 0.8', () => {
    const result = formatContextBar({ ratio: 0.6, width: 200 });
    // Should contain yellow ANSI code (33m is the standard yellow for warning)
    expect(result).toContain('\x1b[33m');
  });

  it('keeps the empty track dim (meta) at a low ratio', () => {
    const result = formatContextBar({ ratio: 0.2, width: 200 });
    // The brackets + empty track always recede in the dim `meta` tone
    // (90m = bright-black), regardless of ratio.
    expect(result).toContain('\x1b[90m');
  });

  it('renders the filled run in a visible tone distinct from the track at a low ratio', () => {
    // Regression: a low-context bar used to wrap the ENTIRE `[bar] NN% counts`
    // string in the dimmest `meta` tone, so e.g. 6% looked like an empty box.
    // The filled run + percent now carry a visible `chrome` tone while only the
    // brackets/track recede, so a nearly-empty bar still reads as a real control.
    const result = formatContextBar({ ratio: 0.06, used: 62400, limit: 1_000_000, width: 200 });
    // filled = round(0.06 * 20) = 1 → exactly one '█' wrapped in the chrome tone.
    expect(result).toContain(palette.chrome('█'));
    // …and the track stays dim, so fill and track are visually distinguishable.
    expect(result).toContain('\x1b[90m');
  });

  it('includes percent with full width', () => {
    const result = formatContextBar({ ratio: 0.75, width: 200 });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('75%');
  });

  it('includes used/limit when provided with full width', () => {
    const result = formatContextBar({ ratio: 0.5, used: 50000, limit: 100000, width: 200 });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('/');
    expect(stripped).toContain('50k');
    expect(stripped).toContain('100k');
  });

  it('degrades to [BAR] NN% without used/limit when width is constrained', () => {
    const result = formatContextBar({ ratio: 0.5, used: 50000, limit: 100000, width: 90 });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('[');
    expect(stripped).toContain('50%');
    expect(stripped).not.toContain('/');
  });

  it('degrades to ctx NN% without bar when width is very constrained', () => {
    const result = formatContextBar({ ratio: 0.5, used: 50000, limit: 100000, width: 30 });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('ctx');
    expect(stripped).toContain('50%');
    expect(stripped).not.toContain('[');
  });

  it('prepends sparkline when provided', () => {
    const result = formatContextBar({ ratio: 0.5, width: 200, sparkline: '▁▂▄▅▆' });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('▁▂▄▅▆');
  });

  it('colors sparkline dimly when provided', () => {
    const result = formatContextBar({ ratio: 0.5, width: 200, sparkline: '▁▂▄▅▆' });
    // Sparkline should be wrapped in dim color (90m for bright-black)
    // Should have dim code somewhere before the sparkline content
    const lines = result.split('▁▂▄▅▆');
    expect(lines[0]).toContain('\x1b[90m');
  });

  it('separates sparkline from bar with a single space', () => {
    const result = formatContextBar({ ratio: 0.5, width: 200, sparkline: '▁▂▄▅▆' });
    const stripped = stripAnsi(result);
    expect(stripped).toMatch(/▁▂▄▅▆ \[/);
  });

  it('formats percent as integer', () => {
    const result = formatContextBar({ ratio: 0.333, width: 200 });
    const stripped = stripAnsi(result);
    // 0.333 * 100 = 33.3, should round to 33
    expect(stripped).toContain('33%');
    expect(stripped).not.toContain('33.3%');
  });

  it('handles ratio 0.5 with full options', () => {
    const result = formatContextBar({
      ratio: 0.5,
      used: 100000,
      limit: 200000,
      sparkline: '▂▄▆█',
      width: 200,
    });
    const stripped = stripAnsi(result);
    expect(stripped).toContain('▂▄▆█');
    expect(stripped).toContain('[██████████░░░░░░░░░░]');
    expect(stripped).toContain('50%');
    expect(stripped).toContain('100k');
    expect(stripped).toContain('200k');
  });

  it('handles edge case: width exactly enough for minimal form', () => {
    const result = formatContextBar({ ratio: 0.75, width: 10 });
    const stripped = stripAnsi(result);
    // Should degrade gracefully, not crash
    expect(stripped.length).toBeGreaterThan(0);
  });

  it('handles edge case: width 0', () => {
    const result = formatContextBar({ ratio: 0.5, width: 0 });
    const stripped = stripAnsi(result);
    // Should return something, not empty or crash
    expect(stripped.length).toBeGreaterThan(0);
  });

  it('does not include color reset code in the middle of sparkline', () => {
    const result = formatContextBar({ ratio: 0.5, width: 200, sparkline: '▁▂▄' });
    // Ensure sparkline is not prematurely reset
    const sparklineIndex = result.indexOf('▁');
    const resetIndex = result.lastIndexOf('\x1b[0m');
    // Reset code should come at the very end, after everything
    if (resetIndex !== -1) {
      expect(resetIndex > sparklineIndex || resetIndex === -1).toBe(true);
    }
  });

  it('used is optional', () => {
    const result = formatContextBar({ ratio: 0.5, width: 200 });
    const stripped = stripAnsi(result);
    // Should not crash; shouldn't try to format undefined
    expect(stripped.length).toBeGreaterThan(0);
    expect(stripped).toContain('50%');
  });

  it('limit is optional', () => {
    const result = formatContextBar({ ratio: 0.5, used: 50000, width: 200 });
    const stripped = stripAnsi(result);
    // Should not crash
    expect(stripped.length).toBeGreaterThan(0);
    expect(stripped).toContain('50%');
  });

  it('sparkline is optional', () => {
    const result = formatContextBar({ ratio: 0.5, used: 50000, limit: 100000, width: 200 });
    const stripped = stripAnsi(result);
    // Should work without sparkline
    expect(stripped.length).toBeGreaterThan(0);
    expect(stripped).toContain('[');
  });
});
