/**
 * Unit tests for the per-round `[vitals]` harness note builder.
 *
 * Pure apart from the env flag, so every time-dependent input (clock, zone,
 * ledger, context limit) is injected through `VitalsDeps`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UsageRecord } from '../../usage/usage-record.js';
import {
  CONTEXT_SHOW_PCT,
  USAGE_SHOW_PCT,
  VITALS_PREFIX,
  buildVitalsNote,
  formatDuration,
  vitalsEnabled,
} from './vitals.js';

// Fri 2026-10-09 14:32:00 EDT.
const NOW = Date.UTC(2026, 9, 9, 18, 32, 0);
const TZ = 'America/New_York';
const MIN = 60_000;

const base = { now: () => NOW, timeZone: TZ, contextLimit: () => 200_000 };

function usage(utilization: number, extra: Partial<NonNullable<UsageRecord['windows']>> = {}): UsageRecord {
  return {
    v: 1,
    provider: 'anthropic',
    account: 'oauth',
    windows: { fiveHour: { utilization, resetsAt: NOW + 180 * MIN }, observedAt: NOW - MIN, ...extra },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildVitalsNote: ambient tier', () => {
  it('renders absolute local time with zone and elapsed turn time', () => {
    const note = buildVitalsNote({ turnStartedAt: NOW - (4 * MIN + 12_000) }, base);
    expect(note).toBe(`${VITALS_PREFIX} Fri 2026-10-09 14:32 EDT · turn 4m12s`);
  });

  it('shows time left before the soft deadline, and "due" once past it', () => {
    const start = NOW - 30 * MIN;
    expect(buildVitalsNote({ turnStartedAt: start, softDeadlineMs: 40 * MIN }, base)).toContain(
      '· wind-down in 10m00s',
    );
    expect(buildVitalsNote({ turnStartedAt: start, softDeadlineMs: 20 * MIN }, base)).toContain('· wind-down due');
    expect(buildVitalsNote({ turnStartedAt: start, softDeadlineMs: 0 }, base)).not.toContain('wind-down');
  });
});

describe('buildVitalsNote: context salience', () => {
  it(`omits context below ${CONTEXT_SHOW_PCT}% and shows it at or above`, () => {
    const input = { turnStartedAt: NOW, model: 'sonnet' };
    expect(buildVitalsNote({ ...input, contextTokens: 98_000 }, base)).not.toContain('context');
    expect(buildVitalsNote({ ...input, contextTokens: 122_000 }, base)).toContain('· context 61%');
  });

  it('tags high context fill', () => {
    const note = buildVitalsNote({ turnStartedAt: NOW, model: 'sonnet', contextTokens: 184_000 }, base);
    expect(note).toContain('· context 92% (high)');
  });

  it('omits context when tokens, model, or limit are unknown', () => {
    expect(buildVitalsNote({ turnStartedAt: NOW, contextTokens: 150_000 }, base)).not.toContain('context');
    expect(buildVitalsNote({ turnStartedAt: NOW, model: 'sonnet' }, base)).not.toContain('context');
    const zeroLimit = { ...base, contextLimit: () => 0 };
    expect(buildVitalsNote({ turnStartedAt: NOW, model: 'm', contextTokens: 9 }, zeroLimit)).not.toContain('context');
  });
});

describe('buildVitalsNote: usage salience', () => {
  const root = { turnStartedAt: NOW, claudeUsage: true };

  it(`omits usage below ${USAGE_SHOW_PCT}%`, () => {
    expect(buildVitalsNote(root, { ...base, readClaudeUsage: () => usage(0.79) })).not.toContain('usage');
  });

  it('shows the binding window with reset time when no burn projection exists', () => {
    const note = buildVitalsNote(root, { ...base, readClaudeUsage: () => usage(0.84) });
    expect(note).toContain('· Claude 5h usage 84%, resets in 3h00m');
  });

  it('prefers a burn-rate time-to-full when the history ring supports one', () => {
    const history = [
      { observedAt: NOW - 8 * MIN, utilization: 0.8 },
      { observedAt: NOW - 4 * MIN, utilization: 0.82 },
      { observedAt: NOW, utilization: 0.84 },
    ];
    const note = buildVitalsNote(root, { ...base, readClaudeUsage: () => usage(0.84, { history }) });
    expect(note).toContain('· Claude 5h usage 84%, full in ~32m');
  });

  it('tags high usage', () => {
    expect(buildVitalsNote(root, { ...base, readClaudeUsage: () => usage(0.93) })).toContain('usage 93% (high)');
  });

  it('never shows usage to a subagent, even when it is high', () => {
    const read = vi.fn(() => usage(0.95));
    const note = buildVitalsNote({ ...root, subagentId: 'child-1' }, { ...base, readClaudeUsage: read });
    expect(note).not.toContain('usage');
    expect(read).not.toHaveBeenCalled();
  });

  it('skips usage when Claude windows do not apply to the session', () => {
    const read = vi.fn(() => usage(0.95));
    expect(buildVitalsNote({ turnStartedAt: NOW }, { ...base, readClaudeUsage: read })).not.toContain('usage');
    expect(read).not.toHaveBeenCalled();
  });

  it('ignores a stale or missing ledger record', () => {
    const stale = usage(0.95, { observedAt: NOW - 60 * MIN });
    expect(buildVitalsNote(root, { ...base, readClaudeUsage: () => stale })).not.toContain('usage');
    expect(buildVitalsNote(root, { ...base, readClaudeUsage: () => undefined })).not.toContain('usage');
  });
});

describe('buildVitalsNote: safety', () => {
  it('returns undefined instead of throwing when a source throws', () => {
    const boom = (): never => {
      throw new Error('ledger exploded');
    };
    expect(buildVitalsNote({ turnStartedAt: NOW, claudeUsage: true }, { ...base, readClaudeUsage: boom })).toBe(
      undefined,
    );
  });

  it('is disabled by AFK_VITALS=0 and on by default', () => {
    expect(vitalsEnabled()).toBe(true);
    vi.stubEnv('AFK_VITALS', '0');
    expect(vitalsEnabled()).toBe(false);
    expect(buildVitalsNote({ turnStartedAt: NOW }, base)).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(4 * MIN + 12_000)).toBe('4m12s');
    expect(formatDuration(65 * MIN)).toBe('1h05m');
    expect(formatDuration(-5)).toBe('0s');
  });

  it('drops seconds for coarse forecasts and never renders 0m', () => {
    expect(formatDuration(48 * MIN + 30_000, false)).toBe('48m');
    expect(formatDuration(10_000, false)).toBe('1m');
  });
});
