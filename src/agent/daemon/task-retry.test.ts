/**
 * Unit tests for the cron-task retry loop and its field validation (#3243).
 *
 * @module agent/daemon/task-retry.test
 */

import { describe, it, expect } from 'vitest';
import {
  parseTaskRetryFields,
  resolveTaskRetryPolicy,
  runWithTaskRetry,
  TASK_MAX_ATTEMPTS_LIMIT,
  TASK_RETRY_DELAY_MAX_MS,
  DEFAULT_TASK_RETRY_DELAY_MS,
} from './task-retry.js';

function httpError(status: number, headers?: Record<string, string>): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status, ...(headers ? { headers } : {}) });
}

const noSleep = async (): Promise<void> => {};

describe('parseTaskRetryFields', () => {
  it('omits absent and null fields', () => {
    expect(parseTaskRetryFields({})).toEqual({ ok: true, value: {} });
    expect(parseTaskRetryFields({ maxAttempts: null, retryDelayMs: null })).toEqual({ ok: true, value: {} });
  });

  it('accepts in-bounds integers', () => {
    expect(parseTaskRetryFields({ maxAttempts: 3, retryDelayMs: 5_000 })).toEqual({
      ok: true,
      value: { maxAttempts: 3, retryDelayMs: 5_000 },
    });
  });

  it.each([0, -1, 1.5, TASK_MAX_ATTEMPTS_LIMIT + 1, '2', true])('rejects maxAttempts=%p', (v) => {
    const r = parseTaskRetryFields({ maxAttempts: v });
    expect(r.ok).toBe(false);
  });

  it.each([999, TASK_RETRY_DELAY_MAX_MS + 1, 1500.5, '2000'])('rejects retryDelayMs=%p', (v) => {
    const r = parseTaskRetryFields({ retryDelayMs: v });
    expect(r.ok).toBe(false);
  });
});

describe('resolveTaskRetryPolicy', () => {
  it('defaults to a single attempt', () => {
    expect(resolveTaskRetryPolicy({})).toEqual({ maxAttempts: 1, retryDelayMs: DEFAULT_TASK_RETRY_DELAY_MS });
  });

  it('clamps hand-edited oversized values', () => {
    expect(resolveTaskRetryPolicy({ maxAttempts: 99, retryDelayMs: 10 ** 9 })).toEqual({
      maxAttempts: TASK_MAX_ATTEMPTS_LIMIT,
      retryDelayMs: TASK_RETRY_DELAY_MAX_MS,
    });
  });

  it('treats garbage maxAttempts as 1', () => {
    expect(resolveTaskRetryPolicy({ maxAttempts: 0 }).maxAttempts).toBe(1);
    expect(resolveTaskRetryPolicy({ maxAttempts: 2.5 }).maxAttempts).toBe(1);
  });
});

describe('runWithTaskRetry', () => {
  const signal = new AbortController().signal;

  it('maxAttempts=1 never retries, even on a transient error', async () => {
    let calls = 0;
    const out = await runWithTaskRetry(async () => { calls++; throw httpError(503); }, {
      maxAttempts: 1, retryDelayMs: 1, signal, sleep: noSleep,
    });
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, attempts: 1 });
  });

  it('transient failure then success with maxAttempts=2 → success after 2 attempts', async () => {
    let calls = 0;
    const delays: number[] = [];
    const out = await runWithTaskRetry(async (n) => {
      calls++;
      if (n === 1) throw httpError(429);
      return 'ok';
    }, { maxAttempts: 2, retryDelayMs: 7, signal, sleep: async (ms) => { delays.push(ms); } });
    expect(calls).toBe(2);
    expect(out).toEqual({ ok: true, value: 'ok', attempts: 2 });
    expect(delays).toEqual([7]);
  });

  it('retries a network blip (ECONNRESET in the cause chain)', async () => {
    let calls = 0;
    const blip = Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } });
    const out = await runWithTaskRetry(async () => {
      calls++;
      if (calls === 1) throw blip;
      return 1;
    }, { maxAttempts: 3, retryDelayMs: 1, signal, sleep: noSleep });
    expect(out).toMatchObject({ ok: true, attempts: 2 });
  });

  it('non-transient failures never retry', async () => {
    for (const err of [httpError(400), httpError(401), new Error('model refused')]) {
      let calls = 0;
      const out = await runWithTaskRetry(async () => { calls++; throw err; }, {
        maxAttempts: 5, retryDelayMs: 1, signal, sleep: noSleep,
      });
      expect(calls).toBe(1);
      expect(out).toMatchObject({ ok: false, attempts: 1, error: err });
    }
  });

  it('backs off exponentially and stops at maxAttempts', async () => {
    const delays: number[] = [];
    const out = await runWithTaskRetry(async () => { throw httpError(502); }, {
      maxAttempts: 3, retryDelayMs: 10, signal, sleep: async (ms) => { delays.push(ms); },
    });
    expect(delays).toEqual([10, 20]);
    expect(out).toMatchObject({ ok: false, attempts: 3 });
  });

  it('gives up when retry-after exceeds the delay ceiling', async () => {
    let calls = 0;
    const err = httpError(429, { 'retry-after': String(TASK_RETRY_DELAY_MAX_MS / 1000 + 60) });
    const out = await runWithTaskRetry(async () => { calls++; throw err; }, {
      maxAttempts: 3, retryDelayMs: 1, signal, sleep: noSleep,
    });
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, attempts: 1 });
  });

  it('gives up when retry-after is exactly at the delay ceiling', async () => {
    let calls = 0;
    const err = httpError(429, { 'retry-after': String(TASK_RETRY_DELAY_MAX_MS / 1000) });
    const out = await runWithTaskRetry(async () => { calls++; throw err; }, {
      maxAttempts: 3, retryDelayMs: 1, signal, sleep: noSleep,
    });
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, attempts: 1 });
  });

  it('abort during backoff stops promptly with no further attempt', async () => {
    const ac = new AbortController();
    let calls = 0;
    const started = Date.now();
    const pending = runWithTaskRetry(async () => { calls++; throw httpError(503); }, {
      maxAttempts: 3, retryDelayMs: 60_000, signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 10);
    const out = await pending;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, attempts: 1 });
  });

  it('onRetry fires before each backoff sleep', async () => {
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const out = await runWithTaskRetry(async (n) => {
      if (n <= 2) throw httpError(503);
      return 'ok';
    }, {
      maxAttempts: 3, retryDelayMs: 10, signal, sleep: noSleep,
      onRetry: ({ attempt, delayMs }) => { retries.push({ attempt, delayMs }); },
    });
    expect(out).toMatchObject({ ok: true, attempts: 3 });
    expect(retries).toEqual([
      { attempt: 1, delayMs: 10 },
      { attempt: 2, delayMs: 20 },
    ]);
  });

  it('isCancelled stops further attempts', async () => {
    let calls = 0;
    const out = await runWithTaskRetry(async () => { calls++; throw httpError(503); }, {
      maxAttempts: 3, retryDelayMs: 1, signal, sleep: noSleep, isCancelled: () => true,
    });
    expect(calls).toBe(1);
    expect(out.ok).toBe(false);
  });
});
