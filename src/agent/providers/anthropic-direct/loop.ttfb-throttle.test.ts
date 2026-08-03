// Regression guard for the `onThrottle` wiring in loop/round-request.ts.
//
// Invariant: the TTFB bound is armed ONCE PER ROUND, above `messages.create`,
// so its window also covers every 429/503/529 backoff the SDK sleeps out INSIDE
// that call. `openRound` therefore hands `awaitCreateWithThrottleSignals` an
// `onThrottle` callback that pushes the deadline out by the provider's own
// retry-after. Without it, sustained throttling aborts a request that was never
// given a chance to stream, and the failure is misreported as a first-byte
// stall.
//
// These tests drive that wiring end-to-end through `runTurn`. The seam-level
// tests (loop/throttle-signals.test.ts, shared/first-byte-timeout.test.ts)
// prove the primitives, but they hand-build the callback themselves — so
// deleting the third argument at the round-request.ts call site leaves every
// one of them green. These two are the only tests that fail for that edit.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawMessageStreamEvent, MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import type { AnthropicClientLike } from './types.js';
import { ThrottleQueue } from './throttle-queue.js';
import { DEFAULT_MODEL_TTFB_TIMEOUT_MS } from '../shared/first-byte-timeout.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeDispatcher,
} from './loop.test-helpers.js';

const KEY = 'AFK_MODEL_TTFB_TIMEOUT_MS';

/** 55s: just under the window the SDK actually honours, so it is a park that
 *  genuinely happens (a larger hint is discarded upstream and clamped here). */
const HONOURED_RETRY_AFTER_MS = 55_000;

const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];

/** Park a create promise until released; reject if the request signal aborts —
 *  exactly how a create that the TTFB bound aborted behaves. */
function parked(
  signal: AbortSignal,
  capture: (release: (stream: AsyncIterable<RawMessageStreamEvent>) => void) => void,
): Promise<AsyncIterable<RawMessageStreamEvent>> {
  return new Promise<AsyncIterable<RawMessageStreamEvent>>((resolve, reject) => {
    capture(resolve);
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

function turn(queue: ThrottleQueue, client: AnthropicClientLike) {
  return collect(
    runTurn({
      client,
      messages,
      system: null,
      tools: null,
      toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
      model: 'claude-test',
      maxTokens: 1024,
      headers: {},
      signal: new AbortController().signal,
      ctx,
      throttleQueue: queue,
    }),
  );
}

describe('runTurn — a throttle park does not become a first-byte stall', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    process.env[KEY] = String(DEFAULT_MODEL_TTFB_TIMEOUT_MS);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('forgives an EXPLAINED park: the round survives its whole original bound', async () => {
    const queue = new ThrottleQueue();
    let release!: (stream: AsyncIterable<RawMessageStreamEvent>) => void;
    let calls = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          calls++;
          return parked((opts as { signal: AbortSignal }).signal, (r) => (release = r));
        }),
      },
    };

    const resultPromise = turn(queue, client);
    // Let the loop reach the create await, then have the wrapped fetch report a
    // 429 the provider said it would hold for 55s.
    await vi.advanceTimersByTimeAsync(0);
    queue.push({ status: 429, retryAfterMs: HONOURED_RETRY_AFTER_MS });
    // Drain + extend BEFORE any timer fires: the extension must be in place
    // while the park it forgives is still running.
    await vi.advanceTimersByTimeAsync(0);

    // Burn the ENTIRE original bound. Un-extended, the timer fires here, aborts
    // a request that never streamed, and the round re-drives.
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TTFB_TIMEOUT_MS + 1_000);
    expect(calls).toBe(1);

    release(fromArray(makeTextStream('done')));
    const events = await resultPromise;

    // The signal really did drain (so the test is exercising the seam, not
    // passing because nothing happened), and the turn completed untouched.
    expect(events.some((e) => e.type === 'rate_limit')).toBe(true);
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
    expect(events.some((e) => e.type === 'assistant.message' && e.text === 'done')).toBe(true);
  });

  it('still trips the bound when the throttle explained NOTHING', async () => {
    // Identical to the case above except the signal carries no retryAfterMs, so
    // there is no communicated window to forgive. Unexplained silence must fail
    // on schedule — this is the half that keeps the fix from disabling the
    // watchdog.
    const queue = new ThrottleQueue();
    let release!: (stream: AsyncIterable<RawMessageStreamEvent>) => void;
    let calls = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((_params: unknown, opts: unknown) => {
          calls++;
          // First attempt parks until the bound aborts it; the re-drive streams.
          return calls === 1
            ? parked((opts as { signal: AbortSignal }).signal, (r) => (release = r))
            : fromArray(makeTextStream('recovered'));
        }),
      },
    };

    const resultPromise = turn(queue, client);
    await vi.advanceTimersByTimeAsync(0);
    queue.push({ status: 429 });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TTFB_TIMEOUT_MS + 1_000);
    const events = await resultPromise;

    expect(calls).toBe(2); // aborted at the bound, then re-driven once
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
    expect(events.some((e) => e.type === 'assistant.message' && e.text === 'recovered')).toBe(
      true,
    );
    // `release` is intentionally unused: the abort, not a resolution, ends
    // attempt one. Referenced so noUnusedLocals stays satisfied.
    expect(typeof release).toBe('function');
  });
});
