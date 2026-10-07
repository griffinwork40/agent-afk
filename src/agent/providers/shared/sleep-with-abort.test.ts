import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleepWithAbort } from './sleep-with-abort.js';

describe('sleepWithAbort', () => {
  afterEach(() => vi.restoreAllMocks());

  // Regression: an unref'd backoff timer let a one-shot CLI exit 0 mid-retry.
  it('keeps the event loop alive while waiting (timer is not unref\'d)', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const unrefSpies: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      const spy = vi.fn(() => timer);
      timer.unref = spy as unknown as typeof timer.unref;
      unrefSpies.push(spy);
      return timer;
    }) as unknown as typeof setTimeout);
    await sleepWithAbort(5, new AbortController().signal);
    expect(unrefSpies.length).toBeGreaterThan(0);
    for (const spy of unrefSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('resolves promptly on abort', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = sleepWithAbort(60_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('resolves immediately when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleepWithAbort(60_000, ac.signal)).resolves.toBeUndefined();
  });
});
