/**
 * Yield-contract tests for wait_for: the poller's `shouldYield` probe and the
 * handler's `yielded_to_user` result. Sleep is mocked to resolve instantly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../providers/shared/sleep-with-abort.js', () => ({
  sleepWithAbort: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./wait-for-conditions.js', () => ({
  evaluateUrl: vi.fn(),
  evaluateFile: vi.fn(),
  evaluateProcess: vi.fn(),
  evaluateCommand: vi.fn().mockReturnValue({ met: false, detail: 'command exited 1' }),
}));

import { pollUntil, YIELD_CHECK_SLICE_MS } from './wait-for-poller.js';
import { waitForHandler } from './wait-for.js';
import { evaluateCommand } from './wait-for-conditions.js';
import { sleepWithAbort } from '../../providers/shared/sleep-with-abort.js';
import type { WaitResult } from './wait-for-conditions.js';

const mockSleep = vi.mocked(sleepWithAbort);
const miss = (): Promise<WaitResult> => Promise.resolve({ met: false, detail: 'not yet' });
const met = (): Promise<WaitResult> => Promise.resolve({ met: true, detail: 'up' });
const base = { timeout_ms: 600_000, poll_interval_ms: 5_000, backoff: 'none' as const };

/** A probe that reports `false` for the first `n` reads, then `true`. */
function flipAfter(n: number): { fn: () => boolean; reads: () => number } {
  let reads = 0;
  return { fn: () => ++reads > n, reads: () => reads };
}

describe('pollUntil shouldYield', () => {
  beforeEach(() => vi.clearAllMocks());

  it('yields after the first evaluation when a message is already queued', async () => {
    const evaluate = vi.fn(miss);
    const r = await pollUntil(evaluate, { ...base, signal: new AbortController().signal, shouldYield: () => true });
    expect(r.status).toBe('yielded_to_user');
    expect(r.attempts).toBe(1);
    expect(r.result?.detail).toBe('not yet');
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it('reports success, not a yield, when the condition is met', async () => {
    const r = await pollUntil(vi.fn(met), { ...base, signal: new AbortController().signal, shouldYield: () => true });
    expect(r.status).toBe('succeeded');
  });

  it('sleeps in slices and yields mid-sleep, re-evaluating once first', async () => {
    const probe = flipAfter(2);
    const evaluate = vi.fn(miss);
    const r = await pollUntil(evaluate, { ...base, signal: new AbortController().signal, shouldYield: probe.fn });
    expect(r.status).toBe('yielded_to_user');
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(r.attempts).toBe(2);
    for (const [ms] of mockSleep.mock.calls) expect(ms).toBeLessThanOrEqual(YIELD_CHECK_SLICE_MS);
  });

  it('keeps the original single-sleep path when no probe is armed', async () => {
    let calls = 0;
    const evaluate = vi.fn(() => (++calls < 3 ? miss() : met()));
    const r = await pollUntil(evaluate, { ...base, signal: new AbortController().signal });
    expect(r.status).toBe('succeeded');
    expect(mockSleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 5_000]);
  });
});

describe('waitForHandler yield', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a non-error "end your turn" result when the user has a queued message', async () => {
    const res = await waitForHandler(
      { type: 'command', command: 'false' },
      new AbortController().signal,
      { userAttention: { hasPendingUserMessage: () => true } },
    );
    expect(res.isError).toBe(false);
    expect(res.content).toContain('Wait yielded_to_user');
    expect(res.content).toContain('command exited 1');
    expect(res.content).toContain('End your turn now');
    expect(res.content).toContain('Call wait_for again afterward');
  });

  it('ignores the probe when no userAttention is attached (subagents, bash-like callers)', async () => {
    vi.mocked(evaluateCommand).mockReturnValueOnce({ met: true, detail: 'command exited 0' });
    const res = await waitForHandler({ type: 'command', command: 'true' }, new AbortController().signal, {});
    expect(res.content).toContain('Wait succeeded');
  });
});
