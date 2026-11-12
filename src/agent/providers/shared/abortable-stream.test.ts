/**
 * Regression tests for the interrupt-lag fix.
 *
 * The bug: on ESC the turn signal aborts, but the SDK's SSE async-iterator only
 * surfaces the abort when its pending read settles — so a mid-stream
 * extended-thinking (Opus) turn kept "streaming" for seconds after ESC, and the
 * user's next message landed a turn late (they learned to poke "." to force it).
 * `abortableStream` makes the halt deterministic by racing each pull against the
 * signal. The load-bearing case is `throws promptly when a read is parked`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { abortableStream } from './abortable-stream.js';

// ---------------------------------------------------------------------------
// PauseController mock — shared across all tests that need pause control.
// Hoisted so vi.mock sees it before module resolution.
// ---------------------------------------------------------------------------
const mockIsPaused = vi.hoisted(() => vi.fn<() => boolean>().mockReturnValue(false));
const mockCheck = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));

vi.mock('../../session/pause-controller.js', () => ({
  PauseController: {
    instance: () => ({
      isPaused: mockIsPaused,
      check: mockCheck,
    }),
  },
}));

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** A source whose `next()` never resolves — models a parked SSE read. */
function parkedSource(returnSpy?: () => void): AsyncIterable<number> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise<IteratorResult<number>>(() => {
            /* never resolves — the read is parked awaiting the next SSE frame */
          });
        },
        return() {
          returnSpy?.();
          return Promise.resolve({ value: undefined as unknown as number, done: true });
        },
      };
    },
  };
}

describe('abortableStream', () => {
  beforeEach(() => {
    mockIsPaused.mockReturnValue(false);
    mockCheck.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('throws promptly when the signal aborts while a read is parked (the interrupt-lag bug)', async () => {
    const ac = new AbortController();
    const gen = abortableStream(parkedSource(), ac.signal);
    const pull = gen.next();
    // Without the abort race this pull would hang forever (the bug). The abort
    // must win the race and reject on the next microtasks — not after a timeout.
    ac.abort('interrupted');
    await expect(pull).rejects.toMatchObject({ name: 'AbortError', message: 'interrupted' });
  });

  it('does not wait for iterator cleanup after abort wins the race', async () => {
    const ac = new AbortController();
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<number>>(() => {
              /* parked read */
            });
          },
          return() {
            return new Promise<IteratorResult<number>>(() => {
              /* cleanup is stuck behind the parked read */
            });
          },
        };
      },
    };
    const gen = abortableStream(source, ac.signal);
    const pull = gen.next();
    ac.abort('interrupted');
    await expect(pull).rejects.toMatchObject({ name: 'AbortError', message: 'interrupted' });
  });

  it('passes values through in order and ends cleanly on done', async () => {
    const ac = new AbortController();
    const out: number[] = [];
    for await (const v of abortableStream(fromArray([1, 2, 3]), ac.signal)) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it('halts mid-stream: yields what arrived before ESC, then throws on abort', async () => {
    const ac = new AbortController();
    let deliver!: (r: IteratorResult<number>) => void;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<number>>((resolve) => {
              deliver = resolve;
            });
          },
        };
      },
    };
    const gen = abortableStream(source, ac.signal);
    const first = gen.next();
    deliver({ value: 7, done: false });
    expect(await first).toEqual({ value: 7, done: false });
    // Second read parks; ESC aborts before the next frame arrives.
    const second = gen.next();
    ac.abort('interrupted');
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws before touching the source when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort('interrupted');
    let pulled = false;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            pulled = true;
            return Promise.resolve({ value: 1, done: false });
          },
        };
      },
    };
    const gen = abortableStream(source, ac.signal);
    await expect(gen.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(pulled).toBe(false);
  });

  it('propagates a source error unchanged (never masks a real error as an abort)', async () => {
    const ac = new AbortController();
    const boom = new Error('stream failed');
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.reject(boom);
          },
        };
      },
    };
    await expect(
      (async () => {
        for await (const _v of abortableStream(source, ac.signal)) {
          /* drain */
        }
      })(),
    ).rejects.toBe(boom);
  });

  it('closes the source iterator on abort so the transport is released', async () => {
    const ac = new AbortController();
    const returnSpy = vi.fn();
    const gen = abortableStream(parkedSource(returnSpy), ac.signal);
    const pull = gen.next();
    ac.abort();
    await expect(pull).rejects.toMatchObject({ name: 'AbortError' });
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows the abandoned read rejection so it cannot surface as unhandledRejection', async () => {
    const ac = new AbortController();
    let rejectRead!: (e: unknown) => void;
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<number>>((_resolve, reject) => {
              rejectRead = reject;
            });
          },
        };
      },
    };
    const gen = abortableStream(source, ac.signal);
    const pull = gen.next();
    ac.abort('interrupted');
    await expect(pull).rejects.toMatchObject({ name: 'AbortError' });
    // The transport now rejects the abandoned read; the wrapper's no-op catch
    // must absorb it. Reaching the end without an unhandled rejection is the test.
    rejectRead(new Error('aborted read'));
    await Promise.resolve();
    await Promise.resolve();
    expect(true).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Stall-watchdog suspend/resume during pause (issue #4638)
  //
  // Bug: `StreamStallHandle` timers kept ticking while the session was paused.
  // If a pause exceeded the stall window (default 20 min), the watchdog fired
  // and aborted the per-request signal; when the pause resumed the
  // post-check() `signal.aborted` guard terminated the stream with a spurious
  // stall error — violating the "nothing is cancelled" contract.
  //
  // Fix (PR #4691): `abortable-stream.ts` calls `stallHandle.suspend()` before
  // blocking on `PauseController.check()` and `stallHandle.resumeTimer()` in
  // the finally block, guarded by `isPaused()` so hot-path non-pause pulls pay
  // no extra cost.
  // -------------------------------------------------------------------------

  it('suspend/resume: stall watchdog is suspended during pause and resumed after (issue #4638)', async () => {
    vi.useFakeTimers();

    // Simulate: session is paused. check() blocks until resolveCheck() fires.
    let resolveCheck!: () => void;
    mockIsPaused.mockReturnValue(true);
    mockCheck.mockImplementation(() => new Promise<void>((res) => { resolveCheck = res; }));

    const suspendSpy = vi.fn();
    const resumeTimerSpy = vi.fn();
    const stallHandle = { suspend: suspendSpy, resumeTimer: resumeTimerSpy };

    // Source: yields value 1 immediately on first pull.
    // The generator flow for pull #1:
    //   iterator.next() → value 1 → isPaused()=true → suspend() → check() BLOCKS
    // The check() promise parks; suspend/resumeTimer fire around it.
    const ac = new AbortController();
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ value: 1, done: false } as IteratorResult<number>),
        };
      },
    };

    const gen = abortableStream(source, ac.signal, stallHandle);

    // Start the first consumer pull. The generator will:
    //   1. await iterator.next() → value 1
    //   2. isPaused()=true → suspend()
    //   3. await check() — PARKS HERE (promise pending)
    const firstPull = gen.next();

    // Drain microtasks so generator reaches and parks inside check().
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // suspend() must have fired before check() blocked.
    expect(suspendSpy).toHaveBeenCalledTimes(1);
    expect(resumeTimerSpy).toHaveBeenCalledTimes(0);

    // Advance fake time well past the 20-min stall window.
    // The timer was suspended, so it must NOT abort.
    vi.advanceTimersByTime(25 * 60 * 1_000); // 25 minutes

    // The turn signal must still be live — watchdog was frozen.
    expect(ac.signal.aborted).toBe(false);

    // Resume the pause — resolveCheck() unblocks check().
    mockIsPaused.mockReturnValue(false);
    resolveCheck();

    // Drain microtasks so the finally { resumeTimer() } executes, then
    // signal.aborted is checked, then `yield result.value` runs.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // resumeTimer() must have fired after check() unblocked.
    expect(resumeTimerSpy).toHaveBeenCalledTimes(1);

    // signal is still live — no spurious abort from the stall watchdog.
    expect(ac.signal.aborted).toBe(false);

    // The first pull should resolve to value 1.
    expect(await firstPull).toEqual({ value: 1, done: false });

    // Clean up — abort so the generator's next parked read unblocks.
    ac.abort();
  });

  it('stall watchdog: suspend/resume NOT called when session is not paused (hot-path guard)', async () => {
    vi.useFakeTimers();

    // Not paused — isPaused() returns false (default mock).
    mockIsPaused.mockReturnValue(false);
    mockCheck.mockResolvedValue(undefined);

    const suspendSpy = vi.fn();
    const resumeTimerSpy = vi.fn();
    const stallHandle = { suspend: suspendSpy, resumeTimer: resumeTimerSpy };

    const ac = new AbortController();
    const gen = abortableStream(fromArray([1, 2, 3]), ac.signal, stallHandle);
    const out: number[] = [];
    for await (const v of gen) out.push(v);

    expect(out).toEqual([1, 2, 3]);
    // Guard: suspend/resumeTimer must NOT be called on a non-paused fast path.
    expect(suspendSpy).not.toHaveBeenCalled();
    expect(resumeTimerSpy).not.toHaveBeenCalled();
  });
});
