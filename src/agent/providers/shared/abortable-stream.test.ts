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

import { describe, it, expect, vi } from 'vitest';
import { abortableStream } from './abortable-stream.js';

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
  it('throws promptly when the signal aborts while a read is parked (the interrupt-lag bug)', async () => {
    const ac = new AbortController();
    const gen = abortableStream(parkedSource(), ac.signal);
    const pull = gen.next();
    // Without the abort race this pull would hang forever (the bug). The abort
    // must win the race and reject on the next microtasks — not after a timeout.
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
});
