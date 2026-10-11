/**
 * Tests for the pre-existing-defect ledger reader and cluster module.
 *
 * Covers:
 *   - readLedgerRecords: empty when ledger absent.
 *   - readLedgerRecords: skips malformed lines, returns valid records.
 *   - readLedgerRecords: ledgerTruncated=false for small files.
 *   - readLedgerRecords: ledgerTruncated=true when file exceeds 1 MB cap.
 *   - clusterLedgerRecords: groups by (repo, locus, signal), counts distinct sessions.
 *   - clusterLedgerRecords: tracks firstSeen / lastSeen correctly.
 *   - clusterLedgerRecords: ranks by descending recurrenceCount, then lastSeen.
 *   - clusterLedgerRecords: expands multi-locus records into separate cluster entries.
 *   - clusterLedgerRecords: empty input returns empty array.
 *
 * @module agent/preexisting-ledger/reader.test
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock paths so getPreexistingLedgerPath points to our temp file.
vi.mock('./paths.js', () => ({
  getPreexistingLedgerPath: vi.fn(),
  getPreexistingBackfillPath: vi.fn(),
}));

import { getPreexistingLedgerPath } from './paths.js';
const mockLedgerPath = vi.mocked(getPreexistingLedgerPath);

import { readLedgerRecords, clusterLedgerRecords, LEDGER_READ_LIMIT } from './reader.js';

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'afk-reader-test-'));
  return dir;
}

function record(
  overrides: Partial<{
    ts: string;
    sessionId: string;
    repo: string;
    signal: string;
    category: string;
    loci: string[];
    turn: number;
  }> = {},
): string {
  return JSON.stringify({
    ts: '2025-01-15T10:00:00.000Z',
    sessionId: 'sess-a',
    turn: 0,
    repo: '/home/user/myrepo',
    signal: 'preexisting-sentence',
    category: 'failing-test',
    loci: ['src/foo.test.ts'],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// readLedgerRecords
// ---------------------------------------------------------------------------

describe('readLedgerRecords', () => {
  beforeEach(() => {
    mockLedgerPath.mockReset();
  });

  it('returns empty records with ledgerTruncated=false when ledger file does not exist', () => {
    mockLedgerPath.mockReturnValue('/nonexistent/path/preexisting-ledger.jsonl');
    const result = readLedgerRecords();
    expect(result.records).toEqual([]);
    expect(result.ledgerTruncated).toBe(false);
  });

  it('parses valid records from a fixture ledger and reports ledgerTruncated=false', () => {
    const dir = makeTempDir();
    const ledgerPath = join(dir, 'preexisting-ledger.jsonl');
    writeFileSync(
      ledgerPath,
      [
        record({ sessionId: 'sess-a', loci: ['src/agent/session.test.ts'] }),
        record({ sessionId: 'sess-b', loci: ['src/agent/session.test.ts'] }),
      ].join('\n') + '\n',
      'utf8',
    );
    mockLedgerPath.mockReturnValue(ledgerPath);
    const { records, ledgerTruncated } = readLedgerRecords();
    expect(records).toHaveLength(2);
    expect(records[0]!.sessionId).toBe('sess-a');
    expect(records[1]!.sessionId).toBe('sess-b');
    expect(ledgerTruncated).toBe(false);
  });

  it('skips malformed lines without throwing', () => {
    const dir = makeTempDir();
    const ledgerPath = join(dir, 'preexisting-ledger.jsonl');
    writeFileSync(
      ledgerPath,
      [
        'not valid json {{{',
        record({ sessionId: 'sess-good' }),
        '{"ts":"2025-01-01","missing_sessionId":true}', // fails type guard
        '',
      ].join('\n'),
      'utf8',
    );
    mockLedgerPath.mockReturnValue(ledgerPath);
    const { records } = readLedgerRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe('sess-good');
  });

  it('returns empty records with ledgerTruncated=false for an empty ledger file', () => {
    const dir = makeTempDir();
    const ledgerPath = join(dir, 'preexisting-ledger.jsonl');
    writeFileSync(ledgerPath, '', 'utf8');
    mockLedgerPath.mockReturnValue(ledgerPath);
    const result = readLedgerRecords();
    expect(result.records).toEqual([]);
    expect(result.ledgerTruncated).toBe(false);
  });

  it('reports ledgerTruncated=true when the file exceeds the 1 MB cap', () => {
    const dir = makeTempDir();
    const ledgerPath = join(dir, 'preexisting-ledger.jsonl');
    // Write >1 MB of valid records so the reader must tail-cap.
    const line = record({ sessionId: 'sess-trunc' }) + '\n';
    const repetitions = Math.ceil((LEDGER_READ_LIMIT + line.length + 1) / line.length);
    writeFileSync(ledgerPath, line.repeat(repetitions), 'utf8');
    mockLedgerPath.mockReturnValue(ledgerPath);
    const { records, ledgerTruncated } = readLedgerRecords();
    expect(ledgerTruncated).toBe(true);
    // All returned records should still be valid (complete lines only).
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.sessionId === 'sess-trunc')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clusterLedgerRecords
// ---------------------------------------------------------------------------

describe('clusterLedgerRecords', () => {
  it('returns empty array for empty input', () => {
    expect(clusterLedgerRecords([])).toEqual([]);
  });

  it('groups records by (repo, locus, signal) and counts distinct sessions', () => {
    const records = [
      { ts: '2025-01-10T00:00:00.000Z', sessionId: 'sess-a', turn: 0, repo: '/repo', signal: 'preexisting-sentence', category: 'failing-test', loci: ['src/a.test.ts'] },
      { ts: '2025-01-11T00:00:00.000Z', sessionId: 'sess-b', turn: 0, repo: '/repo', signal: 'preexisting-sentence', category: 'failing-test', loci: ['src/a.test.ts'] },
      { ts: '2025-01-12T00:00:00.000Z', sessionId: 'sess-a', turn: 1, repo: '/repo', signal: 'preexisting-sentence', category: 'failing-test', loci: ['src/a.test.ts'] }, // same session, different turn — NOT a new session
    ];
    const clusters = clusterLedgerRecords(records);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.locus).toBe('src/a.test.ts');
    expect(clusters[0]!.recurrenceCount).toBe(2); // 2 distinct sessions
  });

  it('tracks firstSeen and lastSeen correctly', () => {
    const records = [
      { ts: '2025-01-10T00:00:00.000Z', sessionId: 'sess-a', turn: 0, repo: '/repo', signal: 'preexisting-sentence', category: 'gate', loci: ['audit:filesize:check'] },
      { ts: '2025-01-15T00:00:00.000Z', sessionId: 'sess-b', turn: 0, repo: '/repo', signal: 'preexisting-sentence', category: 'gate', loci: ['audit:filesize:check'] },
      { ts: '2025-01-08T00:00:00.000Z', sessionId: 'sess-c', turn: 0, repo: '/repo', signal: 'preexisting-sentence', category: 'gate', loci: ['audit:filesize:check'] },
    ];
    const clusters = clusterLedgerRecords(records);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.firstSeen).toBe('2025-01-08T00:00:00.000Z');
    expect(clusters[0]!.lastSeen).toBe('2025-01-15T00:00:00.000Z');
    expect(clusters[0]!.recurrenceCount).toBe(3);
  });

  it('ranks by descending recurrenceCount', () => {
    const records = [
      { ts: '2025-01-01T00:00:00.000Z', sessionId: 'sess-a', turn: 0, repo: '/r', signal: 'preexisting-sentence', category: 'other', loci: ['rare-locus'] },
      { ts: '2025-01-01T00:00:00.000Z', sessionId: 'sess-a', turn: 0, repo: '/r', signal: 'preexisting-sentence', category: 'other', loci: ['common-locus'] },
      { ts: '2025-01-02T00:00:00.000Z', sessionId: 'sess-b', turn: 0, repo: '/r', signal: 'preexisting-sentence', category: 'other', loci: ['common-locus'] },
      { ts: '2025-01-03T00:00:00.000Z', sessionId: 'sess-c', turn: 0, repo: '/r', signal: 'preexisting-sentence', category: 'other', loci: ['common-locus'] },
    ];
    const clusters = clusterLedgerRecords(records);
    expect(clusters[0]!.locus).toBe('common-locus');
    expect(clusters[0]!.recurrenceCount).toBe(3);
    expect(clusters[1]!.locus).toBe('rare-locus');
    expect(clusters[1]!.recurrenceCount).toBe(1);
  });

  it('expands multi-locus records into separate cluster entries per locus', () => {
    const records = [
      { ts: '2025-01-01T00:00:00.000Z', sessionId: 'sess-a', turn: 0, repo: '/r', signal: 'preexisting-sentence', category: 'failing-test', loci: ['src/a.test.ts', 'src/b.test.ts'] },
    ];
    const clusters = clusterLedgerRecords(records);
    expect(clusters).toHaveLength(2);
    const loci = clusters.map((c) => c.locus).sort();
    expect(loci).toEqual(['src/a.test.ts', 'src/b.test.ts'].sort());
  });

  it('treats same locus under different signals as distinct clusters', () => {
    const records = [
      { ts: '2025-01-01T00:00:00.000Z', sessionId: 'sess-a', turn: 0, repo: '/r', signal: 'preexisting-sentence', category: 'other', loci: ['some-module'] },
      { ts: '2025-01-01T00:00:00.000Z', sessionId: 'sess-b', turn: 0, repo: '/r', signal: 'deferred-bullet', category: 'other', loci: ['some-module'] },
    ];
    const clusters = clusterLedgerRecords(records);
    expect(clusters).toHaveLength(2);
    const signals = clusters.map((c) => c.signal).sort();
    expect(signals).toEqual(['deferred-bullet', 'preexisting-sentence'].sort());
  });
});
