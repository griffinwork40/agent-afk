/**
 * Unit tests for the preexisting-defect aggregator.
 *
 * Strategy: synthetic temp-dir fixtures with controlled JSONL content.
 * Tests cover afkHome isolation, window filtering, and the zero-records case.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregatePreexistingDefects, zeroPreexistingDefectAggregates } from './preexisting-defects.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `afk-preexisting-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpRoot, 'agent-framework'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeLedger(lines: string[]): void {
  writeFileSync(
    join(tmpRoot, 'agent-framework', 'preexisting-ledger.jsonl'),
    lines.join('\n') + '\n',
    'utf-8',
  );
}

const RECENT_TS = new Date().toISOString();
const OLD_TS = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago

function makeRecord(overrides: Partial<{
  ts: string;
  sessionId: string;
  turn: number;
  repo: string;
  signal: string;
  category: string;
  loci: string[];
}> = {}): string {
  return JSON.stringify({
    ts: RECENT_TS,
    sessionId: 'sess-abc',
    turn: 3,
    repo: '/home/user/myrepo',
    signal: 'preexisting-sentence',
    category: 'failing-test',
    loci: ['src/agent/session.test.ts'],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregatePreexistingDefects', () => {
  it('missing ledger → zero aggregates, no throw', () => {
    const result = aggregatePreexistingDefects({ days: 30, afkHome: '/nonexistent/xyz' });
    expect(result).toEqual(zeroPreexistingDefectAggregates());
  });

  it('zero-records case: empty ledger file → zero aggregates', () => {
    writeLedger([]);
    const result = aggregatePreexistingDefects({ days: 30, afkHome: tmpRoot });
    expect(result).toEqual(zeroPreexistingDefectAggregates());
  });

  it('afkHome isolation: reads from afkHome, not the real ledger', () => {
    // Write a record only to the tmpRoot ledger; real ~/.afk ledger is untouched.
    writeLedger([makeRecord({ sessionId: 'isolated-sess' })]);
    const result = aggregatePreexistingDefects({ days: 30, afkHome: tmpRoot });
    expect(result.totalRecords).toBe(1);
    expect(result.topClusters).toHaveLength(1);
    expect(result.topClusters[0]!.recurrenceCount).toBe(1);
  });

  it('window filtering: records older than options.days are excluded', () => {
    writeLedger([
      makeRecord({ ts: RECENT_TS, sessionId: 'new-sess' }),
      makeRecord({ ts: OLD_TS, sessionId: 'old-sess' }),
    ]);
    // 30-day window excludes the 40-day-old record
    const result = aggregatePreexistingDefects({ days: 30, afkHome: tmpRoot });
    expect(result.totalRecords).toBe(2);
    expect(result.skippedOutOfWindow).toBe(1);
    expect(result.topClusters).toHaveLength(1);
  });

  it('window filtering: all records in window when days is large', () => {
    writeLedger([
      makeRecord({ ts: RECENT_TS, sessionId: 'sess-1' }),
      makeRecord({ ts: OLD_TS, sessionId: 'sess-2' }),
    ]);
    const result = aggregatePreexistingDefects({ days: 90, afkHome: tmpRoot });
    expect(result.totalRecords).toBe(2);
    expect(result.skippedOutOfWindow).toBe(0);
  });

  it('malformed lines are silently skipped (missing category)', () => {
    const badLine = JSON.stringify({
      ts: RECENT_TS,
      sessionId: 'bad-sess',
      turn: 1,
      repo: '/repo',
      signal: 'preexisting-sentence',
      // missing 'category' — must be rejected by type guard
      loci: ['src/foo.ts'],
    });
    writeLedger([badLine, makeRecord({ sessionId: 'good-sess' })]);
    const result = aggregatePreexistingDefects({ days: 30, afkHome: tmpRoot });
    // Only the valid record counts
    expect(result.totalRecords).toBe(1);
    expect(result.topClusters).toHaveLength(1);
  });

  it('malformed lines are silently skipped (non-string loci element)', () => {
    const badLine = JSON.stringify({
      ts: RECENT_TS,
      sessionId: 'bad-sess',
      turn: 1,
      repo: '/repo',
      signal: 'preexisting-sentence',
      category: 'failing-test',
      loci: [123], // number, not string — must be rejected
    });
    writeLedger([badLine, makeRecord({ sessionId: 'good-sess' })]);
    const result = aggregatePreexistingDefects({ days: 30, afkHome: tmpRoot });
    expect(result.totalRecords).toBe(1);
  });

  it('clusters distinct sessions for the same (repo, locus, signal)', () => {
    writeLedger([
      makeRecord({ sessionId: 'sess-1' }),
      makeRecord({ sessionId: 'sess-2' }),
      makeRecord({ sessionId: 'sess-3' }),
    ]);
    const result = aggregatePreexistingDefects({ days: 30, afkHome: tmpRoot });
    expect(result.totalRecords).toBe(3);
    expect(result.topClusters).toHaveLength(1);
    expect(result.topClusters[0]!.recurrenceCount).toBe(3);
  });
});
