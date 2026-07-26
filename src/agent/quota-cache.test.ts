/**
 * Tests for src/agent/quota-cache.ts
 *
 * The cache is module-scope mutable state shared across cases in this file, so
 * every test calls `resetQuotaCacheForTests()` first.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseQuotaHeaders,
  recordQuotaSnapshot,
  getQuotaSnapshot,
  onQuotaUpdate,
  resetQuotaCacheForTests,
  type QuotaSnapshot,
} from './quota-cache.js';

const H_5H_UTIL = 'anthropic-ratelimit-unified-5h-utilization';
const H_5H_RESET = 'anthropic-ratelimit-unified-5h-reset';
const H_7D_UTIL = 'anthropic-ratelimit-unified-7d-utilization';
const H_7D_RESET = 'anthropic-ratelimit-unified-7d-reset';

/** Epoch seconds for a plausible near-future reset. */
const RESET_EPOCH = 1_785_110_400;

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

beforeEach(() => {
  resetQuotaCacheForTests();
});

describe('parseQuotaHeaders', () => {
  it('parses both windows including reset timestamps', () => {
    const snap = parseQuotaHeaders(
      headers({
        [H_5H_UTIL]: '0.62',
        [H_5H_RESET]: String(RESET_EPOCH),
        [H_7D_UTIL]: '0.31',
        [H_7D_RESET]: String(RESET_EPOCH),
      }),
    );
    expect(snap).toBeDefined();
    expect(snap?.fiveHourUtilization).toBeCloseTo(0.62);
    expect(snap?.sevenDayUtilization).toBeCloseTo(0.31);
    expect(snap?.fiveHourResetsAt?.getTime()).toBe(RESET_EPOCH * 1000);
    expect(snap?.sevenDayResetsAt?.getTime()).toBe(RESET_EPOCH * 1000);
    expect(snap?.observedAt).toBeInstanceOf(Date);
  });

  it('reads header names case-insensitively', () => {
    const snap = parseQuotaHeaders(headers({ 'ANTHROPIC-RATELIMIT-UNIFIED-5H-UTILIZATION': '0.5' }));
    expect(snap?.fiveHourUtilization).toBeCloseTo(0.5);
  });

  it('parses a 5h-only response and omits the 7d window', () => {
    const snap = parseQuotaHeaders(headers({ [H_5H_UTIL]: '0.1' }));
    expect(snap?.fiveHourUtilization).toBeCloseTo(0.1);
    expect(snap?.sevenDayUtilization).toBeUndefined();
    expect(snap?.sevenDayResetsAt).toBeUndefined();
  });

  it('parses a 7d-only response and omits the 5h window', () => {
    const snap = parseQuotaHeaders(headers({ [H_7D_UTIL]: '0.9' }));
    expect(snap?.sevenDayUtilization).toBeCloseTo(0.9);
    expect(snap?.fiveHourUtilization).toBeUndefined();
  });

  it('returns undefined when no quota headers are present at all', () => {
    expect(parseQuotaHeaders(headers({ 'content-type': 'application/json' }))).toBeUndefined();
  });

  it('returns undefined when a reset is present but neither utilization is', () => {
    // A reset alone is not worth caching — there is no percentage to render.
    expect(parseQuotaHeaders(headers({ [H_5H_RESET]: String(RESET_EPOCH) }))).toBeUndefined();
  });

  it('omits a non-numeric utilization', () => {
    expect(parseQuotaHeaders(headers({ [H_5H_UTIL]: 'not-a-number' }))).toBeUndefined();
  });

  it('omits a non-finite utilization', () => {
    expect(parseQuotaHeaders(headers({ [H_5H_UTIL]: 'Infinity' }))).toBeUndefined();
  });

  it('clamps utilization above 1 down to 1', () => {
    const snap = parseQuotaHeaders(headers({ [H_5H_UTIL]: '7.5' }));
    expect(snap?.fiveHourUtilization).toBe(1);
  });

  it('clamps negative utilization up to 0', () => {
    const snap = parseQuotaHeaders(headers({ [H_5H_UTIL]: '-3' }));
    expect(snap?.fiveHourUtilization).toBe(0);
  });

  it('omits a negative reset epoch but keeps the utilization', () => {
    const snap = parseQuotaHeaders(headers({ [H_5H_UTIL]: '0.4', [H_5H_RESET]: '-10' }));
    expect(snap?.fiveHourUtilization).toBeCloseTo(0.4);
    expect(snap?.fiveHourResetsAt).toBeUndefined();
  });

  it('omits an absurd reset epoch (millisecond value mistaken for seconds)', () => {
    // A ms-precision value read as seconds lands far past year 2100.
    const snap = parseQuotaHeaders(headers({ [H_5H_UTIL]: '0.4', [H_5H_RESET]: '1785110400000' }));
    expect(snap?.fiveHourUtilization).toBeCloseTo(0.4);
    expect(snap?.fiveHourResetsAt).toBeUndefined();
  });

  it('omits a non-numeric reset epoch', () => {
    const snap = parseQuotaHeaders(headers({ [H_5H_UTIL]: '0.4', [H_5H_RESET]: 'soon' }));
    expect(snap?.fiveHourResetsAt).toBeUndefined();
  });

  it('never throws when the headers object misbehaves', () => {
    const hostile = {
      get() {
        throw new Error('header access exploded');
      },
    } as unknown as Headers;
    expect(() => parseQuotaHeaders(hostile)).not.toThrow();
    expect(parseQuotaHeaders(hostile)).toBeUndefined();
  });
});

describe('cache + subscription', () => {
  function snapshot(fiveHour?: number, sevenDay?: number): QuotaSnapshot {
    return {
      ...(fiveHour !== undefined ? { fiveHourUtilization: fiveHour } : {}),
      ...(sevenDay !== undefined ? { sevenDayUtilization: sevenDay } : {}),
      observedAt: new Date(),
    };
  }

  it('returns undefined before anything is recorded', () => {
    expect(getQuotaSnapshot()).toBeUndefined();
  });

  it('stores and returns the latest snapshot', () => {
    recordQuotaSnapshot(snapshot(0.2));
    recordQuotaSnapshot(snapshot(0.5));
    expect(getQuotaSnapshot()?.fiveHourUtilization).toBeCloseTo(0.5);
  });

  it('notifies on the very first snapshot', () => {
    const listener = vi.fn();
    onQuotaUpdate(listener);
    recordQuotaSnapshot(snapshot(0.2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies when a rounded percentage changes', () => {
    const listener = vi.fn();
    recordQuotaSnapshot(snapshot(0.2));
    onQuotaUpdate(listener);
    recordQuotaSnapshot(snapshot(0.25));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does NOT notify when the rounded percentage is unchanged', () => {
    // Flicker guard: repaint throttles at 100ms with no trailing flush, so a
    // push per API response must not reach the status line.
    const listener = vi.fn();
    recordQuotaSnapshot(snapshot(0.2001));
    onQuotaUpdate(listener);
    recordQuotaSnapshot(snapshot(0.2004));
    expect(listener).not.toHaveBeenCalled();
    // ...but the stored snapshot is still refreshed.
    expect(getQuotaSnapshot()?.fiveHourUtilization).toBeCloseTo(0.2004);
  });

  it('notifies when only the 7d window moves', () => {
    const listener = vi.fn();
    recordQuotaSnapshot(snapshot(0.2, 0.3));
    onQuotaUpdate(listener);
    recordQuotaSnapshot(snapshot(0.2, 0.4));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further notifications', () => {
    const listener = vi.fn();
    const off = onQuotaUpdate(listener);
    recordQuotaSnapshot(snapshot(0.1));
    off();
    recordQuotaSnapshot(snapshot(0.9));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not propagate to the recorder', () => {
    const good = vi.fn();
    onQuotaUpdate(() => {
      throw new Error('subscriber exploded');
    });
    onQuotaUpdate(good);
    expect(() => recordQuotaSnapshot(snapshot(0.5))).not.toThrow();
    // A broken subscriber must not starve the healthy ones.
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('resetQuotaCacheForTests clears both the snapshot and the listeners', () => {
    const listener = vi.fn();
    onQuotaUpdate(listener);
    recordQuotaSnapshot(snapshot(0.5));
    resetQuotaCacheForTests();
    expect(getQuotaSnapshot()).toBeUndefined();
    recordQuotaSnapshot(snapshot(0.7));
    expect(listener).toHaveBeenCalledTimes(1); // only the pre-reset call
  });
});
