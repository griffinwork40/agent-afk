/**
 * Tests for the fork-time autoResumeOnUsageLimit policy resolver.
 *
 * Coverage:
 *  - Explicit true/false caller value wins over env
 *  - Env var on (='1') → true for non-daemon surfaces
 *  - Env var off (unset) → false
 *  - daemon surface → false even with env=1
 *  - daemon surface → false even with explicit true
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Surface } from '../awareness/types.js';

// We must reset process.env before importing to exercise the lazy getter.
// Use dynamic import so each test group can set the env before the module loads.

describe('resolveChildAutoResume', () => {
  const envKey = 'AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT';

  afterEach(() => {
    delete process.env[envKey];
  });

  it('explicit true wins over env=off', async () => {
    delete process.env[envKey];
    const { resolveChildAutoResume } = await import('./usage-limit-park-policy.js');
    expect(resolveChildAutoResume(true, 'repl')).toBe(true);
  });

  it('explicit false wins over env=on', async () => {
    process.env[envKey] = '1';
    const { resolveChildAutoResume } = await import('./usage-limit-park-policy.js');
    expect(resolveChildAutoResume(false, 'repl')).toBe(false);
  });

  it('env=on (="1") returns true when no explicit value', async () => {
    process.env[envKey] = '1';
    const { resolveChildAutoResume } = await import('./usage-limit-park-policy.js');
    expect(resolveChildAutoResume(undefined, 'repl')).toBe(true);
  });

  it('env off (unset) returns false when no explicit value', async () => {
    delete process.env[envKey];
    const { resolveChildAutoResume } = await import('./usage-limit-park-policy.js');
    expect(resolveChildAutoResume(undefined, 'repl')).toBe(false);
  });

  it('daemon surface → false even with env=on', async () => {
    process.env[envKey] = '1';
    const { resolveChildAutoResume } = await import('./usage-limit-park-policy.js');
    expect(resolveChildAutoResume(undefined, 'daemon')).toBe(false);
  });

  it('daemon surface → false even with explicit true', async () => {
    const { resolveChildAutoResume } = await import('./usage-limit-park-policy.js');
    expect(resolveChildAutoResume(true, 'daemon')).toBe(false);
  });

  it.each([
    'cli', 'repl', 'telegram', 'subagent', 'web', 'unknown', undefined,
  ] as (Surface | undefined)[])(
    'surface %s + env=on returns true',
    async (surface) => {
      process.env[envKey] = '1';
      const { resolveChildAutoResume } = await import('./usage-limit-park-policy.js');
      expect(resolveChildAutoResume(undefined, surface)).toBe(true);
    },
  );
});
