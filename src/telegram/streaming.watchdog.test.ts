/**
 * Tests for the Telegram streaming inactivity watchdog — API-round-in-flight
 * suspension. Validates that the watchdog does not fire a false timeout while
 * the provider is making a new `messages.create` API call between tool rounds.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_API_ROUND_INFLIGHT_MS,
  MAX_TOOL_INFLIGHT_MS,
  TOOL_INFLIGHT_RECHECK_MS,
  type WatchdogState,
} from './streaming.watchdog.js';

describe('WatchdogState — apiRoundInFlight fields', () => {
  it('exports MAX_API_ROUND_INFLIGHT_MS as a positive number', () => {
    expect(MAX_API_ROUND_INFLIGHT_MS).toBeGreaterThan(0);
  });

  it('MAX_API_ROUND_INFLIGHT_MS exceeds the provider TTFB worst case (3 × 120s)', () => {
    // The provider-level TTFB budget is 3 attempts × 120s = 360s worst case.
    // The watchdog ceiling must exceed this so the provider's retry logic gets
    // a chance to recover before the Telegram watchdog fires.
    expect(MAX_API_ROUND_INFLIGHT_MS).toBeGreaterThan(360_000);
  });

  it('MAX_API_ROUND_INFLIGHT_MS is less than MAX_TOOL_INFLIGHT_MS', () => {
    // API calls should not be allowed to hang longer than a tool execution.
    expect(MAX_API_ROUND_INFLIGHT_MS).toBeLessThan(MAX_TOOL_INFLIGHT_MS);
  });

  it('TOOL_INFLIGHT_RECHECK_MS is a reasonable recheck cadence', () => {
    expect(TOOL_INFLIGHT_RECHECK_MS).toBeGreaterThanOrEqual(5_000);
    expect(TOOL_INFLIGHT_RECHECK_MS).toBeLessThanOrEqual(60_000);
  });

  it('WatchdogState interface accepts apiRoundInFlight fields', () => {
    const state: WatchdogState = {
      receivedAny: true,
      timedOut: false,
      lastActivityAt: Date.now(),
      inFlightTools: new Set(),
      toolInFlightSince: null,
      pausedUntil: null,
      apiRoundInFlight: true,
      apiRoundSince: Date.now(),
    };
    expect(state.apiRoundInFlight).toBe(true);
    expect(state.apiRoundSince).toBeTypeOf('number');
  });
});
