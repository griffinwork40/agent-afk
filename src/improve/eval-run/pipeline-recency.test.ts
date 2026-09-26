/**
 * Tests for `improve/eval-run/pipeline-recency.ts`.
 *
 * Coverage:
 *   - resolveStalenessThreshold: default, env override, zero (disabled), invalid.
 *   - parseLatestTimestamp: empty, single line, multiple lines (picks latest),
 *     corrupt lines (skipped), no timestamp field.
 *   - checkEvalPipelineRecency:
 *       disabled (threshold=0), never-run (null readIndex), never-run (no timestamps),
 *       fresh (within threshold), stale (at threshold), stale (beyond threshold),
 *       error (invalid timestamp in index), error (readIndex throws).
 *   - Guard cannot silently fail: every error path returns status 'error' or
 *     'never-run', never throws.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkEvalPipelineRecency,
  DEFAULT_STALENESS_DAYS,
  parseLatestTimestamp,
  resolveStalenessThreshold,
} from './pipeline-recency.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-09-23T12:00:00.000Z');
const fixedNow = () => FIXED_NOW;

/** Build a minimal .index.jsonl string with the supplied ISO timestamps. */
function buildIndex(...timestamps: string[]): string {
  return timestamps
    .map((ts) => JSON.stringify({ timestamp: ts, event: 'created' }))
    .join('\n');
}

// ---------------------------------------------------------------------------
// resolveStalenessThreshold
// ---------------------------------------------------------------------------

describe('resolveStalenessThreshold', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['AFK_EVAL_STALENESS_DAYS'];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['AFK_EVAL_STALENESS_DAYS'];
    else process.env['AFK_EVAL_STALENESS_DAYS'] = originalEnv;
  });

  it('returns DEFAULT_STALENESS_DAYS when env var is unset', () => {
    delete process.env['AFK_EVAL_STALENESS_DAYS'];
    expect(resolveStalenessThreshold()).toBe(DEFAULT_STALENESS_DAYS);
  });

  it('returns DEFAULT_STALENESS_DAYS when env var is empty string', () => {
    process.env['AFK_EVAL_STALENESS_DAYS'] = '';
    expect(resolveStalenessThreshold()).toBe(DEFAULT_STALENESS_DAYS);
  });

  it('returns the parsed value when env var is a valid integer', () => {
    process.env['AFK_EVAL_STALENESS_DAYS'] = '14';
    expect(resolveStalenessThreshold()).toBe(14);
  });

  it('returns 0 (disabled) when env var is "0"', () => {
    process.env['AFK_EVAL_STALENESS_DAYS'] = '0';
    expect(resolveStalenessThreshold()).toBe(0);
  });

  it('returns DEFAULT_STALENESS_DAYS when env var is not a number', () => {
    process.env['AFK_EVAL_STALENESS_DAYS'] = 'banana';
    expect(resolveStalenessThreshold()).toBe(DEFAULT_STALENESS_DAYS);
  });

  it('returns DEFAULT_STALENESS_DAYS when env var is negative', () => {
    process.env['AFK_EVAL_STALENESS_DAYS'] = '-3';
    expect(resolveStalenessThreshold()).toBe(DEFAULT_STALENESS_DAYS);
  });
});

// ---------------------------------------------------------------------------
// parseLatestTimestamp
// ---------------------------------------------------------------------------

describe('parseLatestTimestamp', () => {
  it('returns null for empty string', () => {
    expect(parseLatestTimestamp('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseLatestTimestamp('   \n  ')).toBeNull();
  });

  it('returns the single timestamp present', () => {
    const raw = JSON.stringify({ timestamp: '2026-09-01T00:00:00.000Z', event: 'created' });
    expect(parseLatestTimestamp(raw)).toBe('2026-09-01T00:00:00.000Z');
  });

  it('returns the latest timestamp across multiple lines', () => {
    const raw = buildIndex(
      '2026-06-01T00:00:00.000Z',
      '2026-09-20T23:23:25.853Z',
      '2026-07-15T12:00:00.000Z',
    );
    expect(parseLatestTimestamp(raw)).toBe('2026-09-20T23:23:25.853Z');
  });

  it('skips corrupt (non-JSON) lines and parses the rest', () => {
    const raw = [
      'NOT JSON',
      JSON.stringify({ timestamp: '2026-08-01T00:00:00.000Z', event: 'created' }),
      '{ broken',
    ].join('\n');
    expect(parseLatestTimestamp(raw)).toBe('2026-08-01T00:00:00.000Z');
  });

  it('skips lines with no timestamp field', () => {
    const raw = [
      JSON.stringify({ event: 'created', evalRunId: 'foo' }),
      JSON.stringify({ timestamp: '2026-09-10T00:00:00.000Z' }),
    ].join('\n');
    expect(parseLatestTimestamp(raw)).toBe('2026-09-10T00:00:00.000Z');
  });

  it('skips lines with empty string timestamp', () => {
    const raw = [
      JSON.stringify({ timestamp: '', event: 'created' }),
      JSON.stringify({ timestamp: '2026-09-10T00:00:00.000Z', event: 'created' }),
    ].join('\n');
    expect(parseLatestTimestamp(raw)).toBe('2026-09-10T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// checkEvalPipelineRecency
// ---------------------------------------------------------------------------

describe('checkEvalPipelineRecency', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['AFK_EVAL_STALENESS_DAYS'];
    // Default to threshold=7 for most tests.
    process.env['AFK_EVAL_STALENESS_DAYS'] = '7';
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['AFK_EVAL_STALENESS_DAYS'];
    else process.env['AFK_EVAL_STALENESS_DAYS'] = originalEnv;
  });

  // -- disabled --

  it('returns status=disabled when threshold is 0', () => {
    process.env['AFK_EVAL_STALENESS_DAYS'] = '0';
    const result = checkEvalPipelineRecency({ now: fixedNow });
    expect(result.status).toBe('disabled');
    expect(result.lastRunAt).toBeNull();
    expect(result.ageInDays).toBeNull();
    expect(result.thresholdDays).toBe(0);
    expect(result.message).toContain('disabled');
  });

  // -- never-run --

  it('returns status=never-run when readIndex returns null', () => {
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => null,
    });
    expect(result.status).toBe('never-run');
    expect(result.lastRunAt).toBeNull();
    expect(result.ageInDays).toBeNull();
    expect(result.message).toContain('NEVER');
  });

  it('returns status=never-run when index is empty string', () => {
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => '',
    });
    expect(result.status).toBe('never-run');
    expect(result.message).toContain('NEVER');
  });

  it('returns status=never-run when index has no parseable timestamps', () => {
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => JSON.stringify({ event: 'created', evalRunId: 'x' }),
    });
    expect(result.status).toBe('never-run');
    expect(result.message).toContain('NEVER');
  });

  // -- fresh --

  it('returns status=fresh when last run is within the threshold', () => {
    // FIXED_NOW = 2026-09-23; 6 days ago = 2026-09-17 → within 7-day threshold.
    const sixDaysAgo = '2026-09-17T12:00:00.000Z';
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => buildIndex(sixDaysAgo),
    });
    expect(result.status).toBe('fresh');
    expect(result.lastRunAt).toBe(sixDaysAgo);
    expect(result.ageInDays).toBe(6);
    expect(result.thresholdDays).toBe(7);
    expect(result.message).toContain('fresh');
    expect(result.message).toContain('6 days ago');
  });

  it('returns status=fresh when last run is today (0 days)', () => {
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => buildIndex('2026-09-23T11:59:00.000Z'),
    });
    expect(result.status).toBe('fresh');
    expect(result.ageInDays).toBe(0);
  });

  // -- stale --

  it('returns status=stale when last run equals the threshold (boundary)', () => {
    // FIXED_NOW = 2026-09-23; exactly 7 days ago = 2026-09-16 → stale.
    const sevenDaysAgo = '2026-09-16T12:00:00.000Z';
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => buildIndex(sevenDaysAgo),
    });
    expect(result.status).toBe('stale');
    expect(result.ageInDays).toBe(7);
    expect(result.thresholdDays).toBe(7);
    expect(result.message).toContain('STALE');
    expect(result.message).toContain('eval-run');
  });

  it('returns status=stale when last run is far older than the threshold', () => {
    const fifteenDaysAgo = '2026-09-08T12:00:00.000Z';
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => buildIndex(fifteenDaysAgo),
    });
    expect(result.status).toBe('stale');
    expect(result.ageInDays).toBe(15);
    expect(result.message).toContain('15 days ago');
  });

  it('stale message references the threshold and remediation command', () => {
    process.env['AFK_EVAL_STALENESS_DAYS'] = '3';
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => buildIndex('2026-09-15T00:00:00.000Z'),
    });
    expect(result.status).toBe('stale');
    expect(result.message).toContain('AFK_EVAL_STALENESS_DAYS=3');
    expect(result.message).toContain('afk improve eval-run');
  });

  it('picks the latest of multiple timestamps when checking staleness', () => {
    // Index has an old entry and a recent one — should use the recent one.
    const oldEntry = '2026-01-01T00:00:00.000Z';
    const recentEntry = '2026-09-22T00:00:00.000Z'; // 1 day ago
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => buildIndex(oldEntry, recentEntry),
    });
    expect(result.status).toBe('fresh');
    expect(result.lastRunAt).toBe(recentEntry);
    expect(result.ageInDays).toBe(1);
  });

  // -- error (guard cannot silently fail) --

  it('returns status=error (not throw) when readIndex throws', () => {
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => {
        throw new Error('disk read failure');
      },
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('disk read failure');
    expect(result.lastRunAt).toBeNull();
  });

  it('returns status=error (not throw) when last-run timestamp is invalid', () => {
    // Parse the timestamp but make it invalid so Date() returns NaN.
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () =>
        JSON.stringify({ timestamp: 'not-a-date', event: 'created' }),
    });
    // parseLatestTimestamp accepts it as a string (it's non-empty), but
    // new Date('not-a-date').getTime() === NaN → error path.
    expect(result.status).toBe('error');
    expect(result.message).toContain('not-a-date');
  });

  // -- result shape --

  it('fresh result includes thresholdDays from env', () => {
    process.env['AFK_EVAL_STALENESS_DAYS'] = '14';
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => buildIndex('2026-09-22T00:00:00.000Z'),
    });
    expect(result.thresholdDays).toBe(14);
  });

  it('never-run result includes thresholdDays', () => {
    const result = checkEvalPipelineRecency({
      now: fixedNow,
      readIndex: () => null,
    });
    expect(result.thresholdDays).toBe(7);
  });
});
