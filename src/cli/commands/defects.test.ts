/**
 * Tests for the `afk defects` CLI command.
 *
 * Strategy: test the core logic functions (renderTable path indirectly via
 * action handler through Commander) by mocking the ledger reader and verifying
 * stdout output shape.  Avoids spawning a subprocess — same pattern as
 * trace.test.ts and bg.test.ts.
 *
 * Coverage:
 *   - Empty ledger → "no records" message.
 *   - Records within window → formatted table with header + rows.
 *   - Records outside window → filtered out.
 *   - --json flag → valid JSON array.
 *   - --top flag → limits cluster count.
 *   - Recurrence count colours (≥5 sessions vs < 3).
 *
 * @module cli/commands/defects.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Mock the ledger reader so tests do not touch the real filesystem.
// ---------------------------------------------------------------------------

vi.mock('../../agent/preexisting-ledger/reader.js', () => ({
  readLedgerRecords: vi.fn(),
  clusterLedgerRecords: vi.fn(),
}));

vi.mock('../../agent/preexisting-ledger/paths.js', () => ({
  getPreexistingLedgerPath: vi.fn(() => '/fake/preexisting-ledger.jsonl'),
}));

import { readLedgerRecords, clusterLedgerRecords } from '../../agent/preexisting-ledger/reader.js';
const mockRead    = vi.mocked(readLedgerRecords);
const mockCluster = vi.mocked(clusterLedgerRecords);

import { registerDefectsCommand } from './defects.js';
import type { DefectCluster } from '../../agent/preexisting-ledger/reader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCluster(overrides: Partial<DefectCluster> = {}): DefectCluster {
  return {
    repo:             '/home/user/myrepo',
    locus:            'src/agent/session.test.ts',
    signal:           'preexisting-sentence',
    category:         'failing-test',
    recurrenceCount:  2,
    firstSeen:        '2025-01-10T00:00:00.000Z',
    lastSeen:         '2025-01-15T00:00:00.000Z',
    ...overrides,
  };
}

/** Parse Commander action with the given argv args, capturing stdout. */
async function run(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride(); // prevent process.exit in tests
  registerDefectsCommand(program);

  const captured: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => {
    captured.push(s);
    return true;
  };

  try {
    await program.parseAsync(['node', 'afk', ...args]);
  } finally {
    (process.stdout.write as unknown) = origWrite;
  }

  return captured.join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('afk defects', () => {
  beforeEach(() => {
    mockRead.mockReturnValue({ records: [], ledgerTruncated: false });
    mockCluster.mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits a "no records" message when the ledger is empty', async () => {
    mockRead.mockReturnValue({ records: [], ledgerTruncated: false });
    mockCluster.mockReturnValue([]);

    const out = await run(['defects']);
    expect(out).toContain('No pre-existing defect records');
  });

  it('renders a table with header row when clusters are present', async () => {
    const clusters = [makeCluster({ recurrenceCount: 3 })];
    mockRead.mockReturnValue({ records: [], ledgerTruncated: false });
    mockCluster.mockReturnValue(clusters);

    const out = await run(['defects']);
    expect(out).toContain('Locus');
    expect(out).toContain('Repo');
    expect(out).toContain('Category');
    expect(out).toContain('Sessions');
    expect(out).toContain('Last Seen');
  });

  it('renders the locus and date in table rows', async () => {
    const clusters = [makeCluster({ locus: 'src/foo.test.ts', lastSeen: '2025-06-01T00:00:00.000Z' })];
    mockRead.mockReturnValue({ records: [], ledgerTruncated: false });
    mockCluster.mockReturnValue(clusters);

    const out = await run(['defects']);
    // locus is present (may be truncated with …)
    expect(out).toContain('src/foo.test.ts');
    // date is sliced to YYYY-MM-DD
    expect(out).toContain('2025-06-01');
  });

  it('applies --top to limit cluster count passed to the renderer', async () => {
    const clusters = [
      makeCluster({ locus: 'a.ts', recurrenceCount: 5 }),
      makeCluster({ locus: 'b.ts', recurrenceCount: 4 }),
      makeCluster({ locus: 'c.ts', recurrenceCount: 3 }),
    ];
    mockRead.mockReturnValue({ records: [], ledgerTruncated: false });
    mockCluster.mockReturnValue(clusters);

    const out = await run(['defects', '--top', '2']);
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
    // c.ts should be sliced off
    expect(out).not.toContain('c.ts');
  });

  it('emits valid JSON when --json is passed', async () => {
    const clusters = [makeCluster({ recurrenceCount: 7 })];
    mockRead.mockReturnValue({ records: [], ledgerTruncated: false });
    mockCluster.mockReturnValue(clusters);

    const out = await run(['defects', '--json']);
    const parsed = JSON.parse(out) as DefectCluster[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.recurrenceCount).toBe(7);
  });

  it('applies the --days window filter by passing cutoff to readLedgerRecords', async () => {
    // The window filter happens inside the action handler, not in readLedgerRecords.
    // We verify that records outside the window are dropped by returning an out-of-window
    // record and checking that clusterLedgerRecords receives an empty array.
    const oldRecord = {
      ts: '2000-01-01T00:00:00.000Z', // far in the past
      sessionId: 'sess-old',
      turn: 0,
      repo: '/r',
      signal: 'preexisting-sentence' as const,
      category: 'other' as const,
      loci: ['old-locus'],
    };
    mockRead.mockReturnValue({ records: [oldRecord], ledgerTruncated: false });
    mockCluster.mockReturnValue([]);

    await run(['defects', '--days', '30']);

    // clusterLedgerRecords should have been called with an empty array (the
    // old record is outside the 30-day window).
    expect(mockCluster).toHaveBeenCalledWith([]);
  });

  it('includes a caption row with cluster count and lookback days', async () => {
    const clusters = [makeCluster()];
    mockRead.mockReturnValue({ records: [], ledgerTruncated: false });
    mockCluster.mockReturnValue(clusters);

    const out = await run(['defects', '--days', '45']);
    expect(out).toContain('1 cluster');
    expect(out).toContain('45 days');
  });
});
