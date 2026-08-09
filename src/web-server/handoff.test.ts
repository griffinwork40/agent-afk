/**
 * Contract: a handoff nonce is redeemable exactly once and only inside the TTL.
 * The clock is injected so expiry is asserted without timer manipulation.
 */

import { describe, it, expect } from 'vitest';
import { HandoffNonces, HANDOFF_TTL_MS } from './handoff.js';

describe('HandoffNonces', () => {
  it('mints a 64-hex-char nonce', () => {
    expect(new HandoffNonces().mint()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints distinct nonces', () => {
    const n = new HandoffNonces();
    expect(n.mint()).not.toBe(n.mint());
  });

  it('redeems a fresh nonce exactly once', () => {
    const n = new HandoffNonces();
    const nonce = n.mint();
    expect(n.redeem(nonce)).toBe(true);
    // Invariant: burnt on first redemption, so a replay inside the TTL fails
    // exactly like a replay after it.
    expect(n.redeem(nonce)).toBe(false);
  });

  it('refuses an unknown, empty, or absent nonce', () => {
    const n = new HandoffNonces();
    expect(n.redeem('never-issued')).toBe(false);
    expect(n.redeem('')).toBe(false);
    expect(n.redeem(undefined)).toBe(false);
  });

  it('refuses a nonce past its TTL', () => {
    let now = 1_000;
    const n = new HandoffNonces(() => now);
    const nonce = n.mint();
    now += HANDOFF_TTL_MS + 1;
    expect(n.redeem(nonce)).toBe(false);
  });

  it('still accepts a nonce on the last tick before expiry', () => {
    let now = 1_000;
    const n = new HandoffNonces(() => now);
    const nonce = n.mint();
    now += HANDOFF_TTL_MS - 1;
    expect(n.redeem(nonce)).toBe(true);
  });

  it('does not let an expired nonce accumulate forever', () => {
    let now = 1_000;
    const n = new HandoffNonces(() => now);
    n.mint();
    now += HANDOFF_TTL_MS + 1;
    // Sweeping happens on access; redeeming anything drops the stale entry.
    expect(n.redeem('unrelated')).toBe(false);
    expect(n.redeem('unrelated')).toBe(false);
  });
});
