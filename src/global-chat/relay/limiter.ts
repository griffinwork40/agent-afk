// Contract:
// Rate-limit counters live in memory only. Per the brief, losing them after
// a Durable Object hibernation is acceptable -- the effect is a brief quota
// reset. Anything that must survive hibernation (bans, name registry, messages)
// goes through RelayStore instead.
//
// Three independent limiters:
//   TokenBucket  -- per-key post rate (1/3s, burst 5)
//   SlidingWindow -- per-ip-hash post rate (60/min)
//   SlidingWindow -- per-key hourly new-key quota (20/hr for keys < 24h old)

export interface Clock { now(): number }
export const realClock: Clock = { now: () => Date.now() };

// ---------------------------------------------------------------------------
// TokenBucket: 1 token per intervalMs, max burst capacity
// ---------------------------------------------------------------------------
interface Bucket { tokens: number; lastRefill: number }

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly intervalMs: number,
    private readonly burst: number,
    private readonly clock: Clock,
  ) {}

  /** Returns true if the request is allowed (consumes one token). */
  allow(key: string): boolean {
    const now = this.clock.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, lastRefill: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor(elapsed / this.intervalMs);
    if (refill > 0) {
      bucket.tokens = Math.min(this.burst, bucket.tokens + refill);
      bucket.lastRefill += refill * this.intervalMs;
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens--;
    return true;
  }

  /** Ms until the next token is available (0 if currently allowed). */
  retryAfterMs(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.tokens > 0) return 0;
    return this.intervalMs - (this.clock.now() - bucket.lastRefill);
  }
}

// ---------------------------------------------------------------------------
// SlidingWindow: at most `limit` events in the last `windowMs`
// ---------------------------------------------------------------------------
export class SlidingWindowLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly limit: number,
    private readonly clock: Clock,
  ) {}

  allow(key: string): boolean {
    const now = this.clock.now();
    const cutoff = now - this.windowMs;
    let times = this.windows.get(key);
    if (!times) { times = []; this.windows.set(key, times); }
    // Prune expired entries
    let start = 0;
    while (start < times.length && (times[start] ?? 0) <= cutoff) start++;
    if (start > 0) times.splice(0, start);
    if (times.length >= this.limit) return false;
    times.push(now);
    return true;
  }

  retryAfterMs(key: string): number {
    const now = this.clock.now();
    const times = this.windows.get(key);
    if (!times || times.length < this.limit) return 0;
    const oldest = times[0] ?? now;
    return Math.max(0, oldest + this.windowMs - now);
  }
}
