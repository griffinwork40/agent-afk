/**
 * Tests for the fork-time autoResumeOnUsageLimit policy resolver.
 *
 * Coverage:
 *  - Explicit true/false caller value wins over env and over the daemon rule
 *  - Env var on ('1' / 'true', case-insensitive) → true for non-daemon surfaces
 *  - Env var off (unset / '0' / garbage) → false
 *  - daemon surface ignores the env default
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Surface } from '../awareness/types.js';
import { resolveChildAutoResume, isSubagentAutoResumeEnvEnabled } from './usage-limit-park-policy.js';

const envKey = 'AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT';

describe('resolveChildAutoResume', () => {
  afterEach(() => {
    delete process.env[envKey];
  });

  it('explicit true wins over env=off', () => {
    expect(resolveChildAutoResume(true, 'cli')).toBe(true);
  });

  it('explicit false wins over env=on', () => {
    process.env[envKey] = '1';
    expect(resolveChildAutoResume(false, 'cli')).toBe(false);
  });

  it('explicit true wins on the daemon surface (pre-existing caller opt-in contract)', () => {
    expect(resolveChildAutoResume(true, 'daemon')).toBe(true);
  });

  it('env=on returns true when no explicit value', () => {
    process.env[envKey] = '1';
    expect(resolveChildAutoResume(undefined, 'cli')).toBe(true);
  });

  it('env unset returns false when no explicit value', () => {
    expect(resolveChildAutoResume(undefined, 'cli')).toBe(false);
  });

  it('daemon surface ignores env=on', () => {
    process.env[envKey] = '1';
    expect(resolveChildAutoResume(undefined, 'daemon')).toBe(false);
  });

  it.each(['cli', 'telegram', 'unknown', undefined] as (Surface | undefined)[])(
    'surface %s + env=on returns true',
    (surface) => {
      process.env[envKey] = '1';
      expect(resolveChildAutoResume(undefined, surface)).toBe(true);
    },
  );
});

describe('isSubagentAutoResumeEnvEnabled', () => {
  afterEach(() => {
    delete process.env[envKey];
  });

  it.each([
    ['1', true],
    ['true', true],
    [' TRUE ', true],
    ['0', false],
    ['false', false],
    ['yes', false],
    ['', false],
  ])('%j → %s', (raw, expected) => {
    process.env[envKey] = raw;
    expect(isSubagentAutoResumeEnvEnabled()).toBe(expected);
  });

  it('unset → false', () => {
    expect(isSubagentAutoResumeEnvEnabled()).toBe(false);
  });
});
