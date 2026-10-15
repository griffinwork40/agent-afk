/**
 * Timeout tests for driveStream — first-byte (TTFB) and stream-stall watchdogs.
 *
 * Issue #2416: the openai-compatible provider had no first-byte timeout and no
 * stream-stall (idle) timeout on streaming requests; anthropic-direct had both.
 * This file pins the fix: armFirstByteTimeout and armStreamStallWatchdog are
 * now wired into driveStream, mirroring anthropic-direct/loop.ts.
 *
 * Tests use vi.useFakeTimers + advanceTimersByTimeAsync (same pattern as
 * anthropic-direct/loop.stall.test.ts) and small timeout values injected via
 * ctx.ttfbTimeoutMs / ctx.stallTimeoutMs to avoid relying on env variables.
 *
 * Parked streams REJECT when the abort signal fires (like the real SDK does),
 * so the test hangs if the watchdog fails to fire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  driveStream,
  type StreamDriveContext,
  type StreamDriveStrategy,
  type IterationResult,
} from './stream-drive.js';
import type { ProviderEvent } from '../../../provider.js';
import type { StreamState } from '../translate.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<StreamDriveContext>): StreamDriveContext {
  return {
    controller: new AbortController(),
    traceWriter: undefined,
    initSessionId: 'sess-test',
    currentModel: 'test-model',
    isClosed: () => false,
    ttfbTimeoutMs: undefined, // test cases set these explicitly
    stallTimeoutMs: undefined,
    ...overrides,
  };
}

async function drive<T>(
  ctx: StreamDriveContext,
  strategy: StreamDriveStrategy<T>,
): Promise<{ events: ProviderEvent[]; result: IterationResult | null }> {
  const gen = driveStream(ctx, strategy);
  const events: ProviderEvent[] = [];
  let result: IterationResult | null = null;
  for (;;) {
    const step = await gen.next();
    if (step.done) {
      result = step.value;
      break;
    }
    events.push(step.value);
  }
  return { events, result };
}

/**
 * A stream that never yields and never resolves its next() — but REJECTS the
 * moment the provided signal fires. This models a parked SSE read that the SDK
 * would cancel on abort (as opposed to the openai@6 swallow behaviour, which is
 * already tested in stream-drive.test.ts). Necessary so the test does not hang
 * when the watchdog fails to arm.
 */
function parkedAbortableStream(signal: AbortSignal): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<never>> {
          return new Promise((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      };
    },
  };
}

/**
 * A stream that yields exactly `n` text events then parks forever (rejecting on
 * abort). Used to test "stall after some content".
 */
function streamThenStall(
  n: number,
  signal: AbortSignal,
): AsyncIterable<{ text: string }> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<{ text: string }>> {
          if (i < n) {
            i++;
            return Promise.resolve({ done: false, value: { text: `chunk-${i}` } });
          }
          // Park until abort
          return new Promise((_resolve, reject) => {
            if (signal.aborted) { reject(new Error('aborted')); return; }
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      };
    },
  };
}

/** Strategy that emits text chunks as assistant.message events. */
function makeTextStrategy(
  getStream: (signal: AbortSignal) => AsyncIterable<{ text: string }>,
): StreamDriveStrategy<{ text: string }> {
  return {
    createStream: async (signal) => getStream(signal),
    translate: (event, state: StreamState) => {
      state.assistantText += event.text;
      state.finishReason = 'stop'; // mark complete so no stream-incomplete error
      return [{ type: 'assistant.message' as const, text: event.text }];
    },
    clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('driveStream — TTFB timeout', () => {
  it('retries then succeeds when first attempt stalls before any chunk (TTFB fires)', async () => {
    // Attempt 1: parked stream (TTFB fires after 500ms).
    // Attempt 2: immediate single-chunk stream (succeeds).
    let callCount = 0;

    const strategy: StreamDriveStrategy<{ text: string }> = {
      createStream: async (signal) => {
        callCount++;
        if (callCount === 1) return parkedAbortableStream(signal);
        // Second attempt: yield a chunk immediately.
        return (async function* () { yield { text: 'hello' }; })();
      },
      translate: (event, state: StreamState) => {
        state.assistantText += event.text;
        state.finishReason = 'stop';
        return [{ type: 'assistant.message' as const, text: event.text }];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx({ ttfbTimeoutMs: 500, stallTimeoutMs: 60_000 });
    const resultPromise = drive(ctx, strategy);

    // Advance past the TTFB window (500ms) + retry backoff (computeBackoffDelay(0)=2000ms).
    await vi.advanceTimersByTimeAsync(5_000);
    const { events, result } = await resultPromise;

    // Must have retried (stream.retry event) and succeeded.
    expect(callCount).toBe(2);
    const retryEvents = events.filter((e) => e.type === 'stream.retry');
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);

    // Second attempt succeeded.
    expect(result).not.toBeNull();
    expect(result?.text).toBe('hello');

    // No error event.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('surfaces an error when TTFB fires and retry budget is exhausted', async () => {
    // Always parks (TTFB fires every time), exhausts MAX_STREAM_RETRIES (3).
    let callCount = 0;

    const strategy: StreamDriveStrategy<never> = {
      createStream: async (signal) => {
        callCount++;
        return parkedAbortableStream(signal);
      },
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx({ ttfbTimeoutMs: 500, stallTimeoutMs: 60_000 });
    const resultPromise = drive(ctx, strategy);

    // Advance enough for all retries (4 attempts × (500ms ttfb + backoff)).
    await vi.advanceTimersByTimeAsync(30_000);
    const { events, result } = await resultPromise;

    expect(result).toBeNull();
    const errEvents = events.filter((e) => e.type === 'error');
    expect(errEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT arm TTFB when ttfbTimeoutMs is 0 (disabled)', async () => {
    // With TTFB disabled, a parked stream would hang forever — but we abort
    // manually after a short time to verify the test does not hang.
    let createCalled = false;
    const strategy: StreamDriveStrategy<never> = {
      createStream: async (signal) => {
        createCalled = true;
        return parkedAbortableStream(signal);
      },
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx({ ttfbTimeoutMs: 0, stallTimeoutMs: 0 });
    const resultPromise = drive(ctx, strategy);

    // Advance time — TTFB is disabled so the watchdog must NOT fire.
    await vi.advanceTimersByTimeAsync(5_000);

    // Manually abort the turn (simulates user interrupt) to unpark the test.
    ctx.controller.abort('test-done');
    const { events, result } = await resultPromise;

    expect(createCalled).toBe(true);
    // User abort returns null with no error event (interrupt, not timeout).
    expect(result).toBeNull();
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });
});

describe('driveStream — stream-stall timeout', () => {
  it('surfaces a stall error when stream goes silent after yielding content (fatal — not retried)', async () => {
    // One text chunk emitted, then permanent stall → stall watchdog fires.
    let callCount = 0;

    const strategy = makeTextStrategy((signal) => {
      callCount++;
      return streamThenStall(1, signal);
    });

    const ctx = makeCtx({ ttfbTimeoutMs: 60_000, stallTimeoutMs: 1_000 });
    const resultPromise = drive(ctx, strategy);

    // Advance past stall window.
    await vi.advanceTimersByTimeAsync(5_000);
    const { events, result } = await resultPromise;

    // Fatal: no retry after partial content.
    expect(callCount).toBe(1);
    expect(result).toBeNull();

    const errEvents = events.filter((e) => e.type === 'error');
    expect(errEvents).toHaveLength(1);
    const err = errEvents[0];
    if (!err || err.type !== 'error') throw new Error('expected error event');

    // Must name the stall and the escape hatch.
    expect(err.error.message).toMatch(/stalled/i);
    expect(err.error.message).toContain('AFK_MODEL_STALL_TIMEOUT_MS');

    // No stream.retry events (stall-after-content is not retriable).
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
  });

  it('does NOT fire stall when chunks arrive steadily below the window', async () => {
    // 5 chunks, each arriving 200ms apart. Stall window = 500ms.
    // Each gap (200ms) < stall window (500ms) → must complete successfully.
    const CHUNKS = 5;
    const GAP_MS = 200;

    const strategy: StreamDriveStrategy<{ text: string }> = {
      createStream: async () => {
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next(): Promise<IteratorResult<{ text: string }>> {
                if (i >= CHUNKS) return { done: true, value: undefined };
                i++;
                if (i > 1) {
                  await new Promise<void>((r) => {
                    const t = setTimeout(r, GAP_MS);
                    (t as { unref?: () => void }).unref?.();
                  });
                }
                return { done: false, value: { text: `c${i}` } };
              },
            };
          },
        };
      },
      translate: (event, state: StreamState) => {
        state.assistantText += event.text;
        state.finishReason = 'stop';
        return [{ type: 'assistant.message' as const, text: event.text }];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx({ ttfbTimeoutMs: 60_000, stallTimeoutMs: 500 });
    const resultPromise = drive(ctx, strategy);

    // Advance well past total duration (CHUNKS × GAP_MS = 1000ms).
    await vi.advanceTimersByTimeAsync(5_000);
    const { events, result } = await resultPromise;

    // Clean completion — no errors, no retries.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
    expect(result).not.toBeNull();
    expect(result?.text).toBe('c1c2c3c4c5');
  });

  it('does NOT arm stall when stallTimeoutMs is 0 (disabled)', async () => {
    // With stall disabled, one chunk then park. Manually abort to end the test.
    let callCount = 0;
    const strategy = makeTextStrategy((signal) => {
      callCount++;
      return streamThenStall(1, signal);
    });

    const ctx = makeCtx({ ttfbTimeoutMs: 0, stallTimeoutMs: 0 });
    const resultPromise = drive(ctx, strategy);

    await vi.advanceTimersByTimeAsync(5_000);

    // Manually abort (user interrupt).
    ctx.controller.abort('test-done');
    const { events, result } = await resultPromise;

    // User abort → null, no error, no stall fired.
    expect(result).toBeNull();
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(callCount).toBe(1);
  });
});

describe('driveStream — stall-before-content retryable path', () => {
  it('yields stream.retry and retries when stall fires before any content is yielded', async () => {
    // Stream delivers raw frames that translate to NO ProviderEvents
    // (contentYieldedThisAttempt stays false), then stalls. Stall fires before
    // content → retryable. Second attempt delivers real content and succeeds.
    let callCount = 0;

    const strategy: StreamDriveStrategy<{ text: string }> = {
      createStream: async (signal) => {
        callCount++;
        if (callCount === 1) {
          // Yield one "empty" raw frame then park — translate returns nothing.
          return {
            [Symbol.asyncIterator]() {
              let i = 0;
              return {
                next(): Promise<IteratorResult<{ text: string }>> {
                  if (i === 0) {
                    i++;
                    return Promise.resolve({ done: false, value: { text: '' } });
                  }
                  // Park until abort (stall watchdog fires).
                  return new Promise((_resolve, reject) => {
                    if (signal.aborted) { reject(new Error('aborted')); return; }
                    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                  });
                },
              };
            },
          };
        }
        // Second attempt: immediate content, clean finish.
        return (async function* () { yield { text: 'ok' }; })();
      },
      translate: (event, state: StreamState) => {
        // Only yield an event for non-empty text, so attempt 1 yields nothing.
        if (!event.text) return [];
        state.assistantText += event.text;
        state.finishReason = 'stop';
        return [{ type: 'assistant.message' as const, text: event.text }];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx({ ttfbTimeoutMs: 60_000, stallTimeoutMs: 500 });
    const resultPromise = drive(ctx, strategy);

    // Advance past the stall window (500ms) + retry backoff.
    await vi.advanceTimersByTimeAsync(10_000);
    const { events, result } = await resultPromise;

    // Must have issued stream.retry.
    const retryEvents = events.filter((e) => e.type === 'stream.retry');
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);

    // Second attempt succeeded — no error, real text returned.
    expect(result).not.toBeNull();
    expect(result?.text).toBe('ok');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(callCount).toBe(2);
  });
});

describe('driveStream — user abort is not misreported as timeout', () => {
  it('returns null with no error event when the user aborts mid-stream', async () => {
    // Parked stream + user abort. Must return null (interrupt), never an error.
    const strategy: StreamDriveStrategy<never> = {
      createStream: async (signal) => parkedAbortableStream(signal),
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    // Large timeouts so watchdogs don't interfere.
    const ctx = makeCtx({ ttfbTimeoutMs: 60_000, stallTimeoutMs: 60_000 });
    const gen = driveStream(ctx, strategy);
    const events: ProviderEvent[] = [];

    const drained = (async () => {
      for (;;) {
        const step = await gen.next();
        if (step.done) return step.value;
        events.push(step.value);
      }
    })();

    // Advance time slightly then abort.
    await vi.advanceTimersByTimeAsync(100);
    ctx.controller.abort('user-interrupted');
    const result = await drained;

    expect(result).toBeNull();
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });
});
