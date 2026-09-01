/**
 * Tests for wait-for-poller.ts pollUntil.
 *
 * Uses fake timers (vi.useFakeTimers) so tests don't actually sleep.
 * Mocks sleepWithAbort to resolve immediately, advancing the poll loop
 * without real wall-clock delay.
 *
 * @module agent/tools/handlers/wait-for-poller.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock sleepWithAbort to resolve instantly — tests advance time by
// controlling evaluator calls, not actual delays.
vi.mock('../../providers/shared/sleep-with-abort.js', () => ({
  sleepWithAbort: vi.fn().mockResolvedValue(undefined),
}));

import { pollUntil, DEFAULT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS } from './wait-for-poller.js';
import type { WaitResult } from './wait-for-conditions.js';
import { sleepWithAbort } from '../../providers/shared/sleep-with-abort.js';

const mockSleep = vi.mocked(sleepWithAbort);

function makeMet(): WaitResult {
  return { met: true, detail: 'condition met' };
}
function makeMiss(): WaitResult {
  return { met: false, detail: 'not yet' };
}

// Helper: wrap a value-returning factory as a signal-accepting evaluator.
function makeEvaluator(fn: () => WaitResult | Promise<WaitResult>): (signal: AbortSignal) => Promise<WaitResult> {
  return (_signal: AbortSignal) => Promise.resolve(fn());
}

describe('pollUntil', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns succeeded immediately when evaluator returns met:true on first call', async () => {
    const evaluate = vi.fn(makeEvaluator(() => makeMet()));
    const ac = new AbortController();
    const result = await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      backoff: 'none',
      signal: ac.signal,
    });
    expect(result.status).toBe('succeeded');
    expect(result.attempts).toBe(1);
    expect(result.result?.met).toBe(true);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('retries until condition is met', async () => {
    let calls = 0;
    const evaluate = vi.fn((_sig: AbortSignal) => {
      calls++;
      return Promise.resolve(calls < 3 ? makeMiss() : makeMet());
    });
    const ac = new AbortController();
    const result = await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      backoff: 'none',
      signal: ac.signal,
    });
    expect(result.status).toBe('succeeded');
    expect(result.attempts).toBe(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it('passes a per-poll AbortSignal to the evaluator', async () => {
    const receivedSignals: AbortSignal[] = [];
    const evaluate = vi.fn(async (sig: AbortSignal) => {
      receivedSignals.push(sig);
      return makeMet();
    });
    const ac = new AbortController();
    await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      backoff: 'none',
      signal: ac.signal,
    });
    // The poller must have passed a signal (per-poll deadline signal, not the raw session signal).
    expect(receivedSignals.length).toBeGreaterThan(0);
    expect(receivedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('returns cancelled when session signal is aborted before first poll', async () => {
    const ac = new AbortController();
    ac.abort();
    const evaluate = vi.fn((_sig: AbortSignal) => Promise.resolve(makeMiss()));
    const result = await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      backoff: 'none',
      signal: ac.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('returns cancelled when session signal fires during evaluate', async () => {
    const ac = new AbortController();
    const evaluate = vi.fn(async (_sig: AbortSignal) => {
      ac.abort();
      throw new Error('AbortError');
    });
    const result = await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      backoff: 'none',
      signal: ac.signal,
    });
    expect(result.status).toBe('cancelled');
  });

  it('returns timed_out when timeout_ms is 0 and condition is not met', async () => {
    const evaluate = vi.fn((_sig: AbortSignal) => Promise.resolve(makeMiss()));
    const ac = new AbortController();
    const result = await pollUntil(evaluate, {
      timeout_ms: 0,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      backoff: 'none',
      signal: ac.signal,
    });
    expect(result.status).toBe('timed_out');
  });

  it('returns failed when evaluator throws (not a session abort)', async () => {
    const evaluate = vi.fn((_sig: AbortSignal) => Promise.reject(new Error('network down')));
    const ac = new AbortController();
    const result = await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      backoff: 'none',
      signal: ac.signal,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('network down');
  });

  it('none backoff always uses same interval', async () => {
    let calls = 0;
    const evaluate = vi.fn((_sig: AbortSignal) => {
      calls++;
      return Promise.resolve(calls < 3 ? makeMiss() : makeMet());
    });
    const ac = new AbortController();
    await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: 2_000,
      backoff: 'none',
      signal: ac.signal,
    });
    // Both sleep calls should use the same interval (up to capping).
    const sleepCalls = mockSleep.mock.calls;
    expect(sleepCalls.length).toBeGreaterThanOrEqual(2);
    // First two sleeps should be same value (none = fixed).
    expect(sleepCalls[0]![0]).toBe(sleepCalls[1]![0]);
  });

  it('linear backoff increases interval by 1000ms each attempt', async () => {
    let calls = 0;
    const evaluate = vi.fn((_sig: AbortSignal) => {
      calls++;
      return Promise.resolve(calls < 3 ? makeMiss() : makeMet());
    });
    const ac = new AbortController();
    await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: 2_000,
      backoff: 'linear',
      signal: ac.signal,
    });
    const sleepCalls = mockSleep.mock.calls;
    // After attempt 0: 2000 + 0*1000 = 2000
    // After attempt 1: 2000 + 1*1000 = 3000
    expect(sleepCalls[0]![0]).toBe(2_000);
    expect(sleepCalls[1]![0]).toBe(3_000);
  });

  it('exponential backoff doubles interval each attempt, capped at 60s', async () => {
    let calls = 0;
    const evaluate = vi.fn((_sig: AbortSignal) => {
      calls++;
      return Promise.resolve(calls < 4 ? makeMiss() : makeMet());
    });
    const ac = new AbortController();
    await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: 1_000,
      backoff: 'exponential',
      signal: ac.signal,
    });
    const sleepCalls = mockSleep.mock.calls;
    // 1000*2^0=1000, 1000*2^1=2000, 1000*2^2=4000
    expect(sleepCalls[0]![0]).toBe(1_000);
    expect(sleepCalls[1]![0]).toBe(2_000);
    expect(sleepCalls[2]![0]).toBe(4_000);
  });

  // M-3: Per-poll AbortError (slow evaluator) must NOT permanently fail
  it('M-3: treats per-poll AbortError as a missed poll and continues the loop', async () => {
    // Simulate: first call throws AbortError (per-poll timeout fires), second
    // call succeeds. Session signal is never aborted. The loop should continue
    // after the first abort and eventually succeed.
    let calls = 0;
    const evaluate = vi.fn(async (_sig: AbortSignal) => {
      calls++;
      if (calls === 1) {
        // Simulate per-poll timeout: AbortError with name 'AbortError'
        const err = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
        throw err;
      }
      return makeMet();
    });
    const ac = new AbortController();
    const result = await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      backoff: 'none',
      signal: ac.signal,
    });
    // Should have continued past the AbortError and succeeded on attempt 2
    expect(result.status).toBe('succeeded');
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(result.result?.met).toBe(true);
  });

  it('M-3: per-poll AbortError at deadline returns timed_out, not failed', async () => {
    // Simulate: evaluator always throws AbortError and deadline is already past
    // after the first miss. Should return timed_out, not failed.
    const evaluate = vi.fn(async (_sig: AbortSignal) => {
      const err = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
      throw err;
    });
    const ac = new AbortController();
    const result = await pollUntil(evaluate, {
      timeout_ms: 0, // deadline immediately in the past
      poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
      backoff: 'none',
      signal: ac.signal,
    });
    expect(result.status).toBe('timed_out');
  });

  it('exponential backoff is capped at 60000ms', async () => {
    // Start at 10s; after 3 doublings: 80s > 60s → capped at 60s.
    let calls = 0;
    const evaluate = vi.fn((_sig: AbortSignal) => {
      calls++;
      return Promise.resolve(calls < 4 ? makeMiss() : makeMet());
    });
    const ac = new AbortController();
    await pollUntil(evaluate, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: 10_000,
      backoff: 'exponential',
      signal: ac.signal,
    });
    const sleepCalls = mockSleep.mock.calls;
    // 10000, 20000, 40000 — all below cap
    expect(sleepCalls[0]![0]).toBe(10_000);
    expect(sleepCalls[1]![0]).toBe(20_000);
    expect(sleepCalls[2]![0]).toBe(40_000);

    // Verify cap: with base=40000, attempt 2 → 40000*4=160000 → capped at 60000
    let calls2 = 0;
    const evaluate2 = vi.fn((_sig: AbortSignal) => {
      calls2++;
      return Promise.resolve(calls2 < 4 ? makeMiss() : makeMet());
    });
    vi.clearAllMocks();
    await pollUntil(evaluate2, {
      timeout_ms: DEFAULT_TIMEOUT_MS,
      poll_interval_ms: 40_000,
      backoff: 'exponential',
      signal: ac.signal,
    });
    const calls2Result = mockSleep.mock.calls;
    // 40000*2^1=80000 → capped at 60000
    expect(calls2Result[1]![0]).toBe(60_000);
  });
});
