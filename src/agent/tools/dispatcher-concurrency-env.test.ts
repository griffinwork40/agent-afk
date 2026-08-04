import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS,
  resolveMaxConcurrentSafeToolCalls,
} from './dispatcher.js';

const concurrencyEnv = 'AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS';
afterEach(() => vi.unstubAllEnvs());

describe('resolveMaxConcurrentSafeToolCalls', () => {
  it('uses a positive integer env override', () => {
    vi.stubEnv(concurrencyEnv, '3');
    expect(resolveMaxConcurrentSafeToolCalls()).toBe(3);
  });

  it.each(['', '0', '-1', '1.5', 'nope'])('falls back for invalid value %j', (value) => {
    vi.stubEnv(concurrencyEnv, value);
    expect(resolveMaxConcurrentSafeToolCalls()).toBe(DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS);
  });
});
