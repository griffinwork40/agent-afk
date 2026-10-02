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
//
// P1 tests (watchdog-state check): the 'stallTimedOut flag beats network_termination'
// and driveStream 'stall watchdog timedOut + TypeError terminated => stall, not retry'
// tests FAIL without the stallTimedOut parameter being checked in classifyStreamError.
//
// P2 tests (accept completed response): the 'terminal finish_reason before drop =>
// AcceptAction' and driveStream 'finish_reason then TypeError terminated => clean
// completion, no retry, createStream called once' tests FAIL without the
// terminalFinishReason guard in classifyStreamError.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyStreamError,
  type RetryAction,
  type FatalAction,
  type AcceptAction,
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

// ── P1: watchdog-state check ──────────────────────────────────────────────────
// Revert proof: remove the `stallTimedOut` parameter from classifyStreamError
// (or stop passing timeouts.stall.timedOut() in driveStream) and the unit test
// 'stallTimedOut flag beats network_termination' FAILS because classifyStreamError
// then falls through to Branch 4 and returns a retry instead of a fatal.

describe('classifyStreamError — P1 watchdog-state (stallTimedOut / ttfbTimedOut flags)', () => {
  it('stallTimedOut flag beats a bare TypeError terminated (race-condition path)', () => {
    // Scenario: the stall watchdog fired and set didTimeout=true, but the
    // transport also threw TypeError('terminated') which won the Promise.race.
    // The error shape does NOT pass isStallTimeoutError, but the watchdog DID
    // fire — classifyStreamError must treat this as a stall, not as a retriable
    // network_termination. Without the stallTimedOut flag this test fails (the
    // branch falls through to network_termination and returns 'retry').
    const { action } = classifyStreamError(
      undiciTerminated(),      // NOT the stall marker error — the race winner
      true,                    // content yielded → stall is fatal
      0,
      60_000,
      /* stallTimedOut */ true, // watchdog DID fire
      /* ttfbTimedOut  */ false,
      /* terminalFinishReason */ null,
    );
    expect(action.kind).toBe('fatal');
    expect((action as FatalAction).error.message).toMatch(/stall/i);
  });

  it('ttfbTimedOut flag beats a bare TypeError terminated (race-condition path)', () => {
    // Scenario: TTFB watchdog fired but the socket throw won the Promise.race.
    // Must be classified as a ttfb_timeout retry, not a network_termination retry,
    // so that it counts against the TTFB budget and the stall watchdog budget
    // is not conflated. Without the ttfbTimedOut flag this would return
    // reason:'network_termination' instead of 'ttfb_timeout'.
    const { action } = classifyStreamError(
      undiciTerminated(),
      false,
      0,
      60_000,
      /* stallTimedOut */ false,
      /* ttfbTimedOut  */ true,
      /* terminalFinishReason */ null,
    );
    expect(action.kind).toBe('retry');
    expect((action as RetryAction).reason).toBe('ttfb_timeout');
  });

  it('stallTimedOut flag with no content yields stall_timeout retry (not fatal)', () => {
    // No content yet + watchdog fired: should retry (matches existing stall logic
    // where stall without content is retried).
    const { action } = classifyStreamError(
      undiciTerminated(),
      false,  // no content yet
      0,
      60_000,
      /* stallTimedOut */ true,
    );
    expect(action.kind).toBe('retry');
    expect((action as RetryAction).reason).toBe('stall_timeout');
  });
});

// ── P2: accept completed response ─────────────────────────────────────────────
// Revert proof: remove the `terminalFinishReason !== null` guard from
// classifyStreamError Branch 4, and the unit test 'terminal finish_reason before
// drop => AcceptAction' FAILS because classifyStreamError returns a retry action
// instead of an accept. The driveStream test then calls createStream twice instead
// of once, and the final result still contains the content but stream.retry is
// emitted when it should not be.

describe('classifyStreamError — P2 accept completed response', () => {
  it('terminal finish_reason before drop => AcceptAction (no retry)', () => {
    // Scenario: the stream delivered finish_reason='stop' on its last chunk and
    // THEN the transport threw TypeError('terminated'). The response is complete;
    // we must accept it, not retry. Without the terminalFinishReason guard this
    // test fails (returns kind:'retry' with reason:'network_termination').
    const { action, newStreamRetries } = classifyStreamError(
      undiciTerminated(),
      true,
      0,
      60_000,
      /* stallTimedOut         */ false,
      /* ttfbTimedOut          */ false,
      /* terminalFinishReason  */ 'stop',
    );
    expect(action.kind).toBe('accept');
    expect(newStreamRetries).toBe(0); // budget unchanged — we accepted, not retried
  });

  it('tool_calls finish_reason before drop => AcceptAction', () => {
    const { action } = classifyStreamError(
      undiciTerminated(),
      true,
      0,
      60_000,
      false,
      false,
      'tool_calls',
    );
    expect(action.kind).toBe('accept');
  });

  it('no finish_reason before drop => retry (normal network_termination path)', () => {
    // Sanity-check: when no terminal arrived, we still retry as before.
    const { action } = classifyStreamError(
      undiciTerminated(),
      false,
      0,
      60_000,
      false,
      false,
      null, // no terminal finish_reason
    );
    expect(action.kind).toBe('retry');
    expect((action as RetryAction).reason).toBe('network_termination');
  });
});

// ── P1 driveStream integration: stall watchdog + TypeError terminated ─────────
// The integration test proves the end-to-end path by using the real
// armStreamStallWatchdog with a very short timeout and real timers to cause the
// watchdog to fire, THEN having the stream throw TypeError('terminated'). Because
// the watchdog fires first (it aborts the signal that abortableStream races
// against), the catch in driveStream receives the stall marker error — OR if the
// transport race resolves first, timeouts.stall.timedOut() is true and the P1 fix
// in classifyStreamError routes it to a fatal stall. Either way: fatal, not retry.

describe('driveStream — P1 stall watchdog timedOut + TypeError terminated => stall, not retry', () => {
  // No fake timers — we need real timers for the watchdog to fire on real time.

  it('stall watchdog timedOut: TypeError terminated surfaces as fatal stall (createStream called once)', async () => {
    // Revert proof: if driveStream does not pass timeouts.stall.timedOut() to
    // classifyStreamError, the function sees a plain TypeError('terminated') with
    // stallTimedOut=false and returns 'retry' — createStream is called twice and
    // no error event is emitted. With the fix, it detects the watchdog fired and
    // returns 'fatal', emitting an error and calling createStream only once.
    let callCount = 0;

    // Use a very short stall timeout (10ms). The stream will call stall.progress()
    // via the translate path, which arms the watchdog. After progress() arms the
    // watchdog, we delay 20ms so it fires, then throw TypeError('terminated').
    const ctx = makeCtx({ stallTimeoutMs: 10, ttfbTimeoutMs: 0 });

    const strategy: StreamDriveStrategy<{ text: string }> = {
      createStream: async () => {
        callCount++;
        return (async function* (): AsyncIterable<{ text: string }> {
          // Yield one chunk so the TTFB is seen and stall.progress() is called
          // by driveStream (arming the watchdog).
          yield { text: 'partial' };
          // Wait long enough for the 10ms stall watchdog to fire.
          await new Promise((r) => setTimeout(r, 30));
          // Now throw the transport error — the watchdog already fired, so
          // timeouts.stall.timedOut() === true in classifyStreamError.
          throw undiciTerminated();
        })();
      },
      translate: (event, state: StreamState) => {
        state.assistantText += event.text;
        // No finish_reason — partial content, no terminal.
        return [{ type: 'delta.text', text: event.text, sessionId: 'sess-p1' } as ProviderEvent];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const { events, result } = await drive(ctx, strategy);

    // With the P1 fix: stall watchdog timed out → fatal → error event emitted,
    // result is null, createStream called exactly once (no retry).
    expect(callCount).toBe(1);
    expect(result).toBeNull();
    const errEvents = events.filter((e) => e.type === 'error');
    expect(errEvents).toHaveLength(1);
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
  }, 5_000);
});

// ── P2 driveStream integration: finish_reason then TypeError terminated ───────

describe('driveStream — P2 finish_reason then TypeError terminated => clean completion', () => {
  beforeEach(() => {
    __setRetryBaseDelay(0);
    vi.useFakeTimers();
  });
  afterEach(() => {
    __setRetryBaseDelay(null);
    vi.useRealTimers();
  });

  it('finish_reason then termination: completes with content, no stream.retry, createStream called once', async () => {
    // Revert proof: remove the terminalFinishReason guard from classifyStreamError.
    // classifyStreamError then returns 'retry' → createStream is called twice,
    // stream.retry is emitted once — the test fails on callCount===2 and
    // stream.retry count === 1. With the fix, AcceptAction → no retry, no error.
    let callCount = 0;
    const strategy: StreamDriveStrategy<{ text: string; finishReason?: string }> = {
      createStream: async () => {
        callCount++;
        return (async function* () {
          yield { text: 'answer text', finishReason: 'stop' };
          // The terminal chunk was delivered; now the transport resets.
          throw undiciTerminated();
        })();
      },
      translate: (event, state: StreamState) => {
        state.assistantText += event.text;
        if (event.finishReason) state.finishReason = event.finishReason;
        return [{ type: 'delta.text', text: event.text, sessionId: 'sess-p2' } as ProviderEvent];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx();
    const resultPromise = drive(ctx, strategy);
    await vi.advanceTimersByTimeAsync(100);
    const { events, result } = await resultPromise;

    expect(callCount).toBe(1);
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(result).not.toBeNull();
    expect(result?.text).toBe('answer text');
    expect(result?.state.finishReason).toBe('stop');
  });

  it('tool_calls finish_reason then termination: needsToolDispatch is true', async () => {
    // Verifies that P2 + tool-call finish dispatches tools normally.
    let callCount = 0;
    const strategy: StreamDriveStrategy<{ toolCall?: boolean; finishReason?: string }> = {
      createStream: async () => {
        callCount++;
        return (async function* () {
          yield { toolCall: true, finishReason: 'tool_calls' };
          throw undiciTerminated();
        })();
      },
      translate: (event, state: StreamState) => {
        if (event.finishReason) state.finishReason = event.finishReason;
        if (event.toolCall) {
          state.toolCallsByIndex.set(0, {
            index: 0,
            id: 'call_abc',
            name: 'my_tool',
            argumentsRaw: '{}',
            startEmitted: false,
          });
        }
        return [];
      },
      clarifyError: (e) => (e instanceof Error ? e : new Error(String(e))),
    };

    const ctx = makeCtx();
    const { result } = await drive(ctx, strategy);

    expect(callCount).toBe(1);
    expect(result).not.toBeNull();
    expect(result?.needsToolDispatch).toBe(true);
  });
});
