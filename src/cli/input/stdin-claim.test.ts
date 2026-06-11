/**
 * Unit tests for the StdinClaim module.
 *
 * Pins the single-consumer stdin invariant:
 *  - Only one claim may be held at a time.
 *  - Release is idempotent.
 *  - withStdinClaim releases even when fn throws.
 *  - currentStdinClaimHolder() tracks state correctly.
 *  - __resetStdinClaimForTests() allows test isolation.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetStdinClaimForTests,
  acquireStdinClaim,
  currentStdinClaimHolder,
  withStdinClaim,
} from './stdin-claim.js';

// ─── Test isolation ───────────────────────────────────────────────────────────

beforeEach(() => {
  __resetStdinClaimForTests();
});

// ─── Core invariants ─────────────────────────────────────────────────────────

describe('acquireStdinClaim', () => {
  it('acquire → release → re-acquire with a different name succeeds', () => {
    const h = acquireStdinClaim('a');
    h.release();
    // Should not throw:
    const h2 = acquireStdinClaim('b');
    h2.release();
  });

  it('acquire while already held throws, naming both holders', () => {
    acquireStdinClaim('a');
    expect(() => acquireStdinClaim('b')).toThrowError(/\ba\b/);
    expect(() => {
      __resetStdinClaimForTests();
      acquireStdinClaim('first-holder');
      acquireStdinClaim('second-holder');
    }).toThrowError(/second-holder/);
  });

  it('release is idempotent — second call is a no-op', () => {
    const h = acquireStdinClaim('a');
    h.release();
    // Second release must not throw and must not corrupt state.
    expect(() => h.release()).not.toThrow();
    // State should be free so we can re-acquire.
    const h2 = acquireStdinClaim('b');
    h2.release();
  });

  it('re-acquiring with the same name after release succeeds', () => {
    const h1 = acquireStdinClaim('x');
    h1.release();
    const h2 = acquireStdinClaim('x');
    h2.release();
    expect(currentStdinClaimHolder()).toBeNull();
  });
});

describe('currentStdinClaimHolder', () => {
  it('returns the holder name while held', () => {
    const h = acquireStdinClaim('my-holder');
    expect(currentStdinClaimHolder()).toBe('my-holder');
    h.release();
  });

  it('returns null after release', () => {
    const h = acquireStdinClaim('x');
    h.release();
    expect(currentStdinClaimHolder()).toBeNull();
  });
});

describe('withStdinClaim', () => {
  it('releases even when fn throws', async () => {
    await expect(
      withStdinClaim('a', () => {
        throw new Error('fn-error');
      }),
    ).rejects.toThrow('fn-error');
    // Claim must be free after fn threw.
    expect(currentStdinClaimHolder()).toBeNull();
  });

  it('releases after fn resolves normally', async () => {
    const result = await withStdinClaim('a', () => 42);
    expect(result).toBe(42);
    expect(currentStdinClaimHolder()).toBeNull();
  });

  it('releases when async fn rejects', async () => {
    await expect(
      withStdinClaim('async-holder', async () => {
        await Promise.resolve();
        throw new Error('async-error');
      }),
    ).rejects.toThrow('async-error');
    expect(currentStdinClaimHolder()).toBeNull();
  });
});

describe('__resetStdinClaimForTests', () => {
  it('clears state regardless of prior acquisitions', () => {
    acquireStdinClaim('held');
    expect(currentStdinClaimHolder()).toBe('held');
    __resetStdinClaimForTests();
    expect(currentStdinClaimHolder()).toBeNull();
    // After reset, a fresh acquire works.
    const h = acquireStdinClaim('after-reset');
    expect(currentStdinClaimHolder()).toBe('after-reset');
    h.release();
  });
});

// ─── Error message content ────────────────────────────────────────────────────

describe('conflict error message', () => {
  it('names both the current holder and the requested holder', () => {
    acquireStdinClaim('alpha');
    let caughtMsg = '';
    try {
      acquireStdinClaim('beta');
    } catch (e) {
      caughtMsg = e instanceof Error ? e.message : String(e);
    }
    expect(caughtMsg).toContain('alpha');
    expect(caughtMsg).toContain('beta');
  });
});
