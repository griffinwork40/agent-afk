import { describe, expect, it } from 'vitest';
import { isRetryableAnalystError, withAnalystRetry } from './complete.retry.js';

describe('withAnalystRetry', () => {
  it('retries 429s then succeeds', async () => {
    let n = 0;
    const out = await withAnalystRetry(async () => {
      n++;
      if (n < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
      return 'ok';
    }, { baseDelayMs: 1, maxDelayMs: 2 });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let n = 0;
    await expect(withAnalystRetry(async () => {
      n++;
      throw Object.assign(new Error('bad request'), { status: 400 });
    }, { baseDelayMs: 1 })).rejects.toThrow('bad request');
    expect(n).toBe(1);
  });

  it('gives up after the attempt budget', async () => {
    let n = 0;
    await expect(withAnalystRetry(async () => {
      n++;
      throw Object.assign(new Error('overloaded'), { status: 529 });
    }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow('overloaded');
    expect(n).toBe(3);
  });

  it('classifies errors', () => {
    expect(isRetryableAnalystError({ status: 503 })).toBe(true);
    expect(isRetryableAnalystError({ status: 401 })).toBe(false);
    expect(isRetryableAnalystError(new Error('Connection error.'))).toBe(true);
    expect(isRetryableAnalystError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
  });
});
