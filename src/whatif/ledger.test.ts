/**
 * Tests for `src/whatif/ledger.ts`.
 *
 * Uses tmp paths; never touches the real ~/.afk/state/whatif/ledger.jsonl.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendCalibration, trackRecordSummary } from './ledger.js';
import type { CalibrationRecord } from './ledger.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRecord(
  verdict: 'confirmed' | 'refuted' | 'unclear',
  changeKinds: string[],
  delta = 0.2,
): CalibrationRecord {
  return {
    ts: new Date().toISOString(),
    changeKinds,
    prediction: {
      id: 'p1',
      behavior: 'test behavior',
      direction: 'strengthened',
      confidence: 'medium',
      reason: 'reason',
      testQuestion: 'Does X?',
      probes: [],
    },
    verdict,
    delta,
  };
}

let tmpDir: string;
let ledgerFile: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'whatif-ledger-test-'));
  ledgerFile = path.join(tmpDir, 'ledger.jsonl');
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// appendCalibration
// ---------------------------------------------------------------------------

describe('appendCalibration', () => {
  it('creates the file and appends records', async () => {
    const rec = makeRecord('confirmed', ['memory-add']);
    await appendCalibration([rec], ledgerFile);

    const raw = await fsp.readFile(ledgerFile, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.verdict).toBe('confirmed');
    expect(parsed.changeKinds).toEqual(['memory-add']);
  });

  it('appends to existing file', async () => {
    await appendCalibration([makeRecord('confirmed', ['append'])], ledgerFile);
    await appendCalibration([makeRecord('refuted', ['append'])], ledgerFile);

    const raw = await fsp.readFile(ledgerFile, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('is a no-op for empty records array', async () => {
    await appendCalibration([], ledgerFile);
    const exists = await fsp.access(ledgerFile).then(() => true).catch(() => false);
    // File should not be created for empty records.
    expect(exists).toBe(false);
  });

  it('creates missing directories', async () => {
    const nestedFile = path.join(tmpDir, 'nested', 'deep', 'ledger.jsonl');
    await appendCalibration([makeRecord('confirmed', ['model'])], nestedFile);
    const raw = await fsp.readFile(nestedFile, 'utf8');
    expect(raw.trim().length).toBeGreaterThan(0);
  });

  it('multiple records written as separate NDJSON lines', async () => {
    const recs = [
      makeRecord('confirmed', ['memory-add'], 0.3),
      makeRecord('refuted', ['memory-add'], -0.1),
      makeRecord('unclear', ['env'], 0.02),
    ];
    await appendCalibration(recs, ledgerFile);
    const raw = await fsp.readFile(ledgerFile, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// trackRecordSummary
// ---------------------------------------------------------------------------

describe('trackRecordSummary', () => {
  it('returns undefined for missing file', async () => {
    const result = await trackRecordSummary(['memory-add'], ledgerFile);
    expect(result).toBeUndefined();
  });

  it('returns undefined when no change kind qualifies (< 3 records)', async () => {
    await appendCalibration(
      [
        makeRecord('confirmed', ['memory-add']),
        makeRecord('refuted', ['memory-add']),
      ],
      ledgerFile,
    );
    const result = await trackRecordSummary(['memory-add'], ledgerFile);
    expect(result).toBeUndefined();
  });

  it('returns summary when >= 3 resolved records for the kind', async () => {
    // 4 confirmed + 6 refuted = 10 total for memory-add
    const recs: CalibrationRecord[] = [];
    for (let i = 0; i < 4; i++) recs.push(makeRecord('confirmed', ['memory-add']));
    for (let i = 0; i < 6; i++) recs.push(makeRecord('refuted', ['memory-add']));
    await appendCalibration(recs, ledgerFile);

    const result = await trackRecordSummary(['memory-add'], ledgerFile);
    expect(result).not.toBeUndefined();
    expect(result).toContain('memory-add');
    expect(result).toContain('4 of 10');
    expect(result).toContain('40%');
  });

  it('excludes unclear verdicts from counts', async () => {
    const recs: CalibrationRecord[] = [];
    for (let i = 0; i < 3; i++) recs.push(makeRecord('confirmed', ['append']));
    for (let i = 0; i < 5; i++) recs.push(makeRecord('unclear', ['append']));
    await appendCalibration(recs, ledgerFile);

    const result = await trackRecordSummary(['append'], ledgerFile);
    expect(result).not.toBeUndefined();
    // 3 confirmed, 0 refuted → 3 of 3 (100%)
    expect(result).toContain('3 of 3');
    expect(result).toContain('100%');
  });

  it('only includes change kinds in the provided set', async () => {
    const recs: CalibrationRecord[] = [];
    for (let i = 0; i < 5; i++) recs.push(makeRecord('confirmed', ['model']));
    for (let i = 0; i < 5; i++) recs.push(makeRecord('confirmed', ['memory-add']));
    await appendCalibration(recs, ledgerFile);

    // Only ask for 'model'
    const result = await trackRecordSummary(['model'], ledgerFile);
    expect(result).not.toBeUndefined();
    expect(result).toContain('model');
    expect(result).not.toContain('memory-add');
  });

  it('returns undefined when the qualifying kinds are not in the provided set', async () => {
    const recs: CalibrationRecord[] = [];
    for (let i = 0; i < 5; i++) recs.push(makeRecord('confirmed', ['model']));
    await appendCalibration(recs, ledgerFile);

    const result = await trackRecordSummary(['memory-add'], ledgerFile);
    expect(result).toBeUndefined();
  });
});
