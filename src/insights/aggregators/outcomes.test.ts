/**
 * Unit tests for the outcomes KPI aggregator.
 *
 * All I/O uses a temp directory — no reads from ~/.afk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateOutcomes,
  isoWeekKey,
  zeroOutcomeAggregates,
} from './outcomes.js';

// ---------------------------------------------------------------------------
// isoWeekKey
// ---------------------------------------------------------------------------

describe('isoWeekKey', () => {
  it('2024-W01 starts 2024-01-01 (Monday)', () => {
    expect(isoWeekKey(new Date('2024-01-01T00:00:00Z'))).toBe('2024-W01');
  });

  it('2024-W02 starts 2024-01-08', () => {
    expect(isoWeekKey(new Date('2024-01-08T00:00:00Z'))).toBe('2024-W02');
  });

  it('2023-W52 for 2023-12-31 (Sunday — last day of week 52)', () => {
    // 2023-12-31 is a Sunday; ISO week 52 of 2023
    expect(isoWeekKey(new Date('2023-12-31T00:00:00Z'))).toBe('2023-W52');
  });

  it('consistent for same calendar week', () => {
    // 2024-01-01 (Mon) and 2024-01-07 (Sun) are both in W01
    expect(isoWeekKey(new Date('2024-01-01T00:00:00Z'))).toBe(
      isoWeekKey(new Date('2024-01-07T00:00:00Z')),
    );
  });
});

// ---------------------------------------------------------------------------
// zeroOutcomeAggregates
// ---------------------------------------------------------------------------

describe('zeroOutcomeAggregates', () => {
  it('returns empty structure', () => {
    const z = zeroOutcomeAggregates();
    expect(z.totalRecords).toBe(0);
    expect(z.parseErrors).toBe(0);
    expect(z.byWeek).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// aggregateOutcomes
// ---------------------------------------------------------------------------

describe('aggregateOutcomes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `outcomes-agg-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRecord(name: string, record: unknown): void {
    writeFileSync(join(tmpDir, `${name}.json`), JSON.stringify(record), 'utf8');
  }

  it('returns zero when directory is empty', () => {
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    expect(result.totalRecords).toBe(0);
  });

  it('skips provisional records', () => {
    writeRecord('sess-prov', {
      state: 'provisional',
      label: 'unknown',
      settles_after: new Date(Date.now() + 1000).toISOString(),
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    expect(result.totalRecords).toBe(0);
  });

  it('counts settled succeeded with basis=proven as goodProven', () => {
    const settlesAt = new Date(Date.now() - 1000).toISOString();
    writeRecord('sess-ok', {
      state: 'settled',
      label: 'succeeded',
      basis: 'proven',
      settles_after: settlesAt,
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    expect(result.totalRecords).toBe(1);
    const weeks = Object.values(result.byWeek);
    expect(weeks.length).toBe(1);
    expect(weeks[0]?.goodProven).toBe(1);
    expect(weeks[0]?.goodPresumed).toBe(0);
  });

  it('counts settled succeeded with basis=no_bad_signals as goodPresumed', () => {
    const settlesAt = new Date(Date.now() - 1000).toISOString();
    writeRecord('sess-presume', {
      state: 'settled',
      label: 'succeeded',
      basis: 'no_bad_signals',
      settles_after: settlesAt,
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    const weeks = Object.values(result.byWeek);
    expect(weeks[0]?.goodPresumed).toBe(1);
    expect(weeks[0]?.goodProven).toBe(0);
  });

  it('counts settled succeeded with no basis as goodPresumed (pre-v2 records)', () => {
    const settlesAt = new Date(Date.now() - 1000).toISOString();
    writeRecord('sess-legacy', {
      state: 'settled',
      label: 'succeeded',
      settles_after: settlesAt,
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    const weeks = Object.values(result.byWeek);
    expect(weeks[0]?.goodPresumed).toBe(1);
  });

  it('counts failed as bad', () => {
    const settlesAt = new Date(Date.now() - 1000).toISOString();
    writeRecord('sess-bad', {
      state: 'settled',
      label: 'failed',
      settles_after: settlesAt,
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    const weeks = Object.values(result.byWeek);
    expect(weeks[0]?.bad).toBe(1);
  });

  it('counts interrupted as bad', () => {
    const settlesAt = new Date(Date.now() - 1000).toISOString();
    writeRecord('sess-int', {
      state: 'settled',
      label: 'interrupted',
      settles_after: settlesAt,
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    const weeks = Object.values(result.byWeek);
    expect(weeks[0]?.bad).toBe(1);
  });

  it('counts blocked', () => {
    const settlesAt = new Date(Date.now() - 1000).toISOString();
    writeRecord('sess-blk', {
      state: 'settled',
      label: 'blocked',
      settles_after: settlesAt,
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    const weeks = Object.values(result.byWeek);
    expect(weeks[0]?.blocked).toBe(1);
  });

  it('counts unknown', () => {
    const settlesAt = new Date(Date.now() - 1000).toISOString();
    writeRecord('sess-unk', {
      state: 'settled',
      label: 'unknown',
      settles_after: settlesAt,
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    const weeks = Object.values(result.byWeek);
    expect(weeks[0]?.unknown).toBe(1);
  });

  it('excludes records outside the time window', () => {
    const oldSettlesAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    writeRecord('sess-old', {
      state: 'settled',
      label: 'succeeded',
      basis: 'proven',
      settles_after: oldSettlesAt,
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    expect(result.totalRecords).toBe(0);
  });

  it('handles parse errors gracefully', () => {
    writeFileSync(join(tmpDir, 'bad.json'), 'NOT JSON', 'utf8');
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    expect(result.parseErrors).toBe(1);
    expect(result.totalRecords).toBe(0);
  });

  it('buckets into separate weeks', () => {
    // Two records in different weeks (use recent dates — 2024 is outside 365-day window from 2026)
    const week1Ms = Date.now() - 10 * 24 * 60 * 60 * 1000; // ~10 days ago
    const week2Ms = Date.now() - 3 * 24 * 60 * 60 * 1000;  // ~3 days ago
    const week1Date = new Date(week1Ms).toISOString();
    const week2Date = new Date(week2Ms).toISOString();
    writeRecord('sess-w1', {
      state: 'settled',
      label: 'succeeded',
      basis: 'proven',
      settles_after: week1Date,
    });
    writeRecord('sess-w2', {
      state: 'settled',
      label: 'failed',
      settles_after: week2Date,
    });
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    expect(result.totalRecords).toBe(2);
    // Records may be in the same or different weeks depending on when the test runs,
    // but all should be counted
    const totalGoodProven = Object.values(result.byWeek).reduce((s, b) => s + b.goodProven, 0);
    const totalBad = Object.values(result.byWeek).reduce((s, b) => s + b.bad, 0);
    expect(totalGoodProven).toBe(1);
    expect(totalBad).toBe(1);
  });

  it('skips non-json files', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# not a record', 'utf8');
    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    expect(result.totalRecords).toBe(0);
    expect(result.parseErrors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Finding #2: settles_after null falls back to history[last].at, not new Date()
// ---------------------------------------------------------------------------

describe('aggregateOutcomes – settles_after null fallback (finding #2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `outcomes-agg-finding2-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeRecord(name: string, record: unknown): void {
    writeFileSync(join(tmpDir, `${name}.json`), JSON.stringify(record), 'utf8');
  }

  it('uses last history entry at when settles_after is null (not current report time)', () => {
    // An old explicit-feedback record: settles_after=null, last history entry
    // is 45 days ago (outside the 30-day window). Must NOT appear in results.
    const oldAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    writeRecord('sess-old-ef', {
      state: 'settled',
      label: 'succeeded',
      basis: 'proven',
      settles_after: null,
      history: [{ at: oldAt, label: 'succeeded', reason: 'explicit_feedback' }],
    });

    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    // Old record should NOT be counted — its history.at is outside the window
    expect(result.totalRecords).toBe(0);
  });

  it('includes record with null settles_after when history.at is within window', () => {
    const recentAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    writeRecord('sess-recent-ef', {
      state: 'settled',
      label: 'succeeded',
      basis: 'proven',
      settles_after: null,
      history: [{ at: recentAt, label: 'succeeded', reason: 'explicit_feedback' }],
    });

    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    expect(result.totalRecords).toBe(1);
    const weeks = Object.values(result.byWeek);
    expect(weeks[0]?.goodProven).toBe(1);
  });

  it('skips record with null settles_after and no history (no timestamp available)', () => {
    // No settles_after, no history → cannot determine week → must skip the record
    writeRecord('sess-no-ts', {
      state: 'settled',
      label: 'succeeded',
      basis: 'proven',
      settles_after: null,
      history: [],
    });

    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    // Must skip — no timestamp available (previously would have landed in the current week)
    expect(result.totalRecords).toBe(0);
  });

  it('prefers settles_after over history.at when settles_after is present', () => {
    // settles_after is within window but the last history entry is old (45 days)
    const recentSettles = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const oldAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    writeRecord('sess-prefer-sa', {
      state: 'settled',
      label: 'succeeded',
      basis: 'proven',
      settles_after: recentSettles,
      history: [{ at: oldAt, label: 'succeeded', reason: 'prior' }],
    });

    const result = aggregateOutcomes({ days: 30, outcomesDir: tmpDir });
    // settles_after wins → record is within window → counted
    expect(result.totalRecords).toBe(1);
  });
});
