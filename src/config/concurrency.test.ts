import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS,
  DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS,
  DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS,
  getConcurrencyStatuses,
  resolveMaxConcurrentBackgroundJobs,
  resolveMaxConcurrentSafeToolCalls,
  resolveMaxConcurrentSubagentCalls,
} from './concurrency.js';

const keys = [
  'AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS',
  'AFK_MAX_CONCURRENT_SUBAGENT_CALLS',
  'AFK_MAX_CONCURRENT_BACKGROUND_JOBS',
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('concurrency settings', () => {
  it('uses the defaults when env values are absent', () => {
    for (const key of keys) vi.stubEnv(key, undefined);
    expect(resolveMaxConcurrentSafeToolCalls()).toBe(DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS);
    expect(resolveMaxConcurrentSubagentCalls()).toBe(DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS);
    expect(resolveMaxConcurrentBackgroundJobs()).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS);
    expect(getConcurrencyStatuses(false).map((status) => status.source)).toEqual([
      'default', 'default', 'default',
    ]);
  });

  it('uses positive-integer overrides for all settings', () => {
    keys.forEach((key, index) => vi.stubEnv(key, String(index + 1)));
    expect(getConcurrencyStatuses(false).map((status) => status.effectiveValue)).toEqual([1, 2, 3]);
    expect(getConcurrencyStatuses(false).every((status) => status.source === 'environment')).toBe(true);
  });

  it('falls back for invalid values and warns only once per key', () => {
    vi.stubEnv('AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS', 'nope');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(resolveMaxConcurrentSafeToolCalls()).toBe(DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS);
    expect(resolveMaxConcurrentSafeToolCalls()).toBe(DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain('AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS');
    expect(getConcurrencyStatuses(false)[0]).toMatchObject({
      valid: false,
      source: 'fallback',
      effectiveValue: DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS,
    });
  });
});
