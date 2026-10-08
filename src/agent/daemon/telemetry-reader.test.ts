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
});
