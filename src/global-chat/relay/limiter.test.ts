import { describe, it, expect } from 'vitest';
import { TokenBucketLimiter, SlidingWindowLimiter, LIMITER_SWEEP_BUDGET } from './limiter.js';

describe('bounded limiter eviction', () => {
  it.each(['bucket', 'window'])('evicts idle %s entries with bounded fair work', kind => {
    let now = 1000;
    const limiter = kind === 'bucket' ? new TokenBucketLimiter(100, 5, { now: () => now }) :
      new SlidingWindowLimiter(500, 5, { now: () => now });
    for (let i = 0; i < 100; i++) expect(limiter.allow(String(i))).toBe(true);
    expect(limiter.entryCount).toBe(100);
    now += 1000;
    limiter.allow('active');
    expect(limiter.entryCount).toBe(101 - LIMITER_SWEEP_BUDGET);
    for (let i = 0; i < 10; i++) limiter.allow('active');
    expect(limiter.entryCount).toBe(1);
  });

  it('does not reset a partially replenished bucket or unexpired window', () => {
    let now = 1000;
    const bucket = new TokenBucketLimiter(100, 5, { now: () => now });
    const window = new SlidingWindowLimiter(500, 5, { now: () => now });
    for (let i = 0; i < 5; i++) { expect(bucket.allow('a')).toBe(true); expect(window.allow('a')).toBe(true); }
    now += 99;
    expect(bucket.allow('a')).toBe(false); expect(window.allow('a')).toBe(false);
    now++;
    expect(bucket.allow('a')).toBe(true); expect(bucket.allow('a')).toBe(false);
    expect(window.allow('a')).toBe(false);
    expect(bucket.retryAfterMs('a')).toBe(100);
    expect(window.retryAfterMs('a')).toBe(400);
  });
});
