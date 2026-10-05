/**
 * Unit tests for HealthRail subagent count logic — foreground + background.
 *
 * The HealthRail class mutates internal state in `update()` and exposes it
 * only via `repaint()` which writes ANSI to a TTY stream. To keep these tests
 * lightweight, we exercise the counting logic indirectly by calling `update()`
 * and then reading back the snapshot's effect through a thin capture hook on
 * the formatHealthRail formatter.
 *
 * Strategy: create a HealthRail with a non-TTY stream (no repaint side-effects),
 * then expose a `getLastCounts()` helper via class-level white-box access.
 * Since the snapshot is private, we instead spy on what `formatHealthRail`
 * would receive by supplying a custom palette-free formatter shim.
 *
 * Simpler approach used here: expose a minimal `_lastSnapshot` getter for
 * testing via a cast, which is acceptable for an internal unit test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthRail } from './health-rail.js';
import type { BackgroundAgentRegistry } from '../agent/background-registry.js';
import type { SessionStats } from './slash/types.js';

/** Minimal SessionStats for update() calls. */
function makeStats(): SessionStats {
  return {
    totalTurns: 1,
    totalCostUsd: 0,
    unpricedTurns: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now() - 1000,
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'claude-opus-4-5' as SessionStats['model'],
    permissionMode: 'default',
    cwd: '/tmp',
  } as unknown as SessionStats;
}

/** Build a mock BackgroundAgentRegistry that returns the supplied job list. */
function mockRegistry(jobs: Array<{ status: 'running' | 'completed' | 'failed' | 'cancelled' }>): BackgroundAgentRegistry {
  return {
    list: () => jobs as ReturnType<BackgroundAgentRegistry['list']>,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as BackgroundAgentRegistry;
}

/**
 * Access the private `snapshot` field via a cast so we can assert on the
 * computed counts without needing a real TTY repaint.
 */
function getSnapshot(rail: HealthRail): { activeSubs: number; totalSubs: number } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snap = (rail as any).snapshot;
  if (!snap) return null;
  return { activeSubs: snap.activeSubs, totalSubs: snap.totalSubs };
}

describe('HealthRail subagent counts', () => {
  let getExtraRows: () => number;

  beforeEach(() => {
    getExtraRows = () => 3;
  });

  it('counts only background jobs when no foreground callback is provided', () => {
    const rail = new HealthRail({
      backgroundRegistry: mockRegistry([
        { status: 'running' },
        { status: 'running' },
        { status: 'completed' },
      ]),
      getExtraRows,
    });
    rail.update(makeStats());
    expect(getSnapshot(rail)).toEqual({ activeSubs: 2, totalSubs: 3 });
  });

  it('counts only foreground agents when no background registry is provided', () => {
    const rail = new HealthRail({
      getExtraRows,
      getForegroundAgentCounts: () => ({ active: 3, total: 5 }),
    });
    rail.update(makeStats());
    expect(getSnapshot(rail)).toEqual({ activeSubs: 3, totalSubs: 5 });
  });

  it('combines foreground + background active counts', () => {
    const rail = new HealthRail({
      backgroundRegistry: mockRegistry([{ status: 'running' }]),
      getExtraRows,
      getForegroundAgentCounts: () => ({ active: 4, total: 4 }),
    });
    rail.update(makeStats());
    // 1 bg running + 4 fg running = 5
    expect(getSnapshot(rail)?.activeSubs).toBe(5);
  });

  it('combines foreground + background total high-water marks', () => {
    const rail = new HealthRail({
      backgroundRegistry: mockRegistry([{ status: 'running' }, { status: 'completed' }]),
      getExtraRows,
      // 3 foreground total dispatched
      getForegroundAgentCounts: () => ({ active: 2, total: 3 }),
    });
    rail.update(makeStats());
    // 2 bg total + 3 fg total = 5
    expect(getSnapshot(rail)?.totalSubs).toBe(5);
  });

  it('ratchets background total upward when registry evicts terminal jobs', () => {
    // Simulate registry eviction: first call has 3 jobs, second has 1 (evicted 2).
    let callCount = 0;
    const registry = {
      list: () => {
        callCount++;
        if (callCount === 1) {
          return [
            { status: 'running' },
            { status: 'completed' },
            { status: 'completed' },
          ] as ReturnType<BackgroundAgentRegistry['list']>;
        }
        // Eviction: completed jobs removed
        return [{ status: 'running' }] as ReturnType<BackgroundAgentRegistry['list']>;
      },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as BackgroundAgentRegistry;

    const rail = new HealthRail({ backgroundRegistry: registry, getExtraRows });

    rail.update(makeStats()); // First: total=3, sets totalBgSubsEver=3
    rail.update(makeStats()); // Second: registry.list() returns 1, but high-water stays 3
    expect(getSnapshot(rail)?.totalSubs).toBe(3);
  });

  it('ratchets foreground total upward when agents finish and total shrinks', () => {
    let fgTotal = 5;
    const rail = new HealthRail({
      getExtraRows,
      getForegroundAgentCounts: () => ({ active: fgTotal, total: fgTotal }),
    });

    rail.update(makeStats()); // totalFgSubsEver = 5
    fgTotal = 2; // 3 agents finished
    rail.update(makeStats()); // should ratchet to 5, not drop to 2
    expect(getSnapshot(rail)?.totalSubs).toBe(5);
  });

  it('shows zero counts when both sources are absent or empty', () => {
    const rail = new HealthRail({ getExtraRows });
    rail.update(makeStats());
    expect(getSnapshot(rail)).toEqual({ activeSubs: 0, totalSubs: 0 });
  });

  it('shows zero activeSubs when all agents are terminal even with large total', () => {
    const rail = new HealthRail({
      backgroundRegistry: mockRegistry([
        { status: 'completed' },
        { status: 'completed' },
        { status: 'failed' },
      ]),
      getExtraRows,
      getForegroundAgentCounts: () => ({ active: 0, total: 4 }),
    });
    rail.update(makeStats());
    expect(getSnapshot(rail)?.activeSubs).toBe(0);
    // 3 bg + 4 fg = 7 total
    expect(getSnapshot(rail)?.totalSubs).toBe(7);
  });
});
