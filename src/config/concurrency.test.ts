import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS,
  DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS,
  DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS,
  MAX_CONCURRENT_BACKGROUND_JOBS_CEILING,
  MAX_CONCURRENT_SAFE_TOOL_CALLS_CEILING,
  MAX_CONCURRENT_SUBAGENT_CALLS_CEILING,
} from './concurrency.js';

// Helper that returns the concurrency module with a fresh warn-once latch.
// Using vi.resetModules() + dynamic import is the vitest-idiomatic way to
// access module internals that are intentionally not exported — it avoids the
// need for a test-only export in production code.
async function freshConcurrency() {
  vi.resetModules();
  return import('./concurrency.js');
}

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
  it('uses the defaults when env values are absent', async () => {
    for (const key of keys) vi.stubEnv(key, undefined);
    const {
      resolveMaxConcurrentSafeToolCalls,
      resolveMaxConcurrentSubagentCalls,
      resolveMaxConcurrentBackgroundJobs,
      getConcurrencyStatuses,
    } = await freshConcurrency();
    expect(resolveMaxConcurrentSafeToolCalls()).toBe(DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS);
    expect(resolveMaxConcurrentSubagentCalls()).toBe(DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS);
    expect(resolveMaxConcurrentBackgroundJobs()).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS);
    expect(getConcurrencyStatuses(false).map((status) => status.source)).toEqual([
      'default', 'default', 'default',
    ]);
  });

  it('uses positive-integer overrides for all settings', async () => {
    keys.forEach((key, index) => vi.stubEnv(key, String(index + 1)));
    const { getConcurrencyStatuses } = await freshConcurrency();
    expect(getConcurrencyStatuses(false).map((status) => status.effectiveValue)).toEqual([1, 2, 3]);
    expect(getConcurrencyStatuses(false).every((status) => status.source === 'environment')).toBe(true);
  });

  it('falls back for invalid values and warns only once per key', async () => {
    vi.stubEnv('AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS', 'nope');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Fresh module instance guarantees the warn-once latch starts empty,
    // independently of any other test in this file.
    const { resolveMaxConcurrentSafeToolCalls, getConcurrencyStatuses } = await freshConcurrency();
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
      ['AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS', MAX_CONCURRENT_SAFE_TOOL_CALLS_CEILING, 'resolveMaxConcurrentSafeToolCalls'] as const,
      ['AFK_MAX_CONCURRENT_SUBAGENT_CALLS', MAX_CONCURRENT_SUBAGENT_CALLS_CEILING, 'resolveMaxConcurrentSubagentCalls'] as const,
      ['AFK_MAX_CONCURRENT_BACKGROUND_JOBS', MAX_CONCURRENT_BACKGROUND_JOBS_CEILING, 'resolveMaxConcurrentBackgroundJobs'] as const,
    ])('%s: a value exactly at the ceiling (%d) is accepted', async (key, ceiling, fnName) => {
      vi.stubEnv(key, String(ceiling));
      const mod = await freshConcurrency();
      const resolve = mod[fnName];
      expect(resolve()).toBe(ceiling);
      const status = mod.getConcurrencyStatuses(false).find((s) => s.key === key);
      expect(status).toMatchObject({ valid: true, source: 'environment', effectiveValue: ceiling });
    });

    it.each([
      ['AFK_MAX_CONCURRENT_SAFE_TOOL_CALLS', MAX_CONCURRENT_SAFE_TOOL_CALLS_CEILING, DEFAULT_MAX_CONCURRENT_SAFE_TOOL_CALLS, 'resolveMaxConcurrentSafeToolCalls'] as const,
      ['AFK_MAX_CONCURRENT_SUBAGENT_CALLS', MAX_CONCURRENT_SUBAGENT_CALLS_CEILING, DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS, 'resolveMaxConcurrentSubagentCalls'] as const,
      ['AFK_MAX_CONCURRENT_BACKGROUND_JOBS', MAX_CONCURRENT_BACKGROUND_JOBS_CEILING, DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS, 'resolveMaxConcurrentBackgroundJobs'] as const,
    ])('%s: a value one above the ceiling (%d + 1) falls back to the default (%d)', async (key, ceiling, defaultValue, fnName) => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.stubEnv(key, String(ceiling + 1));
      const mod = await freshConcurrency();
      const resolve = mod[fnName];
      expect(resolve()).toBe(defaultValue);
      const status = mod.getConcurrencyStatuses(false).find((s) => s.key === key);
      expect(status).toMatchObject({ valid: false, source: 'fallback', effectiveValue: defaultValue });
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0]?.[0])).toContain(`Expected an integer in [1, ${ceiling}]`);
    });

    it('an absurdly large value (e.g. a dropped removal attempt) still falls back to the default', async () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.stubEnv('AFK_MAX_CONCURRENT_BACKGROUND_JOBS', '1000000000');
      const { resolveMaxConcurrentBackgroundJobs } = await freshConcurrency();
      expect(resolveMaxConcurrentBackgroundJobs()).toBe(DEFAULT_MAX_CONCURRENT_BACKGROUND_JOBS);
    });
  });

  describe('accepted grammar', () => {
    // Bare Number() would coerce every one of these to an in-range integer.
    // resolveMaxNestingDepth anchors on /^\d+$/ for the same reason: an operator
    // typo must fall back and warn, never silently resolve to a different number.
    it.each(['0x8', '1e1', '8.0', '+8', ' '])(
      'rejects %j — a non-decimal grammar Number() would otherwise accept',
      async (raw) => {
        const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        vi.stubEnv('AFK_MAX_CONCURRENT_SUBAGENT_CALLS', raw);
        const { resolveMaxConcurrentSubagentCalls } = await freshConcurrency();
        expect(resolveMaxConcurrentSubagentCalls()).toBe(DEFAULT_MAX_CONCURRENT_SUBAGENT_CALLS);
        expect(write).toHaveBeenCalledTimes(1);
      },
    );

    it('accepts surrounding whitespace and leading zeros', async () => {
      vi.stubEnv('AFK_MAX_CONCURRENT_SUBAGENT_CALLS', ' 06 ');
      const { resolveMaxConcurrentSubagentCalls } = await freshConcurrency();
      expect(resolveMaxConcurrentSubagentCalls()).toBe(6);
    });
  });
});
