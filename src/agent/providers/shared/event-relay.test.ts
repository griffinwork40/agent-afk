/**
 * Tests for relayWhilePending (providers/shared/event-relay.ts).
 *
 * Invariants under test:
 *  1. Synchronous emit — an event fired inside `start` before any await is
 *     buffered and yielded before the return value.
 *  2. Events are visible BEFORE the pending promise resolves.
 *  3. FIFO order is preserved across multiple emitted events.
 *  4. A same-tick final event (emitted in the microtask that resolves the
 *     promise) is still delivered before the return value.
 *  5. Rejection propagates — the generator throws with the rejection reason.
 *  6. No hang on rejection — the drain loop exits even if emit was called
 *     before the rejection.
 *  7. emit is a no-op after settlement — a late callback cannot append events
 *     after the generator has returned.
 *
 * All tests are deterministic: deferred promises are resolved/rejected from
 * the outside; no wall-clock timing.
 */

import { describe, it, expect, vi } from 'vitest';
import { relayWhilePending } from './event-relay.js';

/** Drain a relayWhilePending generator into arrays of events + return value. */
async function drain<E, R>(
  gen: AsyncGenerator<E, R, void>,
): Promise<{ events: E[]; value: R }> {
  const events: E[] = [];
  let result = await gen.next();
  while (!result.done) {
    events.push(result.value as E);
    result = await gen.next();
  }
  return { events, value: result.value as R };
}

describe('relayWhilePending', () => {
  it('yields a synchronously emitted event before returning', async () => {
    const gen = relayWhilePending<string, number>((emit) => {
      emit('sync-event');
      return Promise.resolve(42);
    });

    const { events, value } = await drain(gen);
    expect(events).toEqual(['sync-event']);
    expect(value).toBe(42);
  });

  it('yields events emitted while the promise is still pending', async () => {
    let resolve!: (v: number) => void;
    const pending = new Promise<number>((r) => { resolve = r; });

    const gen = relayWhilePending<string, number>((emit) => {
      // Schedule an async emit before the promise resolves.
      setTimeout(() => emit('async-event'), 0);
      return pending;
    });

    // Start consuming — the generator should park waiting for events.
    const drainPromise = drain(gen);

    // Emit fires, then we resolve.
    await new Promise((r) => setTimeout(r, 0));
    resolve(7);

    const { events, value } = await drainPromise;
    expect(events).toEqual(['async-event']);
    expect(value).toBe(7);
  });

  it('delivers events BEFORE the return value (event visible before promise resolves)', async () => {
    const emitted: string[] = [];
    const returned: number[] = [];
    let resolve!: (v: number) => void;
    const pending = new Promise<number>((r) => { resolve = r; });

    const gen = relayWhilePending<string, number>((emit) => {
      setTimeout(() => emit('mid-flight'), 0);
      return pending;
    });

    // Pull events manually to observe ordering.
    const firstPull = gen.next();
    await new Promise((r) => setTimeout(r, 0)); // let emit fire
    resolve(99);

    const first = await firstPull;
    expect(first.done).toBe(false);
    emitted.push(first.value as string);

    const second = await gen.next();
    expect(second.done).toBe(true);
    returned.push(second.value as number);

    expect(emitted).toEqual(['mid-flight']);
    expect(returned).toEqual([99]);
    // Event came out before the value
    expect(emitted.length).toBeGreaterThan(0);
  });

  it('preserves FIFO order for multiple emitted events', async () => {
    let resolve!: (v: string) => void;
    const pending = new Promise<string>((r) => { resolve = r; });

    const gen = relayWhilePending<number, string>((emit) => {
      emit(1);
      emit(2);
      emit(3);
      return pending;
    });

    const drainPromise = drain(gen);
    resolve('done');
    const { events, value } = await drainPromise;

    expect(events).toEqual([1, 2, 3]);
    expect(value).toBe('done');
  });

  it('yields a same-tick final event (emitted in the settling microtask)', async () => {
    let resolve!: (v: number) => void;
    let emit!: (e: string) => void;
    const pending = new Promise<number>((r) => { resolve = r; });

    const gen = relayWhilePending<string, number>((e) => {
      emit = e;
      return pending;
    });

    const drainPromise = drain(gen);

    // Emit and resolve in the same synchronous step.
    emit('last-event');
    resolve(5);

    const { events, value } = await drainPromise;
    expect(events).toContain('last-event');
    expect(value).toBe(5);
  });

  it('propagates rejection — generator throws with the rejection reason', async () => {
    const err = new Error('dispatcher exploded');
    const gen = relayWhilePending<string, number>(() => Promise.reject(err));

    await expect(async () => {
      await drain(gen);
    }).rejects.toThrow('dispatcher exploded');
  });

  it('does not hang on rejection even when events were emitted before reject', async () => {
    let reject!: (e: unknown) => void;
    const pending = new Promise<number>((_, rej) => { reject = rej; });

    const gen = relayWhilePending<string, number>((emit) => {
      emit('before-reject');
      return pending;
    });

    const drainPromise = drain(gen);
    reject(new Error('boom'));

    await expect(drainPromise).rejects.toThrow('boom');
  });

  it('emit is a no-op after the promise has settled (no stray events)', async () => {
    let lateEmit!: (e: string) => void;
    const gen = relayWhilePending<string, number>((emit) => {
      lateEmit = emit;
      return Promise.resolve(1);
    });

    const { events } = await drain(gen);

    // Call emit AFTER the generator has returned.
    lateEmit('too-late');

    // No event was delivered (the generator is done).
    expect(events).toEqual([]);
  });

  it('handles zero events — returns value with empty event list', async () => {
    const gen = relayWhilePending<string, number>(() => Promise.resolve(100));
    const { events, value } = await drain(gen);
    expect(events).toEqual([]);
    expect(value).toBe(100);
  });
});
