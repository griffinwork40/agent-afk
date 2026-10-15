/**
 * Unit tests for `makeForegroundCountsGetter` — the stateful closure that
 * derives foreground-only subagent counts while excluding background-registered
 * handles from both the active count and the dispatch total.
 *
 * These tests verify the two behavioural requirements called out in issue #2662:
 *  1. The total keeps counting after foreground agents complete (ratchet).
 *  2. A running background job is NOT double-counted against the foreground
 *     active/total even though its handle lives in SubagentManager.list().
 */

import { describe, it, expect } from 'vitest';
import { makeForegroundCountsGetter } from './foreground-counts.js';
import type { FgCountsManagerSlice, FgCountsRegistrySlice } from './foreground-counts.js';

/** Build a fake manager slice for testing. */
function makeManager(
  handles: Array<{ id: string; status: string }>,
  dispatchCount: number,
): FgCountsManagerSlice {
  return {
    list: () => handles,
    dispatchCount,
  };
}

/** Build a fake registry slice for testing. */
function makeRegistry(jobs: Array<{ subagentId: string }>): FgCountsRegistrySlice {
  return { list: () => jobs };
}

describe('makeForegroundCountsGetter', () => {
  it('returns zero when manager has no handles and no registry', () => {
    const getter = makeForegroundCountsGetter(makeManager([], 0), undefined);
    expect(getter()).toEqual({ active: 0, total: 0 });
  });

  it('returns all handles as foreground when no background registry is wired', () => {
    const getter = makeForegroundCountsGetter(
      makeManager(
        [
          { id: 'h1', status: 'running' },
          { id: 'h2', status: 'running' },
          { id: 'h3', status: 'succeeded' },
        ],
        3,
      ),
      undefined,
    );
    expect(getter()).toEqual({ active: 2, total: 3 });
  });

  // ─── Requirement 2: no double-count for background handles ───────────────────

  it('excludes a running background handle from foreground active count', () => {
    // h1 = background running (in both manager.list() and backgroundRegistry)
    // h2 = foreground running (only in manager.list())
    const getter = makeForegroundCountsGetter(
      makeManager(
        [
          { id: 'bg-h1', status: 'running' },
          { id: 'fg-h2', status: 'running' },
        ],
        2,
      ),
      makeRegistry([{ subagentId: 'bg-h1' }]),
    );
    const counts = getter();
    // Only fg-h2 is foreground-active; bg-h1 is background-owned.
    expect(counts.active).toBe(1);
  });

  it('subtracts background total from dispatchCount to get foreground total', () => {
    // 4 total dispatches, 1 registered as background → 3 foreground-only total
    const getter = makeForegroundCountsGetter(
      makeManager(
        [
          { id: 'bg-h1', status: 'running' },
          { id: 'fg-h2', status: 'running' },
          { id: 'fg-h3', status: 'running' },
          { id: 'fg-h4', status: 'running' },
        ],
        4,
      ),
      makeRegistry([{ subagentId: 'bg-h1' }]),
    );
    expect(getter().total).toBe(3);
  });

  it('does not double-count a Ctrl+B-promoted handle (active in both maps)', () => {
    // After Ctrl+B promotion, the handle id appears in backgroundRegistry
    // while still in manager.list() (the manager only removes it on terminal).
    // active count must not include the promoted handle.
    const getter = makeForegroundCountsGetter(
      makeManager(
        [
          { id: 'promoted-h1', status: 'running' },
          { id: 'fg-h2', status: 'running' },
        ],
        2,
      ),
      makeRegistry([{ subagentId: 'promoted-h1' }]),
    );
    expect(getter().active).toBe(1); // only fg-h2
  });

  // ─── Requirement 1: total keeps counting after foreground agents complete ─────

  it('ratchets foreground total upward when handles leave the active map', () => {
    // Start: 5 fg dispatches (no bg), 3 currently running.
    let handles = [
      { id: 'h1', status: 'running' },
      { id: 'h2', status: 'running' },
      { id: 'h3', status: 'running' },
    ];
    let dispatchCount = 5;
    const getter = makeForegroundCountsGetter(
      {
        list: () => handles,
        get dispatchCount() { return dispatchCount; },
      },
      makeRegistry([]),
    );

    expect(getter()).toEqual({ active: 3, total: 5 });

    // All 3 complete and leave the active map; dispatchCount is still 5.
    handles = [];
    expect(getter()).toEqual({ active: 0, total: 5 });
  });

  it('does not inflate foreground total when background registry evicts terminal jobs', () => {
    // 3 total dispatches: 1 bg + 2 fg.
    // Initial call: bg registry has 1 job → bgSeenMax = 1; fg total = 3 - 1 = 2.
    // After eviction: bg registry returns 0 jobs — bgSeenMax stays 1 (ratchet)
    // so fg total stays 2, not 3 (which would be wrong).
    let bgJobs: Array<{ subagentId: string }> = [{ subagentId: 'bg-h1' }];
    const getter = makeForegroundCountsGetter(
      makeManager([], 3),
      { list: () => bgJobs },
    );

    expect(getter().total).toBe(2); // 3 dispatches − 1 bg = 2 fg

    bgJobs = []; // registry evicted the completed bg job
    expect(getter().total).toBe(2); // ratchet: bgSeenMax stays 1, not 0
  });
});
