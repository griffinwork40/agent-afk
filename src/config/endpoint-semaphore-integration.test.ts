/**
 * Integration tests for endpoint-semaphore stream serialisation.
 *
 * These tests verify provider-level invariants that the unit tests in
 * endpoint-semaphore.test.ts cannot cover: that two concurrent acquirers never
 * overlap, that errors during hold correctly release the slot, and that an
 * aborted acquire does not permanently consume capacity.
 *
 * @module config/endpoint-semaphore-integration.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEndpointSemaphore,
  withEndpointSemaphore,
  _resetEndpointSemaphores,
} from './endpoint-semaphore.js';

beforeEach(() => {
  _resetEndpointSemaphores();
});

// ---------------------------------------------------------------------------
// Spec 6: streams never overlap
// ---------------------------------------------------------------------------

describe('stream lifetime serialisation (spec 6)', () => {
  it('two same-endpoint tasks never overlap when limit=1', async () => {
    const sem = getEndpointSemaphore('http://localhost:11434/v1', 1)!;

    // Record wall-clock intervals: [startMs, endMs] for each task.
    const intervals: Array<[number, number]> = [];

    const task = async (holdMs: number) => {
      await sem.acquire();
      const start = Date.now();
      try {
        // Simulate streaming work: yield the event loop several times.
        await new Promise<void>((r) => setTimeout(r, holdMs));
      } finally {
        intervals.push([start, Date.now()]);
        sem.release();
      }
    };

    // Start both tasks concurrently — they must serialise.
    await Promise.all([task(20), task(20)]);

    expect(intervals).toHaveLength(2);
    const [a, b] = intervals.sort((x, y) => x[0] - y[0]);

    // The second task must NOT start before the first finishes:
    // b.start >= a.end (allowing 2 ms for timer granularity).
    expect(b[0]).toBeGreaterThanOrEqual(a[1] - 2);
  });

  it('semaphore is released on error — slot is reusable', async () => {
    const sem = getEndpointSemaphore('http://localhost:11434/v1', 1)!;

    // First task errors after acquiring.
    await expect(
      withEndpointSemaphore(sem, async () => {
        throw new Error('stream error');
      }),
    ).rejects.toThrow('stream error');

    expect(sem.activeCount).toBe(0);

    // Slot must be usable again immediately.
    let ran = false;
    await withEndpointSemaphore(sem, async () => { ran = true; });
    expect(ran).toBe(true);
    expect(sem.activeCount).toBe(0);
  });

  it('aborted acquire does not permanently consume capacity', async () => {
    const sem = getEndpointSemaphore('http://localhost:11434/v1', 1)!;

    // Occupy the one slot.
    await sem.acquire();
    expect(sem.activeCount).toBe(1);

    const ac = new AbortController();

    // Queue a second acquire that we will abort.
    const pending = sem.acquire(ac.signal);
    // Abort immediately.
    ac.abort();
    await expect(pending).rejects.toThrow(/AbortError|aborted/i);

    // Release the original holder.
    sem.release();
    expect(sem.activeCount).toBe(0);

    // The slot must be fully available — a third acquire must resolve at once.
    const third = sem.acquire();
    await expect(third).resolves.toBeUndefined();
    sem.release();
    expect(sem.activeCount).toBe(0);
  });

  it('withEndpointSemaphore passes signal through to acquire', async () => {
    const sem = getEndpointSemaphore('http://localhost:11434/v1', 1)!;

    // Hold the slot.
    await sem.acquire();

    const ac = new AbortController();

    // withEndpointSemaphore should propagate the signal to acquire and reject.
    const pending = withEndpointSemaphore(sem, async () => 'ok', ac.signal);
    ac.abort();

    await expect(pending).rejects.toThrow(/AbortError|aborted/i);

    // Slot is still held by the first acquirer; release it.
    sem.release();
    expect(sem.activeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Spec 5: conflicting maxConcurrency warns once
// ---------------------------------------------------------------------------

describe('conflicting maxConcurrency warning (spec 5)', () => {
  it('emits a console.warn on the second registration with a different limit', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(' '));
    try {
      const a = getEndpointSemaphore('http://localhost:1234', 2);
      const b = getEndpointSemaphore('http://localhost:1234', 5);
      // Same instance returned (first writer wins).
      expect(a).toBe(b);
      expect(a?.limit).toBe(2);
      // Exactly one warning emitted.
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/conflicting/i);
      expect(warns[0]).toMatch(/2/);
      expect(warns[0]).toMatch(/5/);
      // Second call with same conflict does NOT warn again (one-shot).
      getEndpointSemaphore('http://localhost:1234', 99);
      expect(warns).toHaveLength(1);
    } finally {
      console.warn = orig;
    }
  });

  it('does not warn when limits match', () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(' '));
    try {
      getEndpointSemaphore('http://localhost:9876', 3);
      getEndpointSemaphore('http://localhost:9876', 3);
      expect(warns).toHaveLength(0);
    } finally {
      console.warn = orig;
    }
  });
});
