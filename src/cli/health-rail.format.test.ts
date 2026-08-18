/**
 * Unit tests for the health-rail pure formatter.
 */

import { describe, it, expect } from 'vitest';
import { formatHealthRail } from './health-rail.format.js';

/** Strip all ANSI escape codes for plain-text assertion. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('formatHealthRail', () => {
  it('contains turn count with T prefix', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 3, elapsedMs: 0, toolCalls: 0, activeSubs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('T3');
  });

  it('formats elapsed seconds', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 45_000, toolCalls: 0, activeSubs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('45s');
  });

  it('formats elapsed minutes with seconds', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 134_000, toolCalls: 0, activeSubs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('2m14s');
  });

  it('formats elapsed hours with minutes', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 3_661_000, toolCalls: 0, activeSubs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('1h1m');
  });

  it('includes tool calls count', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 12, activeSubs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('12 calls');
  });

  it('includes active subagents count', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 2, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('2 subs');
  });

  it('shows 0 subs when none active', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('0 subs');
  });

  it('includes context percentage', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 0, contextRatio: 0.34 },
      120,
    ));
    expect(result).toContain('ctx 34%');
  });

  it('full example matches expected shape', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 3, elapsedMs: 134_000, toolCalls: 12, activeSubs: 2, contextRatio: 0.34 },
      120,
    )).trim();
    expect(result).toContain('T3');
    expect(result).toContain('2m14s');
    expect(result).toContain('12 calls');
    expect(result).toContain('2 subs');
    expect(result).toContain('ctx 34%');
  });

  it('truncates to maxWidth', () => {
    const result = formatHealthRail(
      { totalTurns: 3, elapsedMs: 134_000, toolCalls: 12, activeSubs: 2, contextRatio: 0.34 },
      20,
    );
    // Display width of the result (ANSI stripped) must not exceed 20
    const plainLen = stripAnsi(result).length;
    expect(plainLen).toBeLessThanOrEqual(20);
  });

  it('clamps contextRatio to [0, 1]', () => {
    // Should not throw or produce NaN% even with out-of-range inputs
    const r1 = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 0, contextRatio: -0.5 },
      120,
    ));
    expect(r1).toContain('ctx 0%');

    const r2 = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 0, contextRatio: 1.5 },
      120,
    ));
    expect(r2).toContain('ctx 100%');
  });
});
