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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthRail } from './health-rail.js';
import { ResizeBus } from './terminal-size.js';
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

// ───────────────────────────────────────────────────────────────────────────
// HealthRail — idle GROW footer ghost erase (defect 2, HealthRail component)
//
// Mirrors the LoopStageBar ghost-erase tests: when the pane grows while the
// compositor is idle, HealthRail must erase the old rail row before painting
// at the new (lower) position.
//
// Covers:
//   HR-G1 — subscribeImmediate is registered on start() and unregistered on stop().
//   HR-G2 — on GROW, the old health-rail row is erased before the new one is painted.
//   HR-G3 — on SHRINK, no attempt to erase a row outside the new viewport.
//   HR-G4 — pre-resize snapshot cleared after consumption (idempotent).
// ───────────────────────────────────────────────────────────────────────────

describe('HealthRail — idle GROW footer ghost erase', () => {
  let resizeCb: (() => void) | null;
  let resizeImmCb: (() => void) | null;
  let resizeUnsub: ReturnType<typeof vi.fn>;
  let resizeImmUnsub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resizeCb = null;
    resizeImmCb = null;
    resizeUnsub = vi.fn();
    resizeImmUnsub = vi.fn();
    vi.spyOn(ResizeBus, 'subscribe').mockImplementation((fn: () => void) => {
      resizeCb = fn;
      return resizeUnsub;
    });
    vi.spyOn(ResizeBus, 'subscribeImmediate').mockImplementation((fn: () => void) => {
      resizeImmCb = fn;
      return resizeImmUnsub;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTtyStream(rows: number): NodeJS.WriteStream & { rows: number } {
    return { columns: 80, rows, isTTY: true, write: vi.fn() } as unknown as NodeJS.WriteStream & { rows: number };
  }

  function joinWrites(stream: NodeJS.WriteStream): string {
    return (stream.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('');
  }

  function cupRows(out: string): number[] {
    return [...out.matchAll(/\x1b\[(\d+);1H/g)].map((m) => parseInt(m[1]!, 10));
  }

  function makeRail(stream: NodeJS.WriteStream, getExtraRows: () => number): HealthRail {
    return new HealthRail({ getExtraRows, stream });
  }

  it('HR-G1: subscribeImmediate is registered on start() and unregistered on stop()', () => {
    const stream = makeTtyStream(24);
    const rail = makeRail(stream, () => 2);
    rail.start();
    expect(resizeImmCb, 'subscribeImmediate callback must be registered on start()').not.toBeNull();
    rail.stop();
    expect(resizeImmUnsub, 'subscribeImmediate must be unsubscribed on stop()').toHaveBeenCalledOnce();
  });

  it('HR-G2: on GROW, the old health-rail row is erased before the new one is painted', () => {
    // extraRows=2 (LoopStageBar=1 + HealthRail=1); rail at row 23 (24-2+1=23).
    let rows = 24;
    const stream = {
      columns: 80,
      get rows() { return rows; },
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream & { rows: number };

    const rail = makeRail(stream, () => 2);
    rail.start();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    // Immediate channel: snapshot old row.
    expect(resizeImmCb).not.toBeNull();
    resizeImmCb!();

    // Debounced: GROW to rows=50, new rail at row 49 (50-2+1=49).
    rows = 50;
    resizeCb!();

    const out = joinWrites(stream);
    // Old row 23 must be erased.
    expect(out, 'old health-rail row 23 must be erased').toContain('\x1b[23;1H');
    expect(out, 'old health-rail row 23 must be cleared (EL)').toMatch(/\x1b\[23;1H\x1b\[2K/);
    // New rail must be at row 49.
    expect(cupRows(out), 'new health-rail must be at row 49').toContain(49);

    rail.stop();
  });

  it('HR-G3: on SHRINK, no attempt to address a row outside the new viewport', () => {
    // Start at 50 rows, rail at row 49. Shrink to 24 → new rail at row 23.
    let rows = 50;
    const stream = {
      columns: 80,
      get rows() { return rows; },
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream & { rows: number };

    const rail = makeRail(stream, () => 2);
    rail.start();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    // Immediate: snapshot row 49.
    resizeImmCb!();

    // Debounced: SHRINK to 24.
    rows = 24;
    resizeCb!();

    const out = joinWrites(stream);
    // Row 49 must NOT be addressed (outside the 24-row viewport).
    expect(out, 'row 49 must not be addressed after shrink to 24 rows').not.toContain('\x1b[49;1H');
    // New rail at row 23.
    expect(cupRows(out), 'new health-rail must be at row 23').toContain(23);

    rail.stop();
  });

  it('HR-G4: pre-resize snapshot cleared after consumption', () => {
    let rows = 24;
    const stream = {
      columns: 80,
      get rows() { return rows; },
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream & { rows: number };

    const rail = makeRail(stream, () => 2);
    rail.start();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    // First GROW: 24→50, rail 23→49.
    resizeImmCb!();
    rows = 50;
    resizeCb!();
    (stream.write as ReturnType<typeof vi.fn>).mockClear();

    // Second GROW: 50→70, rail 49→69.
    resizeImmCb!();
    rows = 70;
    resizeCb!();

    const out = joinWrites(stream);
    // Row 23 must NOT appear (snapshot consumed on first resize).
    expect(out, 'row 23 must not appear on second GROW').not.toContain('\x1b[23;1H');
    // Row 49 (previous rail) must be erased.
    expect(out, 'old rail row 49 must be erased on second GROW').toMatch(/\x1b\[49;1H\x1b\[2K/);

    rail.stop();
  });
});
