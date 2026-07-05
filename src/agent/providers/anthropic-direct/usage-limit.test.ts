/**
 * Tests for `classifyUsageLimitError` and `waitForReset`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyUsageLimitError, parseRetryAfterMs, waitForReset, waitForHotSwap } from './usage-limit.js';

// ---------------------------------------------------------------------------
// classifyUsageLimitError
// ---------------------------------------------------------------------------

function makeError(status: number, message: string): Error {
  const e = new Error(message);
  (e as Error & { status: number }).status = status;
  return e;
}

function makeErrorWithHeaders(
  status: number,
  message: string,
  headers: Record<string, string> | Headers,
): Error {
  const e = new Error(message);
  const w = e as Error & { status: number; headers: unknown };
  w.status = status;
  w.headers = headers;
  return e;
}

describe('classifyUsageLimitError', () => {
  it('returns null for errors without a status field', () => {
    expect(classifyUsageLimitError(new Error('boom'))).toBeNull();
  });

  it('returns null for non-429/400 statuses', () => {
    expect(classifyUsageLimitError(makeError(500, 'Server error'))).toBeNull();
    expect(classifyUsageLimitError(makeError(401, 'Unauthorized'))).toBeNull();
  });

  it('returns oauth-limit with resetsAt for 429 + pipe-separated timestamp', () => {
    const unixTs = 1700000000;
    const err = makeError(429, `Claude AI usage limit reached|${unixTs}`);
    const result = classifyUsageLimitError(err);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('oauth-limit');
    if (result?.kind === 'oauth-limit') {
      expect(result.resetsAt.getTime()).toBe(unixTs * 1000);
    }
  });

  it('returns oauth-limit-no-ts for 429 without a valid timestamp', () => {
    const err = makeError(429, 'Claude AI usage limit reached');
    const result = classifyUsageLimitError(err);
    expect(result?.kind).toBe('oauth-limit-no-ts');
  });

  it('returns oauth-limit-no-ts for 429 with non-numeric pipe segment', () => {
    const err = makeError(429, 'Usage limit|notanumber');
    const result = classifyUsageLimitError(err);
    expect(result?.kind).toBe('oauth-limit-no-ts');
  });

  it('returns credit-exhausted for 400 + invalid_request_error + credit balance', () => {
    const err = makeError(400, 'invalid_request_error: credit balance is empty');
    const result = classifyUsageLimitError(err);
    expect(result?.kind).toBe('credit-exhausted');
  });

  it('returns null for 400 without both keywords', () => {
    expect(classifyUsageLimitError(makeError(400, 'invalid_request_error: something else'))).toBeNull();
    expect(classifyUsageLimitError(makeError(400, 'credit balance issue'))).toBeNull();
  });

  // A standard API-tier rate-limit 429 must NOT be treated as OAuth
  // subscription exhaustion (which would park the turn in a 2-hour poll).
  it('returns rate-limit-transient for a 429 with a retry-after header and no |ts', () => {
    const err = makeErrorWithHeaders(429, '429 rate_limit_error', { 'retry-after': '30' });
    const result = classifyUsageLimitError(err);
    expect(result?.kind).toBe('rate-limit-transient');
    if (result?.kind === 'rate-limit-transient') {
      expect(result.retryAfterMs).toBe(30_000);
    }
  });

  it('prefers oauth-limit (|ts) over the retry-after header', () => {
    const unixTs = 1700000000;
    const err = makeErrorWithHeaders(429, `usage limit|${unixTs}`, { 'retry-after': '30' });
    expect(classifyUsageLimitError(err)?.kind).toBe('oauth-limit');
  });

  it('still returns oauth-limit-no-ts for a 429 with no timestamp and no retry-after header', () => {
    expect(classifyUsageLimitError(makeError(429, 'Claude AI usage limit reached'))?.kind).toBe(
      'oauth-limit-no-ts',
    );
  });

  it('reads retry-after from a web Headers object', () => {
    const err = makeErrorWithHeaders(429, '429', new Headers({ 'retry-after': '5' }));
    const result = classifyUsageLimitError(err);
    expect(result?.kind).toBe('rate-limit-transient');
    if (result?.kind === 'rate-limit-transient') {
      expect(result.retryAfterMs).toBe(5_000);
    }
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfterMs
// ---------------------------------------------------------------------------

describe('parseRetryAfterMs', () => {
  it('returns undefined for non-objects and missing/empty headers', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('nope')).toBeUndefined();
    expect(parseRetryAfterMs({})).toBeUndefined();
    expect(parseRetryAfterMs({ headers: {} })).toBeUndefined();
  });

  it('prefers retry-after-ms (milliseconds)', () => {
    expect(parseRetryAfterMs({ headers: { 'retry-after-ms': '1500' } })).toBe(1500);
  });

  it('parses retry-after seconds into milliseconds', () => {
    expect(parseRetryAfterMs({ headers: { 'retry-after': '2' } })).toBe(2000);
  });

  it('reads from a web Headers object via .get', () => {
    expect(parseRetryAfterMs({ headers: new Headers({ 'retry-after': '3' }) })).toBe(3000);
  });

  it('parses an HTTP-date retry-after into a forward delta', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfterMs({ headers: { 'retry-after': future } });
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it('ignores a past HTTP-date', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfterMs({ headers: { 'retry-after': past } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// waitForReset
// ---------------------------------------------------------------------------

describe('waitForReset', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves timer when deadline passes', async () => {
    const resetsAt = new Date(Date.now() + 5_000); // 5s from "now"
    const controller = new AbortController();
    const readToken = vi.fn(() => 'same-token');

    const promise = waitForReset({ resetsAt, signal: controller.signal, readToken });
    // Advance past deadline (resetsAt + 30s buffer) and flush microtask queue
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('timer');
  });

  it('resolves aborted when signal fires before deadline', async () => {
    const resetsAt = new Date(Date.now() + 60_000);
    const controller = new AbortController();
    const readToken = vi.fn(() => 'same-token');

    const promise = waitForReset({ resetsAt, signal: controller.signal, readToken });
    controller.abort();
    const result = await promise;
    expect(result).toBe('aborted');
  });

  it('resolves hot-swap when token changes during polling', async () => {
    const resetsAt = new Date(Date.now() + 60_000);
    const controller = new AbortController();
    let token = 'original-token';
    const readToken = vi.fn(() => token);

    const promise = waitForReset({ resetsAt, signal: controller.signal, readToken });
    // Advance one poll cycle, then change the token, then advance another cycle
    await vi.advanceTimersByTimeAsync(30_000);
    token = 'new-token-hot-swap';
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;
    expect(result).toBe('hot-swap');
  });

  it('resolves aborted immediately when signal is pre-aborted', async () => {
    const resetsAt = new Date(Date.now() + 60_000);
    const controller = new AbortController();
    controller.abort();
    const readToken = vi.fn(() => 'token');

    const result = await waitForReset({ resetsAt, signal: controller.signal, readToken });
    expect(result).toBe('aborted');
  });

  it('resolves timer immediately when deadline has already passed', async () => {
    const resetsAt = new Date(Date.now() - 60_000); // 1 minute in the past
    const controller = new AbortController();
    const readToken = vi.fn(() => 'token');

    const result = await waitForReset({ resetsAt, signal: controller.signal, readToken });
    expect(result).toBe('timer');
  });

  it('uses loadClaudeCodeOauthToken as default readToken (deadline already past)', async () => {
    // Deadline is already past — the initial synchronous check fires immediately.
    // No need to advance timers.
    vi.useRealTimers(); // avoid interference with fake timers for synchronous path
    const resetsAt = new Date(Date.now() - 60_000); // 1 minute in the past
    const controller = new AbortController();
    const result = await waitForReset({ resetsAt, signal: controller.signal });
    expect(result).toBe('timer');
  });

  // -------------------------------------------------------------------------
  // R5 — setInterval handle must have .unref() called
  // -------------------------------------------------------------------------

  /**
   * R5 — `waitForReset` setInterval not `.unref()`-ed.
   *
   * During a 429 retry, an unref-d 30s timer can hold the Node process open
   * for 30s after a SIGTERM that fires in a narrow race window. In CI with
   * tight grace periods, this looks like a hang.
   *
   * Strategy: spy on `setInterval` to intercept the returned handle, capture
   * it, and assert that `.unref()` was called on it before the promise settles.
   *
   * Before the fix, the `setInterval` handle has no `.unref()` call, so the
   * spy's `unref` mock will never fire.
   */
  it('(R5-1) calls .unref() on the setInterval handle', async () => {
    // Future deadline so the interval IS created (the synchronous path would
    // resolve immediately and skip setInterval entirely).
    const resetsAt = new Date(Date.now() + 60_000);
    const controller = new AbortController();
    const readToken = vi.fn(() => 'stable-token');

    let capturedHandle: ReturnType<typeof setInterval> | undefined;
    const unrefSpy = vi.fn();

    // Intercept setInterval to capture the handle and inject an .unref() spy
    const originalSetInterval = global.setInterval;
    vi.spyOn(global, 'setInterval').mockImplementation((...args: Parameters<typeof setInterval>) => {
      // Call through to the real (fake-timer-backed) implementation
      const handle = originalSetInterval(...args);
      // Decorate the handle with a spy so we can assert it was called
      (handle as unknown as { unref: () => void }).unref = unrefSpy;
      capturedHandle = handle;
      return handle;
    });

    const promise = waitForReset({ resetsAt, signal: controller.signal, readToken });

    // Abort immediately so we don't have to advance 60 seconds of timers
    controller.abort();
    await promise;

    expect(capturedHandle).toBeDefined();
    // Before the fix: unrefSpy.mock.calls.length === 0 → test fails
    expect(unrefSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// waitForHotSwap
// ---------------------------------------------------------------------------

describe('waitForHotSwap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves hot-swap when token changes during polling', async () => {
    const controller = new AbortController();
    let token = 'original-token';
    const readToken = vi.fn(() => token);

    const promise = waitForHotSwap({ signal: controller.signal, readToken });
    // Advance one poll cycle, then change the token, then advance another cycle
    await vi.advanceTimersByTimeAsync(30_000);
    token = 'new-token-hot-swap';
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;
    expect(result).toBe('hot-swap');
  });

  it('resolves aborted when signal fires before hot-swap', async () => {
    const controller = new AbortController();
    const readToken = vi.fn(() => 'same-token');

    const promise = waitForHotSwap({ signal: controller.signal, readToken });
    controller.abort();
    const result = await promise;
    expect(result).toBe('aborted');
  });

  it('resolves aborted immediately when signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const readToken = vi.fn(() => 'token');

    const result = await waitForHotSwap({ signal: controller.signal, readToken });
    expect(result).toBe('aborted');
  });

  it('resolves hot-swap immediately when token already changed', async () => {
    const controller = new AbortController();
    const readToken = vi.fn()
      .mockReturnValueOnce('original-token')  // initial snapshot
      .mockReturnValueOnce('new-token');       // first check — already different

    const result = await waitForHotSwap({ signal: controller.signal, readToken });
    expect(result).toBe('hot-swap');
  });

  it('does NOT resolve via timer (no deadline — only hot-swap or abort)', async () => {
    const controller = new AbortController();
    const readToken = vi.fn(() => 'same-token');

    const promise = waitForHotSwap({ signal: controller.signal, readToken });
    // Advance well past any plausible timer — still no resolve.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1_000); // 3 hours
    // Promise is still pending — abort to resolve it.
    controller.abort();
    const result = await promise;
    expect(result).toBe('aborted');
  });

  // -------------------------------------------------------------------------
  // retryAfterMs — opt-in timer exit for the no-ts poll-retry loop
  // -------------------------------------------------------------------------

  it('resolves timer when retryAfterMs elapses (no hot-swap, no abort)', async () => {
    const controller = new AbortController();
    const readToken = vi.fn(() => 'same-token');

    const promise = waitForHotSwap({ signal: controller.signal, readToken, retryAfterMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;
    expect(result).toBe('timer');
  });

  it('removes the abort listener when retryAfterMs elapses', async () => {
    const controller = new AbortController();
    const readToken = vi.fn(() => 'same-token');
    const addEventListenerSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

    for (let i = 0; i < 11; i += 1) {
      const promise = waitForHotSwap({ signal: controller.signal, readToken, retryAfterMs: 60_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(promise).resolves.toBe('timer');
    }

    expect(addEventListenerSpy).toHaveBeenCalledTimes(11);
    expect(removeEventListenerSpy).toHaveBeenCalledTimes(11);
    for (const [eventName, listener] of addEventListenerSpy.mock.calls) {
      expect(removeEventListenerSpy).toHaveBeenCalledWith(eventName, listener);
    }
  });

  it('does NOT resolve timer before retryAfterMs elapses', async () => {
    const controller = new AbortController();
    const readToken = vi.fn(() => 'same-token');

    const promise = waitForHotSwap({ signal: controller.signal, readToken, retryAfterMs: 60_000 });
    // Advance only halfway — still no resolve.
    await vi.advanceTimersByTimeAsync(30_000);
    controller.abort();
    const result = await promise;
    // Abort (fired before the 60s deadline) wins, proving the timer had not fired.
    expect(result).toBe('aborted');
  });

  it('prefers hot-swap over timer when token changes before retryAfterMs', async () => {
    const controller = new AbortController();
    let token = 'original-token';
    const readToken = vi.fn(() => token);

    const promise = waitForHotSwap({ signal: controller.signal, readToken, retryAfterMs: 120_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    token = 'new-token-hot-swap';
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;
    expect(result).toBe('hot-swap');
  });

  it('prefers hot-swap over timer when token changes in the deadline poll window', async () => {
    const controller = new AbortController();
    let token = 'original-token';
    const readToken = vi.fn(() => token);

    const promise = waitForHotSwap({ signal: controller.signal, readToken, retryAfterMs: 60_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    token = 'new-token-hot-swap';
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await promise;
    expect(result).toBe('hot-swap');
  });

  it('retryAfterMs path still resolves aborted when signal fires first', async () => {
    const controller = new AbortController();
    const readToken = vi.fn(() => 'same-token');

    const promise = waitForHotSwap({ signal: controller.signal, readToken, retryAfterMs: 60_000 });
    controller.abort();
    const result = await promise;
    expect(result).toBe('aborted');
  });
});
