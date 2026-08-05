import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS,
  DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS,
  DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS,
  MAX_CONCURRENT_BACKGROUND_JOBS_CEILING,
  MAX_CONCURRENT_SAFE_TOOL_CALLS_CEILING,
  MAX_CONCURRENT_SUBAGENT_CALLS_CEILING,
  getConcurrencyStatuses,
  resetConcurrencyWarnings,
  resolveMaxConcurrentBackgroundJobs,
  resolveMaxConcurrentSafeToolCalls,
  resolveMaxConcurrentSubagentCalls,
} from './concurrency.js';

const keys = [
  'AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS',
  'AFK_MAX_CONCURRENT_SUBAGENT_CALLS',
  'AFK_MAX_CONCURRENT_BACKGROUND_JOBS',
] as const;

// Reset the module-level warn-once latch before every test so the "warns
// only once per key" assertion below is independent of file/declaration
// order — without this, the assertion would pass only because no earlier
// test in this file happened to warn on the same key first.
beforeEach(() => {
  resetConcurrencyWarnings();
});

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

  describe('upper clamp', () => {
    it.each([
      ['AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS', MAX_CONCURRENT_SAFE_TOOL_CALLS_CEILING, resolveMaxConcurrentSafeToolCalls] as const,
      ['AFK_MAX_CONCURRENT_SUBAGENT_CALLS', MAX_CONCURRENT_SUBAGENT_CALLS_CEILING, resolveMaxConcurrentSubagentCalls] as const,
      ['AFK_MAX_CONCURRENT_BACKGROUND_JOBS', MAX_CONCURRENT_BACKGROUND_JOBS_CEILING, resolveMaxConcurrentBackgroundJobs] as const,
    ])('%s: a value exactly at the ceiling (%d) is accepted', (key, ceiling, resolve) => {
      vi.stubEnv(key, String(ceiling));
      expect(resolve()).toBe(ceiling);
      const status = getConcurrencyStatuses(false).find((s) => s.key === key);
      expect(status).toMatchObject({ valid: true, source: 'environment', effectiveValue: ceiling });
    });

    it.each([
      ['AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS', MAX_CONCURRENT_SAFE_TOOL_CALLS_CEILING, DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS, resolveMaxConcurrentSafeToolCalls] as const,
      ['AFK_MAX_CONCURRENT_SUBAGENT_CALLS', MAX_CONCURRENT_SUBAGENT_CALLS_CEILING, DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS, resolveMaxConcurrentSubagentCalls] as const,
      ['AFK_MAX_CONCURRENT_BACKGROUND_JOBS', MAX_CONCURRENT_BACKGROUND_JOBS_CEILING, DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS, resolveMaxConcurrentBackgroundJobs] as const,
    ])('%s: a value one above the ceiling (%d + 1) falls back to the default (%d)', (key, ceiling, defaultValue, resolve) => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.stubEnv(key, String(ceiling + 1));
      expect(resolve()).toBe(defaultValue);
      const status = getConcurrencyStatuses(false).find((s) => s.key === key);
      expect(status).toMatchObject({ valid: false, source: 'fallback', effectiveValue: defaultValue });
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]?.[0])).toContain(`Expected an integer in [1, ${ceiling}]`);
    });

    it('an absurdly large value (e.g. a dropped removal attempt) still falls back to the default', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.stubEnv('AFK_MAX_CONCURRENT_BACKGROUND_JOBS', '1000000000');
      expect(resolveMaxConcurrentBackgroundJobs()).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS);
    });
  });
});
