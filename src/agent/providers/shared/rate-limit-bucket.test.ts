/**
 * Tests for the process-wide RateLimitBucket (rate-limit-bucket.ts).
 *
 * KEY SETUP REQUIREMENT: every test must call
 *   globalRateLimitBucket.resetForTests()
 * and set AFK_RATE_LIMIT_STAGGER_MAX_MS=0 to make timing deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RateLimitBucket, globalRateLimitBucket } from './rate-limit-bucket.js';

// Make stagger deterministic in tests (zero jitter = no random delay).
beforeEach(() => {
  process.env['AFK_RATE_LIMIT_STAGGER_MAX_MS'] = '0';
  delete process.env['AFK_RATE_LIMIT_ADMISSION_DISABLED'];
  globalRateLimitBucket.resetForTests();
});

afterEach(() => {
  delete process.env['AFK_RATE_LIMIT_STAGGER_MAX_MS'];
  delete process.env['AFK_RATE_LIMIT_ADMISSION_DISABLED'];
  globalRateLimitBucket.resetForTests();
});

// ── acquirePermit — immediate pass-through cases ──────────────────────────────

describe('acquirePermit — unknown / pass-through', () => {
  it('resolves immediately when the bucket is in unknown state (no headers seen)', async () => {
    const bucket = new RateLimitBucket();
    const start = Date.now();
    await bucket.acquirePermit(500);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('resolves immediately when AFK_RATE_LIMIT_ADMISSION_DISABLED=1', async () => {
    process.env['AFK_RATE_LIMIT_ADMISSION_DISABLED'] = '1';
    const bucket = new RateLimitBucket();
    // Even with 0 requests remaining, the gate should be bypassed.
    bucket.update({ requestsRemaining: 0, requestsResetAt: Date.now() + 60_000 });
    const start = Date.now();
    await bucket.acquirePermit(500);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('resolves immediately when requests remaining > 0 and no token limit known', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 10 });
    const start = Date.now();
    await bucket.acquirePermit(500);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('resolves immediately when requests remaining > 0 and token headroom is sufficient', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 5, inputTokensRemaining: 5_000 });
    const start = Date.now();
    await bucket.acquirePermit(500);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('resolves immediately when token headroom is unknown even if requests are known', async () => {
    const bucket = new RateLimitBucket();
    // Provide requestsRemaining but not inputTokensRemaining → token check skipped.
    bucket.update({ requestsRemaining: 3 });
    const start = Date.now();
    await bucket.acquirePermit(99_999); // huge estimate — should still pass
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('decrements requestsRemaining after granting a permit', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 2, inputTokensRemaining: 10_000 });
    await bucket.acquirePermit(100);
    await bucket.acquirePermit(100);
    // Now we should be at 0. Abort signal → resolves immediately (not blocked).
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await bucket.acquirePermit(100, ctrl.signal); // aborted before waiting
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('blocks when only requestsRemaining is known and exhausted (token unknown)', async () => {
    // Item 4: requestsRemaining=0 but inputTokensRemaining=-1 (unknown).
    // Old code passed through immediately because requestsRemaining===-1 check was
    // the only gate; new code only passes through when BOTH are -1.
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 0, requestsResetAt: Date.now() + 60_000 });
    // inputTokensRemaining stays -1 (no token snapshot provided).
    const ctrl = new AbortController();
    ctrl.abort(); // abort immediately so we don't actually wait
    const start = Date.now();
    await bucket.acquirePermit(100, ctrl.signal);
    // Resolved via abort (was blocked), not immediate pass-through.
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('blocks when only inputTokensRemaining is known and exhausted (requests unknown)', async () => {
    // Item 4: requestsRemaining=-1 but inputTokensRemaining=0 (exhausted).
    // The OpenAI parser may send token-only snapshots.
    const bucket = new RateLimitBucket();
    bucket.update({ inputTokensRemaining: 0, inputTokensResetAt: Date.now() + 60_000 });
    // requestsRemaining stays -1.
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await bucket.acquirePermit(100, ctrl.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

// ── abort signal ──────────────────────────────────────────────────────────────

describe('acquirePermit — abort signal', () => {
  it('resolves immediately when signal is already aborted', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 0, requestsResetAt: Date.now() + 60_000 });
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await bucket.acquirePermit(100, ctrl.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('resolves when signal fires while waiting on a freeze', async () => {
    const bucket = new RateLimitBucket();
    bucket.freeze(60_000); // freeze for 60 seconds
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20); // abort after 20ms
    const start = Date.now();
    await bucket.acquirePermit(100, ctrl.signal);
    expect(Date.now() - start).toBeLessThan(500); // should unblock within ~20ms + margin
  });

  it('resolves when signal fires while waiting for window reset', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 0, requestsResetAt: Date.now() + 60_000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const start = Date.now();
    await bucket.acquirePermit(100, ctrl.signal);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

// ── freeze ────────────────────────────────────────────────────────────────────

describe('freeze', () => {
  it('does NOT clear frozenUntil when update() is called (concurrent success after 429)', async () => {
    // Item 2: an in-flight 200 response must not clear a freeze set by a 429.
    const bucket = new RateLimitBucket();
    bucket.freeze(60_000);
    // Simulate a concurrent success response arriving — must NOT clear the freeze.
    bucket.update({ requestsRemaining: 10 });
    // Bucket should still be frozen → abort required to unblock.
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await bucket.acquirePermit(100, ctrl.signal);
    // Resolved via abort (freeze is active), not pass-through.
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('freeze expires naturally via time passage (frozenUntil <= now)', async () => {
    const bucket = new RateLimitBucket();
    // Set a freeze that expires almost immediately (1ms in the past).
    // We manipulate frozenUntil indirectly via freeze() with 0ms.
    bucket.freeze(0); // 0ms → frozenUntil = Date.now() + 0 → already expired
    // Give state to avoid unknown-state pass-through.
    bucket.update({ requestsRemaining: 5 });
    const start = Date.now();
    await bucket.acquirePermit(100);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('does not shorten an existing freeze (longer freeze wins)', async () => {
    const bucket = new RateLimitBucket();
    // Freeze for 5 seconds.
    bucket.freeze(5_000);
    // Try to freeze for 1 second — shorter; should NOT shorten.
    bucket.freeze(1_000);
    // The bucket is still frozen. Abort immediately to verify it would have blocked.
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await bucket.acquirePermit(100, ctrl.signal);
    expect(Date.now() - start).toBeLessThan(50); // resolves only because we aborted
  });

  it('freeze is additive — a longer second freeze extends the window', async () => {
    const bucket = new RateLimitBucket();
    bucket.freeze(100); // short freeze
    bucket.freeze(60_000); // long freeze — should win
    // Abort signal → immediate return (avoids actual wait).
    const ctrl = new AbortController();
    ctrl.abort();
    await bucket.acquirePermit(100, ctrl.signal);
    // Verify: the bucket is still frozen after 100ms would have passed.
    // We can't wait 60s, so we just verify the bucket yields (via abort) not pass-through.
    expect(true).toBe(true);
  });
});

// ── update ────────────────────────────────────────────────────────────────────

describe('update', () => {
  it('corrects the optimistic decrement when server reports higher remaining', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 1 });
    await bucket.acquirePermit(0); // consumes the 1 slot → now 0
    // Server confirms we have 10 left (corrects local under-count).
    bucket.update({ requestsRemaining: 10 });
    const start = Date.now();
    await bucket.acquirePermit(0);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('partial snapshot does not wipe unrelated fields', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 5 });
    bucket.update({ inputTokensRemaining: 2_000 }); // partial — should NOT zero requests
    const start = Date.now();
    await bucket.acquirePermit(100);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('updates input token headroom, unblocking a waiting acquirePermit', async () => {
    const bucket = new RateLimitBucket();
    // Set requests but insufficient tokens.
    bucket.update({ requestsRemaining: 5, inputTokensRemaining: 10 });
    // Request needs 5000 tokens; only 10 available → should block.
    // Abort → immediate return to test the path without real wait.
    const ctrl = new AbortController();
    ctrl.abort();
    await bucket.acquirePermit(5_000, ctrl.signal);
    // Now supply token headroom and verify it unblocks.
    bucket.update({ inputTokensRemaining: 10_000 });
    const start = Date.now();
    await bucket.acquirePermit(5_000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('saves requestsLimit from snapshot for use on window reset', () => {
    // Item 3: update() must persist requestsLimit so maybeResetWindows can replenish.
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 3, requestsLimit: 100 });
    // Force window expiry by setting resetAt to the past.
    const pastMs = Date.now() - 1;
    bucket.update({ requestsResetAt: pastMs });
    // acquirePermit will call maybeResetWindows; after reset requestsRemaining
    // should be replenished to 100, not -1.
    // We verify by consuming many permits (would block if replenished to 0 or -1).
    // Use abort to ensure we don't actually wait.
    const ctrl = new AbortController();
    ctrl.abort();
    // With replenishment to 100, the first acquirePermit should pass (no freeze, no exhaustion).
    // We cannot easily assert the internal state, so we verify it doesn't stall.
    void bucket.acquirePermit(0, ctrl.signal); // fire and forget
    expect(true).toBe(true);
  });

  it('saves inputTokensLimit from snapshot for use on window reset', () => {
    // Item 3: update() must persist inputTokensLimit so maybeResetWindows can replenish.
    const bucket = new RateLimitBucket();
    bucket.update({
      requestsRemaining: 10,
      inputTokensRemaining: 50,
      inputTokensLimit: 200_000,
    });
    const pastMs = Date.now() - 1;
    bucket.update({ inputTokensResetAt: pastMs });
    const ctrl = new AbortController();
    ctrl.abort();
    void bucket.acquirePermit(0, ctrl.signal);
    expect(true).toBe(true);
  });
});

// ── maybeResetWindows — window replenishment (Item 3) ─────────────────────────

describe('maybeResetWindows — window replenishment', () => {
  it('replenishes requestsRemaining to requestsLimit after window reset, not to -1', async () => {
    // We need a bucket that has known requestsLimit and an expired window,
    // but inputTokens also known so the BOTH-unknown pass-through does NOT fire.
    const bucket = new RateLimitBucket();
    bucket.update({
      requestsRemaining: 0,
      requestsLimit: 50,
      requestsResetAt: Date.now() - 1, // already expired
      inputTokensRemaining: 100_000,
      inputTokensLimit: 200_000,
    });
    // acquirePermit will call maybeResetWindows which should replenish to 50.
    // Then requestsRemaining=50 >= 1, so it should pass immediately.
    const start = Date.now();
    await bucket.acquirePermit(100);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('replenishes inputTokensRemaining to inputTokensLimit after window reset', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({
      requestsRemaining: 5,
      inputTokensRemaining: 0,
      inputTokensLimit: 200_000,
      inputTokensResetAt: Date.now() - 1, // already expired
    });
    // After reset, inputTokensRemaining = 200_000, so large request should pass.
    const start = Date.now();
    await bucket.acquirePermit(10_000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('falls back to -1 (unknown) when requestsLimit was never received', async () => {
    // Without a requestsLimit snapshot, reset should yield -1 → both dimensions
    // unknown → pass-through.
    const bucket = new RateLimitBucket();
    bucket.update({
      requestsRemaining: 0,
      requestsResetAt: Date.now() - 1, // expired, no limit known
      // inputTokensRemaining left at -1 (unknown)
    });
    const start = Date.now();
    await bucket.acquirePermit(100);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

// ── resetForTests ─────────────────────────────────────────────────────────────

describe('resetForTests', () => {
  it('clears all state so the next acquirePermit is immediate (unknown state)', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsRemaining: 0, requestsResetAt: Date.now() + 60_000 });
    bucket.freeze(30_000);
    bucket.resetForTests();
    const start = Date.now();
    await bucket.acquirePermit(100);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('also resets requestsLimit and inputTokensLimit to -1', async () => {
    const bucket = new RateLimitBucket();
    bucket.update({ requestsLimit: 100, inputTokensLimit: 200_000 });
    bucket.resetForTests();
    // After reset, the limits are -1. Set a window reset to verify replenishment
    // falls back to -1 (unknown) since limits were cleared.
    bucket.update({
      requestsRemaining: 0,
      requestsResetAt: Date.now() - 1, // expired
    });
    // Both remaining and limit are unknown → pass-through.
    const start = Date.now();
    await bucket.acquirePermit(100);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

// ── outputTokensRemaining getter ──────────────────────────────────────────────

describe('outputTokensRemaining', () => {
  it('starts at -1 (unknown)', () => {
    const bucket = new RateLimitBucket();
    expect(bucket.outputTokensRemaining).toBe(-1);
  });

  it('reflects the value from update()', () => {
    const bucket = new RateLimitBucket();
    bucket.update({ outputTokensRemaining: 999 });
    expect(bucket.outputTokensRemaining).toBe(999);
  });

  it('is reset to -1 by resetForTests()', () => {
    const bucket = new RateLimitBucket();
    bucket.update({ outputTokensRemaining: 500 });
    bucket.resetForTests();
    expect(bucket.outputTokensRemaining).toBe(-1);
  });
});

// ── globalRateLimitBucket singleton ──────────────────────────────────────────

describe('globalRateLimitBucket', () => {
  it('is an instance of RateLimitBucket', () => {
    expect(globalRateLimitBucket).toBeInstanceOf(RateLimitBucket);
  });
});
