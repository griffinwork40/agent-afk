import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readStreakHistory, readAllStreakHistories, emptyStreak,
  STREAK_HISTORY_BYTE_CAP, STREAK_HISTORY_BOUNDARY_LINE_CAP,
} from './scheduler.streak-history.js';
import { FailureStreakTracker } from './scheduler.failure-streak.js';
import type { TelemetryRecord } from './scheduler.js';
let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'streak-history-'));
  path = join(dir, 'telemetry.jsonl');
  vi.stubEnv('AFK_HOME', dir);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
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

  it.each([
    ['2026-01-03T00:00:00Z', true],
    ['2026-01-01T00:00:00Z', false],
    ['2026-01-02T00:00:00Z', false],
    [undefined, false],
    ['not-a-date', false],
    ['2026-02-30T00:00:00Z', false],
  ])('uses the lifetime boundary for an absent task created at %s', (createdAt, exact) => {
    const padding = row('success', 0, {
      taskId: 'other', triggeredAt: '2026-01-02T00:00:00Z', responseExcerpt: 'x'.repeat(1024),
    });
    write(Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () => padding));
    const parse = vi.spyOn(JSON, 'parse');
    expect(readStreakHistory(path, 't', createdAt)).toMatchObject({
      hasRuns: false, snapshot: { count: 0, exact },
    });
    expect(parse.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it.each([
    [{ triggeredAt: '2026-01-01T00:00:00Z', durationMs: 2 * 86400000 }, false],
    [{ triggeredAt: '2026-01-01T00:00:00Z', durationMs: undefined }, false],
    [{ triggeredAt: '2026-01-01T00:00:00Z', durationMs: -1 }, false],
    [{ triggeredAt: 'invalid', durationMs: 0 }, false],
    [{ recordType: 'notification-delivery', settledAt: '2026-01-03T00:00:00Z' }, false],
    [{ recordType: 'notification-delivery', settledAt: '2026-01-01T00:00:00Z' }, true],
  ])('uses completion/settlement rather than trigger time: %j', (extra, exact) => {
    const boundary = row('success', 0, {
      taskId: 'other', triggeredAt: '2025-01-01T00:00:00Z', responseExcerpt: 'x'.repeat(1024), ...extra,
    });
    write(Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () => boundary));
    expect(readStreakHistory(path, 't', '2026-01-02T00:00:00Z')).toMatchObject({
      hasRuns: false, snapshot: { exact },
    });
  });

  it.each([
    ['2026-01-03T00:00:00Z', true],
    ['2026-01-01T00:00:00Z', false],
  ])('skips poller ticks before a usable boundary for a task created at %s', (createdAt, exact) => {
    const tick = JSON.stringify({ surface: 'github-event-poller', timestamp: '2025-01-01T00:00:00Z' });
    const boundary = row('success', 0, {
      taskId: 'other', triggeredAt: '2026-01-01T00:00:00Z', durationMs: 86400000,
    });
    const ending = `${`${tick}\n`.repeat(4)}${JSON.stringify(boundary)}\n`;
    const prefix = `${'x'.repeat(STREAK_HISTORY_BYTE_CAP - Buffer.byteLength(ending))}\n`;
    writeFileSync(path, prefix + ending);
    expect(readStreakHistory(path, 't', createdAt)).toMatchObject({
      hasRuns: false, snapshot: { count: 0, exact },
    });
  });

  it('stays inexact when no examined line has a usable completion time', () => {
    const tick = JSON.stringify({ surface: 'github-event-poller', timestamp: '2025-01-01T00:00:00Z' });
    const missingDuration = JSON.stringify(row('success', 0, {
      taskId: 'other', triggeredAt: '2025-01-01T00:00:00Z', durationMs: undefined,
    }));
    const boundary = JSON.stringify(row('success', 0, {
      taskId: 'other', triggeredAt: '2025-01-01T00:00:00Z',
    }));
    const unusable = [tick, 'malformed', missingDuration];
    const lines = Array.from({ length: STREAK_HISTORY_BOUNDARY_LINE_CAP }, (_, n) => unusable[n % 3]);
    const ending = `${lines.join('\n')}\n${boundary}\n`;
    const prefix = `${'x'.repeat(STREAK_HISTORY_BYTE_CAP - Buffer.byteLength(ending))}\n`;
    writeFileSync(path, prefix + ending);
    const parse = vi.spyOn(JSON, 'parse');
    expect(readStreakHistory(path, 't', '2026-01-02T00:00:00Z')).toMatchObject({
      hasRuns: false, snapshot: { exact: false },
    });
    expect(parse.mock.calls.length).toBe(STREAK_HISTORY_BOUNDARY_LINE_CAP);
  });

  it('skips a malformed oldest line and uses the following run completion', () => {
    const later = row('success', 0, { taskId: 'other', triggeredAt: '2026-01-01T00:00:00Z' });
    const ending = `unparseable\n${JSON.stringify(later)}\n`;
    const prefix = `${'x'.repeat(STREAK_HISTORY_BYTE_CAP - Buffer.byteLength(ending))}\n`;
    writeFileSync(path, prefix + ending);
    expect(readStreakHistory(path, 't', '2026-01-02T00:00:00Z')).toMatchObject({
      hasRuns: false, snapshot: { exact: true },
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

describe('future createdAt guard', () => {
  it('returns inexact when createdAt is in the future, even though it is after the boundary', () => {
    // boundary row completes at 2026-01-02T00:00:00Z; createdAt is tomorrow (future)
    const future = new Date(Date.now() + 86400000).toISOString();
    const padding = row('success', 0, {
      taskId: 'other', triggeredAt: '2026-01-01T00:00:00Z', durationMs: 86400000,
      responseExcerpt: 'x'.repeat(1024),
    });
    write(Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () => padding));
    expect(readStreakHistory(path, 't', future)).toMatchObject({
      hasRuns: false, snapshot: { count: 0, exact: false },
    });
  });

  it('returns inexact when a backwards clock step makes createdAt appear after the boundary', () => {
    // Simulate: boundary at 2026-01-03, task createdAt at 2026-01-04 (> boundary) but we
    // pin Date.now() to 2026-01-02 so createdAt is "in the future" relative to now.
    const now = Date.parse('2026-01-02T00:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const padding = row('success', 0, {
      taskId: 'other', triggeredAt: '2026-01-02T12:00:00Z', durationMs: 0,
      responseExcerpt: 'x'.repeat(1024),
    });
    write(Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () => padding));
    // createdAt 2026-01-04 > boundary (2026-01-02T12:00:00Z) AND > now (2026-01-02) → inexact
    expect(readStreakHistory(path, 't', '2026-01-04T00:00:00Z')).toMatchObject({
      hasRuns: false, snapshot: { count: 0, exact: false },
    });
  });
});

describe('readAllStreakHistories', () => {
  it('returns an empty map for an empty task list', () => {
    expect(readAllStreakHistories(path, [])).toEqual(new Map());
  });

  it('reads multiple tasks in one pass and matches per-task readStreakHistory results', () => {
    const r2 = { ...row('error', 1), taskId: 'b' };
    write([row('success', 0), row('error', 1), r2]);
    const all = readAllStreakHistories(path, [{ id: 't' }, { id: 'b' }]);
    const single_t = readStreakHistory(path, 't');
    const single_b = readStreakHistory(path, 'b');
    expect(all.get('t')).toMatchObject({ hasRuns: single_t.hasRuns, snapshot: { count: single_t.snapshot.count, exact: single_t.snapshot.exact } });
    expect(all.get('b')).toMatchObject({ hasRuns: single_b.hasRuns, snapshot: { count: single_b.snapshot.count, exact: single_b.snapshot.exact } });
  });

  it('returns correct results for three tasks from a single file scan', () => {
    // 't' has an error, 'b' has an error, 'c' is absent — all resolved in one pass
    write([row('success', 0), row('error', 1), { ...row('error', 2), taskId: 'b' }]);
    const all = readAllStreakHistories(path, [{ id: 't' }, { id: 'b' }, { id: 'c' }]);
    expect(all.get('t')).toMatchObject({ hasRuns: true, snapshot: { count: 1, exact: true } });
    expect(all.get('b')).toMatchObject({ hasRuns: true, snapshot: { count: 1, exact: false } });
    // 'c' has no rows; file is small so stopAt===0, no cap truncation → exact empty
    expect(all.get('c')).toMatchObject({ hasRuns: false, snapshot: { count: 0, exact: true } });
  });

  it('returns exact empty for a task absent in a window that covers its lifetime', () => {
    const padding = row('success', 0, {
      taskId: 'other', triggeredAt: '2026-01-01T00:00:00Z', durationMs: 0,
      responseExcerpt: 'x'.repeat(1024),
    });
    write(Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () => padding));
    const all = readAllStreakHistories(path, [{ id: 't', createdAt: '2026-01-02T00:00:00Z' }]);
    expect(all.get('t')).toMatchObject({ hasRuns: false, snapshot: { count: 0, exact: true } });
  });

  it('returns inexact for an absent task with a future createdAt even when boundary is older', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const padding = row('success', 0, {
      taskId: 'other', triggeredAt: '2026-01-01T00:00:00Z', durationMs: 0,
      responseExcerpt: 'x'.repeat(1024),
    });
    write(Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () => padding));
    const all = readAllStreakHistories(path, [{ id: 't', createdAt: future }]);
    expect(all.get('t')).toMatchObject({ hasRuns: false, snapshot: { count: 0, exact: false } });
  });

  it('returns exact empty for a missing file', () => {
    const all = readAllStreakHistories(path, [{ id: 't' }, { id: 'b' }]);
    expect(all.get('t')).toMatchObject({ hasRuns: false, snapshot: { exact: true } });
    expect(all.get('b')).toMatchObject({ hasRuns: false, snapshot: { exact: true } });
  });
});
