// Tests for classifyStreamError network-termination branch (#2780).
//
// A mid-stream undici TypeError('terminated') (or ECONNRESET / UND_ERR_SOCKET)
// was previously unclassified and fell through as a fatal error. After #2780 it
// retries up to MAX_STREAM_RETRIES using the same shared counter, EVEN when
// content was already yielded (matching the status-retry path), using the
// 'network_termination' reason for trace legibility.
//
// These tests cover classifyStreamError directly (unit layer) AND prove the
// end-to-end path through driveStream (integration layer).
//
// Revert proof: comment out the isMidStreamNetworkTermination branch in
// stream-drive.stream-error.ts and the 'retry then success' and
// 'retry after content' tests fail; restoring it makes them pass again.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyStreamError,
  type RetryAction,
} from './stream-drive.stream-error.js';
import {
  driveStream,
  type StreamDriveContext,
  type StreamDriveStrategy,
  type IterationResult,
} from './stream-drive.js';
import { MAX_STREAM_RETRIES, __setRetryBaseDelay } from './retry.js';
import type { ProviderEvent } from '../../../provider.js';
import type { StreamState } from '../translate.js';
import { TTFB_TIMEOUT_MESSAGE } from '../../shared/first-byte-timeout.js';
import { STALL_TIMEOUT_MESSAGE } from '../../shared/stream-stall-timeout.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The exact shape undici throws on a mid-body socket close. */
function undiciTerminated(): TypeError {
  const socketErr = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  return new TypeError('terminated', { cause: socketErr });
}

/** ECONNRESET thrown by node net / undici. */
function econnreset(): Error {
  return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
}

/** Fake stall-timeout error (same shape isStallTimeoutError detects). */
function stallTimeout(): Error {
  return new Error(STALL_TIMEOUT_MESSAGE);
}

/** Fake TTFB-timeout error (same shape isTtfbTimeoutError detects). */
function ttfbTimeout(): Error {
  return new Error(TTFB_TIMEOUT_MESSAGE);
}

function makeCtx(overrides?: Partial<StreamDriveContext>): StreamDriveContext {
  return {
    controller: new AbortController(),
    traceWriter: undefined,
    initSessionId: 'sess-test',
    currentModel: 'test-model',
    isClosed: () => false,
    // Disable watchdogs in tests unless the test overrides them.
    ttfbTimeoutMs: 0,
    stallTimeoutMs: 0,
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

// ── classifyStreamError unit tests ───────────────────────────────────────────

describe('classifyStreamError — network_termination branch (#2780)', () => {
  it('returns retry with reason=network_termination for TypeError terminated', () => {
    const { action, newStreamRetries } = classifyStreamError(
      undiciTerminated(),
      false,
      0,
      60_000,
    );
    expect(action.kind).toBe('retry');
    expect((action as RetryAction).reason).toBe('network_termination');
    expect((action as RetryAction).source).toBe('stream');
    expect((action as RetryAction).attempt).toBe(1);
    expect(newStreamRetries).toBe(1);
  });

  it('returns retry for ECONNRESET', () => {
    const { action } = classifyStreamError(econnreset(), false, 0, 60_000);
    expect(action.kind).toBe('retry');
    expect((action as RetryAction).reason).toBe('network_termination');
  });

  it('retries EVEN WHEN content was already yielded (matches status-retry path)', () => {
    const { action, newStreamRetries } = classifyStreamError(
      undiciTerminated(),
      true, // content yielded this attempt
      0,
      60_000,
    );
    expect(action.kind).toBe('retry');
    expect(newStreamRetries).toBe(1);
  });

  it('returns fall-through when budget is exhausted', () => {
    const err = undiciTerminated();
    const { action, newStreamRetries } = classifyStreamError(
      err,
      false,
      MAX_STREAM_RETRIES, // budget full
      60_000,
    );
    expect(action.kind).toBe('fall-through');
    expect(newStreamRetries).toBe(MAX_STREAM_RETRIES); // unchanged
  });

  it('does NOT retry an unrelated TypeError', () => {
    const { action } = classifyStreamError(new TypeError('boom'), false, 0, 60_000);
    expect(action.kind).toBe('fall-through');
  });

  it('stall-timeout wins over network_termination (branch order)', () => {
    // The stall watchdog tears the socket itself, which can surface as
    // TypeError('terminated'). The stall branch must run first.
    // A stall with content already yielded is fatal (not retried).
    const { action } = classifyStreamError(
      stallTimeout(),
      true, // content already yielded → stall is fatal
      0,
      60_000,
    );
    expect(action.kind).toBe('fatal');
    expect((action as { kind: 'fatal'; error: Error }).error.message).toMatch(/stall/i);
  });

  it('ttfb-timeout wins over network_termination (branch order)', () => {
    const { action } = classifyStreamError(ttfbTimeout(), false, 0, 60_000);
    expect(action.kind).toBe('retry');
    expect((action as RetryAction).reason).toBe('ttfb_timeout');
  });
});

// ── driveStream integration tests ────────────────────────────────────────────
// These tests use fake timers + advanceTimersByTimeAsync to drive the backoff
// sleep in emitAndSleepRetry (sleepWithAbort → setTimeout) without real waits.
// __setRetryBaseDelay(0) makes computeBackoffDelay return 0ms, keeping
// advanceTimersByTimeAsync calls minimal.

describe('driveStream — network-termination re-drive (#2780)', () => {
  beforeEach(() => {
    __setRetryBaseDelay(0); // 0ms backoff so fake-timer advances are tiny
    vi.useFakeTimers();
  });
  afterEach(() => {
    __setRetryBaseDelay(null);
    vi.useRealTimers();
  });

  it('retries TypeError terminated then succeeds', async () => {
    let callCount = 0;
    const strategy: StreamDriveStrategy<{ text: string }> = {
      createStream: async () => {
        callCount++;
        if (callCount === 1) {
          return (async function* (): AsyncIterable<{ text: string }> {
            throw undiciTerminated();
          })();
        }
        return (async function* (): AsyncIterable<{ text: string }> {
          yield { text: 'recovered answer' };
        })();
      },
      translate: (event, state: StreamState) => {
        state.assistantText += event.text;
        state.finishReason = 'stop';
        return [];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx();
    const resultPromise = drive(ctx, strategy);
    await vi.advanceTimersByTimeAsync(100); // drive the 0ms backoff sleep
    const { events, result } = await resultPromise;

    expect(callCount).toBe(2);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
    expect(result).not.toBeNull();
    expect(result?.text).toBe('recovered answer');
  });

  it('exhausts budget and surfaces the ORIGINAL error (not wrapped)', async () => {
    const original = undiciTerminated();
    const strategy: StreamDriveStrategy<never> = {
      createStream: async () => {
        return (async function* (): AsyncIterable<never> {
          throw original;
        })();
      },
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx();
    const resultPromise = drive(ctx, strategy);
    // Drive all retry sleeps (MAX_STREAM_RETRIES retries × 0ms each, some ticks needed).
    await vi.advanceTimersByTimeAsync(500);
    const { events, result } = await resultPromise;

    // Should have retried MAX_STREAM_RETRIES times then given up.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(MAX_STREAM_RETRIES);
    expect(result).toBeNull();
    const errEvents = events.filter((e) => e.type === 'error');
    expect(errEvents).toHaveLength(1);
    const errEvent = errEvents[0];
    if (!errEvent || errEvent.type !== 'error') throw new Error('expected error event');
    // clarifyError passes the original through unchanged (it is already an Error).
    expect(errEvent.error).toBe(original);
  });

  it('retries after content was already yielded this attempt', async () => {
    let callCount = 0;
    const strategy: StreamDriveStrategy<{ text: string }> = {
      createStream: async () => {
        callCount++;
        if (callCount === 1) {
          return (async function* (): AsyncIterable<{ text: string }> {
            yield { text: 'partial' }; // content yielded before the drop
            throw undiciTerminated();
          })();
        }
        return (async function* (): AsyncIterable<{ text: string }> {
          yield { text: 'complete answer' };
        })();
      },
      translate: (event, state: StreamState) => {
        state.assistantText += event.text;
        if (event.text !== 'partial') state.finishReason = 'stop';
        return [{ type: 'text', text: event.text } as ProviderEvent];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx();
    const resultPromise = drive(ctx, strategy);
    await vi.advanceTimersByTimeAsync(100);
    const { events, result } = await resultPromise;

    expect(callCount).toBe(2);
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(result).not.toBeNull();
  });

  it('does NOT retry an unrelated TypeError', async () => {
    let callCount = 0;
    const strategy: StreamDriveStrategy<never> = {
      createStream: async () => {
        callCount++;
        return (async function* (): AsyncIterable<never> {
          throw new TypeError('boom');
        })();
      },
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx();
    const { events } = await drive(ctx, strategy);

    expect(callCount).toBe(1);
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
    const errEvents = events.filter((e) => e.type === 'error');
    expect(errEvents).toHaveLength(1);
  });

  it('stall-caused termination stays a stall error (not retried as network_termination)', () => {
    // The stall watchdog aborts the signal; the error that surfaces IS the stall
    // error (isStallTimeoutError = true). The stall branch fires before
    // network_termination — a stall with content yielded is fatal.
    const { action } = classifyStreamError(
      stallTimeout(),
      true, // content yielded → fatal stall
      0,
      60_000,
    );
    expect(action.kind).toBe('fatal');
    expect((action as { kind: 'fatal'; error: Error }).error.message).toMatch(/stall/i);
  });

  it('interrupt beats retry: abort during drive yields null (no error event)', async () => {
    const ctx = makeCtx();
    // Abort the turn signal before drive starts; the connection-phase check
    // (userSignal.aborted) fires immediately and driveStream returns null.
    ctx.controller.abort('interrupted');

    const strategy: StreamDriveStrategy<never> = {
      createStream: async () => {
        return (async function* (): AsyncIterable<never> {
          throw undiciTerminated();
        })();
      },
      translate: () => [],
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const { events, result } = await drive(ctx, strategy);

    expect(result).toBeNull();
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });
});
