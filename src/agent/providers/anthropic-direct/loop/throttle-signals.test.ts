// Tests for the onThrottle seam that lets a caller forgive a provider-
// communicated park against a deadline it owns. The last describe block is the
// real regression guard: it reproduces the TTFB false positive end-to-end.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { awaitCreateWithThrottleSignals } from './throttle-signals.js';
import { ThrottleQueue } from '../throttle-queue.js';
import type { RunTurnInput } from '../types.js';
import {
  armFirstByteTimeout,
  throttleExtensionMs,
} from '../../shared/first-byte-timeout.js';

/** Minimal RunTurnInput: this generator only reads throttleQueue + ctx.sessionId. */
function inputWith(queue?: ThrottleQueue): RunTurnInput {
  return {
    ctx: { sessionId: 'sess-1' },
    ...(queue ? { throttleQueue: queue } : {}),
  } as unknown as RunTurnInput;
}

/** Drain a generator to completion, returning the yielded events + return value. */
async function drain<T, R>(
  gen: AsyncGenerator<T, R, void>,
): Promise<{ events: T[]; result: R }> {
  const events: T[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, result: step.value };
    events.push(step.value);
  }
}

const STREAM = (async function* () {})();

describe('awaitCreateWithThrottleSignals — onThrottle seam', () => {
  it('reports each drained signal\'s retryAfterMs', async () => {
    const queue = new ThrottleQueue();
    queue.push({ status: 429, retryAfterMs: 60_000 });
    queue.push({ status: 529, retryAfterMs: 20_000 });
    const seen: (number | undefined)[] = [];

    await drain(
      awaitCreateWithThrottleSignals(Promise.resolve(STREAM), inputWith(queue), (ms) =>
        seen.push(ms),
      ),
    );

    expect(seen).toEqual([60_000, 20_000]);
  });

  it('reports undefined when the provider sent no retry-after', async () => {
    // The caller must decide what to do with an unknowable window — this seam
    // does not invent one.
    const queue = new ThrottleQueue();
    queue.push({ status: 429 });
    const seen: (number | undefined)[] = [];

    await drain(
      awaitCreateWithThrottleSignals(Promise.resolve(STREAM), inputWith(queue), (ms) =>
        seen.push(ms),
      ),
    );

    expect(seen).toEqual([undefined]);
  });

  it('notifies BEFORE yielding the matching rate_limit event', async () => {
    // Ordering is load-bearing: the yield parks this generator until the consumer
    // resumes, while the deadline being extended races in real time. Notifying
    // after the yield would let the bound fire during the park it must forgive.
    const queue = new ThrottleQueue();
    queue.push({ status: 429, retryAfterMs: 1_000 });
    const log: string[] = [];

    const gen = awaitCreateWithThrottleSignals(
      Promise.resolve(STREAM),
      inputWith(queue),
      () => log.push('notify'),
    );
    const first = await gen.next();
    log.push(`yield:${(first.value as { type: string }).type}`);
    await drain(gen);

    expect(log).toEqual(['notify', 'yield:rate_limit']);
  });

  it('still returns the resolved stream, and is a no-op without a queue', async () => {
    const onThrottle = vi.fn();
    const { events, result } = await drain(
      awaitCreateWithThrottleSignals(Promise.resolve(STREAM), inputWith(), onThrottle),
    );
    expect(result).toBe(STREAM);
    expect(events).toEqual([]);
    expect(onThrottle).not.toHaveBeenCalled();
  });

  it('propagates a create rejection unchanged', async () => {
    const queue = new ThrottleQueue();
    queue.push({ status: 429, retryAfterMs: 1_000 });
    const boom = new Error('create failed');
    await expect(
      drain(
        awaitCreateWithThrottleSignals(Promise.reject(boom), inputWith(queue), () => {}),
      ),
    ).rejects.toBe(boom);
  });
});

describe('regression: a throttle park no longer trips the TTFB bound', () => {
  afterEach(() => vi.useRealTimers());

  it('does not report a first-byte stall for time the provider told us to wait', async () => {
    // The bug: armFirstByteTimeout is armed BEFORE messages.create, so its 180s
    // window covers every 429 backoff the SDK sleeps out INSIDE that call. Two
    // retries at ~55s each consumed ~110s of the budget, leaving prefill ~70s,
    // and the resulting abort was reported as a first-byte stall on a request
    // that had never been given a chance to stream.
    //
    // 55s is deliberately just under SDK_HONORED_RETRY_AFTER_CEILING_MS: the SDK
    // only sleeps out a retry-after while it is < 60s, so this is a park that
    // genuinely happens. A larger hint would be discarded upstream and clamped
    // here, which is covered by throttleExtensionMs' own tests.
    vi.useFakeTimers();
    const queue = new ThrottleQueue();
    const ttfb = armFirstByteTimeout(new AbortController().signal, 180_000);

    let release!: () => void;
    const create = new Promise<AsyncIterable<unknown>>((resolve) => {
      release = () => resolve(STREAM);
    });

    const gen = awaitCreateWithThrottleSignals(create, inputWith(queue), (ms) => {
      const extension = throttleExtensionMs(ms);
      if (extension !== undefined) ttfb.extend(extension);
    });
    const pump = drain(gen);

    // Two SDK-internal 429 retries, 55s of parking each.
    for (let i = 0; i < 2; i++) {
      queue.push({ status: 429, retryAfterMs: 55_000 });
      await vi.advanceTimersByTimeAsync(55_000);
    }
    // 110s of the original 180s budget is gone, and prefill has not started.
    expect(ttfb.timedOut()).toBe(false);

    // Prefill now takes a further 100s — 210s total, which would have blown the
    // un-extended bound at 180s. With the park forgiven it must survive.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(ttfb.timedOut()).toBe(false);
    expect(ttfb.signal.aborted).toBe(false);

    release();
    await pump;

    // The bound is still a bound: unexplained silence past the granted window
    // fires exactly as before.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(ttfb.timedOut()).toBe(true);
  });
});
