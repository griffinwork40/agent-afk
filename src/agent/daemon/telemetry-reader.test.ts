/**
 * Unit tests for src/agent/daemon/telemetry-reader.ts
 *
 * Covers:
 *   - ENOENT → empty array
 *   - Empty file → empty array
 *   - taskId filtering
 *   - limit enforcement
 *   - chronological order (oldest first)
 *   - tailBytes I/O bound
 *   - malformed line skipping
 *   - multiple tasks interleaved
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readTelemetryHistory,
  DEFAULT_TAIL_BYTES,
  DEFAULT_HISTORY_LIMIT,
} from './telemetry-reader.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-afk-telemetry-reader-'));
}

function makeRecord(taskId: string, triggeredAt: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ taskId, triggeredAt, ...extra });
}

describe('readTelemetryHistory', () => {
  let dir: string;
  let telemetryPath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── ENOENT ────────────────────────────────────────────────────────────────

  it('returns [] when the file does not exist', async () => {
    const result = await readTelemetryHistory(telemetryPath, { taskId: 'any' });
    expect(result).toEqual([]);
  });

  // ── Empty file ─────────────────────────────────────────────────────────────

  it('returns [] for an empty file', async () => {
    writeFileSync(telemetryPath, '');
    const result = await readTelemetryHistory(telemetryPath, { taskId: 'any' });
    expect(result).toEqual([]);
  });

  // ── taskId filtering ───────────────────────────────────────────────────────

  it('returns [] when no records match the taskId', async () => {
    writeFileSync(
      telemetryPath,
      makeRecord('other-task', '2026-01-01T00:00:00Z') + '\n',
    );
    const result = await readTelemetryHistory(telemetryPath, { taskId: 'missing' });
    expect(result).toEqual([]);
  });

  it('returns only records matching the taskId', async () => {
    const lines = [
      makeRecord('task-a', '2026-01-01T00:00:00Z'),
      makeRecord('task-b', '2026-01-02T00:00:00Z'),
      makeRecord('task-a', '2026-01-03T00:00:00Z'),
    ].join('\n') + '\n';
    writeFileSync(telemetryPath, lines);

    const result = await readTelemetryHistory(telemetryPath, { taskId: 'task-a' });
    expect(result).toHaveLength(2);
    expect((result[0] as Record<string, unknown>)['triggeredAt']).toBe('2026-01-01T00:00:00Z');
    expect((result[1] as Record<string, unknown>)['triggeredAt']).toBe('2026-01-03T00:00:00Z');
  });

  // ── Chronological order ────────────────────────────────────────────────────

  it('returns records in chronological order (oldest first)', async () => {
    const lines = [
      makeRecord('t', '2026-01-01T00:00:00Z'),
      makeRecord('t', '2026-01-02T00:00:00Z'),
      makeRecord('t', '2026-01-03T00:00:00Z'),
    ].join('\n') + '\n';
    writeFileSync(telemetryPath, lines);

    const result = await readTelemetryHistory(telemetryPath, { taskId: 't', limit: 10 });
    const dates = (result as Array<Record<string, unknown>>).map((r) => r['triggeredAt']);
    expect(dates).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
      '2026-01-03T00:00:00Z',
    ]);
  });

  // ── Limit enforcement ──────────────────────────────────────────────────────

  it('respects the limit option (returns at most N records)', async () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      makeRecord('t', `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    ).join('\n') + '\n';
    writeFileSync(telemetryPath, lines);

    const result = await readTelemetryHistory(telemetryPath, { taskId: 't', limit: 5 });
    expect(result).toHaveLength(5);
  });

  it('uses DEFAULT_HISTORY_LIMIT when limit is omitted', async () => {
    const lines = Array.from({ length: 15 }, (_, i) =>
      makeRecord('t', `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    ).join('\n') + '\n';
    writeFileSync(telemetryPath, lines);

    const result = await readTelemetryHistory(telemetryPath, { taskId: 't' });
    expect(result).toHaveLength(DEFAULT_HISTORY_LIMIT);
  });

  // ── Tail bound ─────────────────────────────────────────────────────────────

  it('reads only the tail when tailBytes is smaller than the file', async () => {
    // Write 5 records; only the last 2 fit in the tail window.
    // We set tailBytes small enough to exclude the first records.
    const records = [
      makeRecord('t', '2026-01-01T00:00:00Z', { payload: 'early' }),
      makeRecord('t', '2026-01-02T00:00:00Z', { payload: 'early' }),
      makeRecord('t', '2026-01-03T00:00:00Z', { payload: 'early' }),
      makeRecord('t', '2026-01-04T00:00:00Z', { payload: 'visible' }),
      makeRecord('t', '2026-01-05T00:00:00Z', { payload: 'visible' }),
    ];
    const content = records.join('\n') + '\n';
    writeFileSync(telemetryPath, content);

    // Calculate bytes for just the last 2 records.
    const lastTwo = records.slice(3).join('\n') + '\n';
    const tailBytes = lastTwo.length;

    const result = await readTelemetryHistory(telemetryPath, {
      taskId: 't',
      limit: 10,
      tailBytes,
    });
    // Only the two records within the tail window should be returned.
    // (The first line of the tail may be a truncated fragment and is skipped.)
    const dates = (result as Array<Record<string, unknown>>).map((r) => r['triggeredAt']);
    expect(dates.every((d) => ['2026-01-04T00:00:00Z', '2026-01-05T00:00:00Z'].includes(d as string))).toBe(true);
  });

  it('exports DEFAULT_TAIL_BYTES as 1 MiB', () => {
    expect(DEFAULT_TAIL_BYTES).toBe(1_048_576);
  });

  // ── Malformed lines ────────────────────────────────────────────────────────

  it('skips malformed lines silently', async () => {
    const content = [
      makeRecord('t', '2026-01-01T00:00:00Z'),
      'NOT_JSON',
      makeRecord('t', '2026-01-02T00:00:00Z'),
    ].join('\n') + '\n';
    writeFileSync(telemetryPath, content);

    const result = await readTelemetryHistory(telemetryPath, { taskId: 't', limit: 10 });
    expect(result).toHaveLength(2);
  });

  // ── Multiple tasks interleaved ─────────────────────────────────────────────

  it('handles multiple tasks interleaved correctly', async () => {
    const content = [
      makeRecord('alpha', '2026-01-01T00:00:00Z'),
      makeRecord('beta',  '2026-01-02T00:00:00Z'),
      makeRecord('alpha', '2026-01-03T00:00:00Z'),
      makeRecord('gamma', '2026-01-04T00:00:00Z'),
      makeRecord('beta',  '2026-01-05T00:00:00Z'),
    ].join('\n') + '\n';
    writeFileSync(telemetryPath, content);

    const alphaResult = await readTelemetryHistory(telemetryPath, { taskId: 'alpha', limit: 10 });
    expect(alphaResult).toHaveLength(2);

    const betaResult = await readTelemetryHistory(telemetryPath, { taskId: 'beta', limit: 10 });
    expect(betaResult).toHaveLength(2);

    const gammaResult = await readTelemetryHistory(telemetryPath, { taskId: 'gamma', limit: 10 });
    expect(gammaResult).toHaveLength(1);
  });

  // ── Limit returns most recent N (newest last in tail = still correct) ──────

  it('when limited, returns the N most recent records in chronological order', async () => {
    // 5 records exist, limit=3 should return the last 3
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord('t', `2026-01-0${i + 1}T00:00:00Z`),
    );
    writeFileSync(telemetryPath, records.join('\n') + '\n');

    const result = await readTelemetryHistory(telemetryPath, { taskId: 't', limit: 3 });
    expect(result).toHaveLength(3);
    const dates = (result as Array<Record<string, unknown>>).map((r) => r['triggeredAt']);
    // Should be the 3 most recent records, chronological order
    expect(dates).toEqual([
      '2026-01-03T00:00:00Z',
      '2026-01-04T00:00:00Z',
      '2026-01-05T00:00:00Z',
    ]);
  });

  // ── Blank lines ───────────────────────────────────────────────────────────

  it('skips blank lines', async () => {
    const content = makeRecord('t', '2026-01-01T00:00:00Z') + '\n\n' +
      makeRecord('t', '2026-01-02T00:00:00Z') + '\n';
    writeFileSync(telemetryPath, content);

    const result = await readTelemetryHistory(telemetryPath, { taskId: 't', limit: 10 });
    expect(result).toHaveLength(2);
  });

  // ── Short-read resilience (POSIX) ─────────────────────────────────────────

  it('accumulates all bytes when file size exceeds a small tailBytes window via multiple reads', async () => {
    // Write a large batch of records so the file is big.
    // Then pass a tailBytes that is still large enough to capture the last N
    // but force the I/O loop to exercise the accumulation path by verifying
    // the correct records are present even when tailBytes < fileSize.
    const records = Array.from({ length: 30 }, (_, i) =>
      makeRecord('t', `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    );
    writeFileSync(telemetryPath, records.join('\n') + '\n');

    // tailBytes large enough to include only the last 10 records.
    const lastTen = records.slice(20).join('\n') + '\n';
    const tailBytes = lastTen.length + 10; // slight margin so a leading-line truncation doesn't hide records

    const result = await readTelemetryHistory(telemetryPath, {
      taskId: 't',
      limit: 10,
      tailBytes,
    });
    // All returned dates should be from the last 10 records.
    const dates = (result as Array<Record<string, unknown>>).map((r) => r['triggeredAt'] as string);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => {
      const day = parseInt(d.slice(8, 10), 10);
      return day >= 21;
    })).toBe(true);
  });

  it('reads full content correctly across large files (accumulation correctness)', async () => {
    // Construct a file where records span many kilobytes.
    // If the read loop does NOT accumulate, some records will be silently dropped.
    const bigPayload = 'x'.repeat(200);
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord('t', `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, { pad: bigPayload }),
    );
    writeFileSync(telemetryPath, records.join('\n') + '\n');

    const result = await readTelemetryHistory(telemetryPath, { taskId: 't', limit: 10 });
    // All 10 records should survive regardless of internal chunking.
    expect(result).toHaveLength(10);
  });

  // ── Explicit first-line discard ───────────────────────────────────────────

  it('discards the truncated first line when the tail seek lands mid-line', async () => {
    // Build a file with three records separated by '\n'.
    // We choose tailBytes so that readStart falls *inside* the first record
    // (the byte at readStart-1 is NOT '\n'), so the first element in the
    // parsed lines array is a partial JSON fragment and must be dropped.
    const rec1 = makeRecord('t', '2026-01-01T00:00:00Z');
    const rec2 = makeRecord('t', '2026-01-02T00:00:00Z');
    const rec3 = makeRecord('t', '2026-01-03T00:00:00Z');
    const content = `${rec1}\n${rec2}\n${rec3}\n`;
    writeFileSync(telemetryPath, content);

    // Set tailBytes to include rec2 and rec3 fully, but start mid-way through
    // rec1 so the first byte of our read window is inside rec1.  We do this
    // by setting readStart to (1 byte before the '\n' after rec1), which is
    // guaranteed to be inside rec1 (not on a boundary).
    //
    // File layout: [rec1]\n[rec2]\n[rec3]\n
    //                       ^--- we want readStart here (start of rec2)
    // That position has '\n' at readStart-1, which would be a boundary case.
    // Instead, place readStart one byte further into rec2 so the byte before
    // it is the first byte of rec2 (definitely not '\n').
    const rec1WithNewline = `${rec1}\n`;
    const midRec2Offset = rec1WithNewline.length + 1; // 1 byte into rec2
    const tailBytes = content.length - midRec2Offset;

    const result = await readTelemetryHistory(telemetryPath, {
      taskId: 't',
      limit: 10,
      tailBytes,
    });

    // rec3 must be present. The truncated fragment of rec2 must be dropped
    // (it is not valid JSON), but rec3 is intact and parseable.
    const dates = (result as Array<Record<string, unknown>>).map((r) => r['triggeredAt']);
    expect(dates).not.toContain('2026-01-01T00:00:00Z'); // rec1 outside window
    expect(dates).toContain('2026-01-03T00:00:00Z');     // rec3 always intact
    // The truncated fragment of rec2 is invalid JSON and is silently skipped;
    // rec2's full record is NOT in the window so it cannot appear.
    expect(dates).not.toContain('2026-01-02T00:00:00Z');
  });

  it('keeps the complete first record when the tail seek lands exactly on a line boundary', async () => {
    // Build a file with three records.
    // We choose tailBytes so that readStart is exactly at the start of rec2
    // (the byte at readStart-1 is '\n'), meaning the seek landed on a boundary
    // and the first element of the parsed lines is a complete record.
    const rec1 = makeRecord('t', '2026-01-01T00:00:00Z');
    const rec2 = makeRecord('t', '2026-01-02T00:00:00Z');
    const rec3 = makeRecord('t', '2026-01-03T00:00:00Z');
    const content = `${rec1}\n${rec2}\n${rec3}\n`;
    writeFileSync(telemetryPath, content);

    // readStart will be at the first byte of rec2 (byte after the '\n' that
    // terminates rec1).  tailBytes = content.length - readStart.
    const readStart = Buffer.byteLength(`${rec1}\n`, 'utf8');
    const tailBytes = Buffer.byteLength(content, 'utf8') - readStart;

    const result = await readTelemetryHistory(telemetryPath, {
      taskId: 't',
      limit: 10,
      tailBytes,
    });

    // Both rec2 and rec3 must be returned: the first line (rec2) is complete
    // because the seek landed exactly on a newline boundary.
    const dates = (result as Array<Record<string, unknown>>).map((r) => r['triggeredAt']);
    expect(dates).toContain('2026-01-02T00:00:00Z'); // complete first record kept
    expect(dates).toContain('2026-01-03T00:00:00Z'); // subsequent record kept
    expect(dates).not.toContain('2026-01-01T00:00:00Z'); // rec1 outside window
  });
});
