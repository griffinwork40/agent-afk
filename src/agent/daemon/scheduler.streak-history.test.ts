import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readStreakHistory, emptyStreak, STREAK_HISTORY_BYTE_CAP } from './scheduler.streak-history.js';
import { FailureStreakTracker } from './scheduler.failure-streak.js';
import type { TelemetryRecord } from './scheduler.js';
let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'streak-history-')); path = join(dir, 'telemetry.jsonl'); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
function row(status: TelemetryRecord['status'], n: number, extra: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return { taskId: 't', command: 'x', trigger: 'cron', status, triggeredAt: `date-${n}`, durationMs: 0, ...extra };
}
function write(rows: unknown[]): void { writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); }
describe('streak hydration and legacy fallback', () => {
  it('caps legacy replay and returns a lower bound without reading the old success', () => {
    const padding = row('success', 0, { taskId: 'other', responseExcerpt: 'x'.repeat(1024) });
    write([
      row('success', 0),
      ...Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () => padding),
      row('error', 1),
      row('blocked', 2),
    ]);
    expect(readStreakHistory(path, 't')).toMatchObject({
      hasRuns: true,
      lastStatus: 'blocked',
      snapshot: { count: 2, failingSince: 'date-1', exact: false },
    });
  });

  it('reports no known recent history when the only matching row is beyond the cap', () => {
    write([
      row('success', 0),
      ...Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () =>
        row('error', 1, { taskId: 'other', responseExcerpt: 'x'.repeat(1024) })),
    ]);
    expect(readStreakHistory(path, 't')).toMatchObject({
      hasRuns: false,
      snapshot: { count: 0, exact: false },
    });
  });

  it('does not JSON-parse unrelated rows in a large file', () => {
    const unrelated = JSON.stringify(row('error', 0, { taskId: 'other', responseExcerpt: 'x'.repeat(1024) }));
    writeFileSync(path, `${unrelated}\n`.repeat(Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024)));
    const parse = vi.spyOn(JSON, 'parse');
    const history = readStreakHistory(path, 'unrelated-task');
    const calls = parse.mock.calls.length;
    parse.mockRestore();
    expect(calls).toBe(0);
    expect(history).toMatchObject({ hasRuns: false, snapshot: { exact: false } });
  });

  it('does not parse an incomplete oldest line when the cap splits a matching row', () => {
    write([row('error', 1, { errorMessage: 'x'.repeat(STREAK_HISTORY_BYTE_CAP) }), row('error', 2)]);
    const parse = vi.spyOn(JSON, 'parse');
    const history = readStreakHistory(path, 't');
    const calls = parse.mock.calls.length;
    parse.mockRestore();
    expect(calls).toBe(1);
    expect(history.snapshot).toMatchObject({ count: 1, failingSince: 'date-2', exact: false });
  });

  it('uses legacy escalation markers, not today\'s threshold, across restart', () => {
    write([row('success', 0), row('error', 1), row('error', 2, { notifySent: 'escalation' }), row('skipped', 3), row('blocked', 4)]);
    const s = readStreakHistory(path, 't').snapshot;
    expect(s).toMatchObject({ count: 3, failingSince: 'date-1', escalated: true, extraFailures: 1, exact: true });
    const tracker = new FailureStreakTracker(); tracker.hydrate('t', path);
    expect(tracker.record('t', undefined, row('success', 5), 100).action).toBe('recover');
  });
  it('does not infer escalation for unmarked legacy failures even above current threshold', () => {
    write([row('success', 0), row('error', 1), row('error', 2)]);
    const tracker = new FailureStreakTracker(); tracker.hydrate('t', path);
    expect(tracker.record('t', undefined, row('error', 3), 1).action).toBe('escalate');
  });
  it('restores re-escalation timing from a snapshot and carries it through skips', () => {
    write([row('skipped', 12, { failureStreak: { ...emptyStreak(), count: 12, failingSince: 'start', escalated: true, extraFailures: 9 } })]);
    const tracker = new FailureStreakTracker(); tracker.hydrate('t', path);
    expect(tracker.record('t', undefined, row('skipped', 13)).action).toBe('none');
    expect(tracker.record('t', undefined, row('error', 14)).action).toBe('re-escalate');
    expect(tracker.snapshot('t')).toMatchObject({ count: 13, failingSince: 'start', extraFailures: 10 });
  });
  it('caches hydration even when no streak exists', () => {
    const tracker = new FailureStreakTracker(); tracker.hydrate('t', path);
    write([row('error', 1)]); tracker.hydrate('t', path);
    expect(tracker.snapshot('t').count).toBe(0);
  });
  it('keeps legacy history without a success boundary a lower bound', () => {
    write([row('error', 1), row('skipped', 2)]);
    expect(readStreakHistory(path, 't').snapshot).toMatchObject({ count: 1, failingSince: 'date-1', exact: false });
  });
  it('reassembles UTF-8 and JSON lines across chunk boundaries', () => {
    write([row('success', 0), row('error', 1, { errorMessage: '🧪'.repeat(20000) }), row('error', 2)]);
    const s = readStreakHistory(path, 't').snapshot;
    expect(s.count).toBe(2); expect(s.exact).toBe(true); expect(s.lastError).toBe('🧪'.repeat(20000));
  });
});
