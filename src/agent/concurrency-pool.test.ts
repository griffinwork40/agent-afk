/**
 * Tests for the shared bounded-concurrency worker pool
 * (`settleWithConcurrencyLimit`) reused by the tool dispatcher, the compose/DAG
 * layer executor, and the skill wave runner.
 *
 * Verifies: input-order results, cap enforcement, parallel behaviour when the
 * cap is slack, the floor-at-1 degenerate case, empty input, and in-place
 * rejection capture without failing siblings.
 */

import { describe, it, expect } from 'vitest';
import {
  settleWithConcurrencyLimit,
  DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS,
} from './concurrency-pool.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('settleWithConcurrencyLimit', () => {
  it('returns results in input order regardless of completion order', async () => {
    // item 0 finishes slowest, item 2 fastest — order must still be [0,1,2].
    const out = await settleWithConcurrencyLimit([30, 20, 10], 3, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 20, 10]);
  });

  it('runs at most `limit` workers simultaneously', async () => {
    let live = 0;
    let peak = 0;
    await settleWithConcurrencyLimit([...Array(6).keys()], 2, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await sleep(20);
      live--;
      return n;
    });
    expect(peak).toBe(2);
  });

  it('with limit >= items.length runs everything in parallel (peak === length)', async () => {
    let live = 0;
    let peak = 0;
    await settleWithConcurrencyLimit([...Array(4).keys()], 10, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await sleep(15);
      live--;
      return n;
    });
    expect(peak).toBe(4);
  });

  it('floors a non-positive limit to 1 (sequential, peak === 1)', async () => {
    let live = 0;
    let peak = 0;
    await settleWithConcurrencyLimit([1, 2, 3], 0, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await sleep(10);
      live--;
      return n;
    });
    expect(peak).toBe(1);
  });

  it('returns [] for empty items without invoking the worker', async () => {
    let calls = 0;
    const out = await settleWithConcurrencyLimit([], 4, async () => {
      calls++;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('captures a worker rejection in place without failing siblings', async () => {
    const out = await settleWithConcurrencyLimit([0, 1, 2], 3, async (n) => {
      if (n === 1) throw new Error('boom');
      return n;
    });
    expect(out[0]).toEqual({ status: 'fulfilled', value: 0 });
    const r1 = out[1]!;
    expect(r1.status).toBe('rejected');
    if (r1.status === 'rejected') expect(r1.reason).toBeInstanceOf(Error);
    expect(out[2]).toEqual({ status: 'fulfilled', value: 2 });
  });

  it('DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS is a positive integer >= 2', () => {
    expect(Number.isInteger(DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS)).toBe(true);
    expect(DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS).toBeGreaterThanOrEqual(2);
  });
});
