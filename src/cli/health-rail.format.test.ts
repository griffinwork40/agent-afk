/**
 * Unit tests for the health-rail pure formatter.
 */

import { describe, it, expect } from 'vitest';
import { formatHealthRail } from './health-rail.format.js';
import { stripAnsi } from './display.js';

describe('formatHealthRail', () => {
  it('contains turn count with T prefix', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 3, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('T3');
  });

  it('formats elapsed seconds', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 45_000, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('45s');
  });

  it('formats elapsed minutes with seconds', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 134_000, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('2m14s');
  });

  it('formats elapsed hours with minutes', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 3_661_000, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('1h1m');
  });

  it('includes tool calls count', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 12, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('12 calls');
  });

  it('shows running/total when subagents have been dispatched', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 2, totalSubs: 5, activeProcs: 0, totalProcs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('2/5 subs');
  });

  it('shows 0/total when all subagents completed', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 3, activeProcs: 0, totalProcs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('0/3 subs');
  });

  it('shows 0 subs when none ever dispatched', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('0 subs');
  });

  it('includes context percentage', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: 0.34 },
      120,
    ));
    expect(result).toContain('ctx 34%');
  });

  it('full example matches expected shape', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 3, elapsedMs: 134_000, toolCalls: 12, activeSubs: 2, totalSubs: 5, activeProcs: 0, totalProcs: 0, contextRatio: 0.34 },
      120,
    )).trim();
    expect(result).toContain('T3');
    expect(result).toContain('2m14s');
    expect(result).toContain('12 calls');
    expect(result).toContain('2/5 subs');
    expect(result).toContain('ctx 34%');
  });

  it('truncates to maxWidth', () => {
    const result = formatHealthRail(
      { totalTurns: 3, elapsedMs: 134_000, toolCalls: 12, activeSubs: 2, totalSubs: 5, activeProcs: 0, totalProcs: 0, contextRatio: 0.34 },
      20,
    );
    // Display width of the result (ANSI stripped) must not exceed 20
    const plainLen = stripAnsi(result).length;
    expect(plainLen).toBeLessThanOrEqual(20);
  });

  it('clamps contextRatio to [0, 1]', () => {
    // Should not throw or produce NaN% even with out-of-range inputs
    const r1 = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: -0.5 },
      120,
    ));
    expect(r1).toContain('ctx 0%');

    const r2 = stripAnsi(formatHealthRail(
      { totalTurns: 0, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: 1.5 },
      120,
    ));
    expect(r2).toContain('ctx 100%');
  });

  it('omits procs segment when totalProcs is 0', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 1, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 0, contextRatio: 0 },
      120,
    ));
    expect(result).not.toContain('procs');
  });

  it('shows running/total procs when processes have been started', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 1, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 1, totalProcs: 3, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('1/3 procs');
  });

  it('places procs segment after ctx%', () => {
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 1, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 2, totalProcs: 2, contextRatio: 0.5 },
      120,
    ));
    const ctxIdx = result.indexOf('ctx');
    const procsIdx = result.indexOf('procs');
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(procsIdx).toBeGreaterThan(ctxIdx);
  });

  it('sheds procs before ctx% on narrow terminals', () => {
    // With a tight maxWidth, procs (rightmost segment) should be truncated
    // while ctx% survives.
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 1, elapsedMs: 1000, toolCalls: 1, activeSubs: 0, totalSubs: 0, activeProcs: 1, totalProcs: 1, contextRatio: 0.5 },
      45,
    ));
    expect(result).toContain('ctx');
    expect(result).not.toContain('procs');
  });

  it('shows 0/total procs when all processes have finished (activeProcs=0, totalProcs>0)', () => {
    // Issue #4395 finding #3: display case where all procs completed.
    const result = stripAnsi(formatHealthRail(
      { totalTurns: 1, elapsedMs: 0, toolCalls: 0, activeSubs: 0, totalSubs: 0, activeProcs: 0, totalProcs: 3, contextRatio: 0 },
      120,
    ));
    expect(result).toContain('0/3 procs');
  });
});
