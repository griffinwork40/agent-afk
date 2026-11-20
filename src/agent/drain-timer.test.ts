/**
 * Tests that raceWithDrainTimeout clears the timer once the race settles,
 * so the event loop is not held open after session close/reset (#5169).
 *
 * @module agent/drain-timer.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { raceWithDrainTimeout } from './timeout.js';

describe('raceWithDrainTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the timer when the promise settles first', async () => {
    const promise = Promise.resolve();
    const race = raceWithDrainTimeout(promise, 5_000);
    // Let microtasks flush so the promise wins the race.
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    await race;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves at the timeout bound when promise never settles', async () => {
    const never = new Promise<void>(() => { /* never resolves */ });
    const race = raceWithDrainTimeout(never, 5_000);
    expect(vi.getTimerCount()).toBe(1);
    vi.runAllTimers();
    await race;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('swallows a rejection and clears the timer', async () => {
    const rejected = Promise.reject(new Error('init failed'));
    const race = raceWithDrainTimeout(rejected, 5_000);
    await Promise.resolve();
    await Promise.resolve();
    await expect(race).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
