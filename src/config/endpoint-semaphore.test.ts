import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEndpointSemaphore,
  withEndpointSemaphore,
  _resetEndpointSemaphores,
} from './endpoint-semaphore.js';

beforeEach(() => {
  _resetEndpointSemaphores();
});

describe('getEndpointSemaphore', () => {
  it('returns null when limit is undefined', () => {
    expect(getEndpointSemaphore('http://localhost:11434/v1', undefined)).toBeNull();
  });

  it('returns null when limit is 0', () => {
    expect(getEndpointSemaphore('http://localhost:11434/v1', 0)).toBeNull();
  });

  it('returns null when baseUrl is undefined', () => {
    expect(getEndpointSemaphore(undefined, 1)).toBeNull();
  });

  it('returns a semaphore with the configured limit', () => {
    const sem = getEndpointSemaphore('http://localhost:11434/v1', 3);
    expect(sem).not.toBeNull();
    expect(sem?.limit).toBe(3);
  });

  it('returns the SAME semaphore instance for the same baseUrl (shared semaphore)', () => {
    const a = getEndpointSemaphore('http://localhost:11434/v1', 2);
    const b = getEndpointSemaphore('http://localhost:11434/v1', 2);
    expect(a).toBe(b);
  });

  it('normalises trailing slash — same semaphore regardless', () => {
    const a = getEndpointSemaphore('http://localhost:11434/v1/', 1);
    const b = getEndpointSemaphore('http://localhost:11434/v1', 1);
    expect(a).toBe(b);
  });

  it('normalises casing — same semaphore for upper and lower case URL', () => {
    const a = getEndpointSemaphore('HTTP://LOCALHOST:11434/V1', 1);
    const b = getEndpointSemaphore('http://localhost:11434/v1', 1);
    expect(a).toBe(b);
  });

  it('returns different semaphores for different baseUrls', () => {
    const a = getEndpointSemaphore('http://localhost:11434/v1', 1);
    const b = getEndpointSemaphore('http://localhost:8080/v1', 1);
    expect(a).not.toBe(b);
  });

  it('uses the existing semaphore limit on subsequent calls (process-lifetime registry)', () => {
    const a = getEndpointSemaphore('http://localhost:11434/v1', 5);
    // Second call with a different limit — existing semaphore wins.
    const b = getEndpointSemaphore('http://localhost:11434/v1', 99);
    expect(b?.limit).toBe(5);
    expect(a).toBe(b);
  });
});

describe('CountingSemaphore.acquire — pre-aborted signal (fast path)', () => {
  it('rejects immediately on a pre-aborted signal even when a slot is available', async () => {
    const sem = getEndpointSemaphore('http://localhost:11434/v1', 2)!;
    expect(sem.activeCount).toBe(0); // slot IS available

    const ac = new AbortController();
    ac.abort(); // abort BEFORE calling acquire

    await expect(sem.acquire(ac.signal)).rejects.toThrow(/AbortError|aborted/i);
    // Slot must not have been consumed.
    expect(sem.activeCount).toBe(0);
  });
});

describe('withEndpointSemaphore', () => {
  it('runs fn directly when sem is null (no-op when unconfigured)', async () => {
    let called = false;
    await withEndpointSemaphore(null, async () => { called = true; });
    expect(called).toBe(true);
  });

  it('runs fn when sem is provided and releases afterwards', async () => {
    const sem = getEndpointSemaphore('http://localhost:1234', 2)!;
    expect(sem.activeCount).toBe(0);
    await withEndpointSemaphore(sem, async () => {
      expect(sem.activeCount).toBe(1);
    });
    expect(sem.activeCount).toBe(0);
  });

  it('serialises same-key requests when limit is 1', async () => {
    const sem = getEndpointSemaphore('http://localhost:9999', 1)!;
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      withEndpointSemaphore(sem, async () => {
        order.push(n);
        // Yield so the event loop can advance other queued waiters.
        await Promise.resolve();
        order.push(-n);
      }),
    );
    await Promise.all(tasks);
    // With limit=1, each task must fully complete before the next starts:
    // [1, -1, 2, -2, 3, -3]
    expect(order).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it('allows parallel requests up to the limit', async () => {
    const sem = getEndpointSemaphore('http://localhost:7777', 2)!;
    const peaks: number[] = [];
    const tasks = [1, 2, 3].map(() =>
      withEndpointSemaphore(sem, async () => {
        peaks.push(sem.activeCount);
        await Promise.resolve();
      }),
    );
    await Promise.all(tasks);
    // At most 2 active at a time; first two start immediately (activeCount=2 each).
    expect(Math.max(...peaks)).toBeLessThanOrEqual(2);
  });

  it('releases semaphore even when fn throws', async () => {
    const sem = getEndpointSemaphore('http://localhost:5555', 1)!;
    await expect(
      withEndpointSemaphore(sem, async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(sem.activeCount).toBe(0);
    // Semaphore should be usable again.
    await withEndpointSemaphore(sem, async () => {});
    expect(sem.activeCount).toBe(0);
  });

  it('is a no-op (backward compatible) when unconfigured — same-key requests stay parallel', async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      withEndpointSemaphore(null, async () => {
        order.push(n);
        await Promise.resolve();
        order.push(-n);
      }),
    );
    await Promise.all(tasks);
    // All three start concurrently: 1, 2, 3 all push before any -n does.
    expect(order.slice(0, 3).sort()).toEqual([1, 2, 3]);
  });
});
