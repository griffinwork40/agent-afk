import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { addSchedule, loadSchedules } from '../../agent/daemon/schedule-store.js';
import { getSchedulesPath, getTelemetryPath } from '../../paths.js';
import { registerScheduleCommand } from './schedule.js';
import { emptyStreak, STREAK_HISTORY_BYTE_CAP } from '../../agent/daemon/scheduler.streak-history.js';
let dir: string;
let log: ReturnType<typeof vi.spyOn>;
let oldExit: typeof process.exitCode;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'schedule-health-'));
  vi.stubEnv('AFK_HOME', dir);
  mkdirSync(join(dir, 'agent-framework'), { recursive: true });
  oldExit = process.exitCode;
  process.exitCode = undefined;
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { process.exitCode = oldExit; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
function task(threshold?: number): string {
  return addSchedule({ name: 'Fixture', command: 'x', cron: '* * * * *', enabled: true, ...(threshold !== undefined ? { failureStreakThreshold: threshold } : {}) }).id;
}
function record(id: string, status: string, n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { taskId: id, status, triggeredAt: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`, ...extra };
}
function fixture(rows: Record<string, unknown>[]): void { writeFileSync(getTelemetryPath(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); }
async function command(...args: string[]): Promise<void> {
  const p = new Command(); p.exitOverride(); registerScheduleCommand(p);
  await p.parseAsync(['node', 'afk', 'schedule', ...args]);
}
function output(): string { return log.mock.calls.map((c: unknown[]) => String(c[0])).join('\n'); }
describe('fixture-backed schedule health and list', () => {
  it('uses per-task threshold over fallback, and reports the oldest legacy failure', async () => {
    const id = task(1);
    fixture([record(id, 'success', 1), record(id, 'error', 2), record(id, 'blocked', 3)]);
    await command('health', '--threshold', '10');
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('threshold 1: 2 consecutive failures since 2026-01-02');
    await command('list');
    expect(output()).toContain('LAST STATUS'); expect(output()).toContain('STREAK');
    expect(output()).toContain('blocked | 2 | 2026-01-02');
  });
  it('breaches threshold 51 with more than 50 failures', async () => {
    const id = task(51);
    fixture([record(id, 'success', 1), ...Array.from({ length: 60 }, (_, n) => record(id, 'error', n + 2))]);
    await command('health');
    expect(process.exitCode).toBe(1); expect(output()).toContain('60 consecutive failures since 2026-01-02');
  });
  it('retains three failures through fifty skips', async () => {
    const id = task();
    fixture([record(id, 'success', 1), ...[2, 3, 4].map((n) => record(id, 'error', n)), ...Array.from({ length: 50 }, () => record(id, 'skipped', 5))]);
    await command('health'); expect(process.exitCode).toBe(1); expect(output()).toContain('3 consecutive failures');
  });
  it('finds a task beyond another task\'s one-MiB tail', async () => {
    const id = task();
    fixture([record(id, 'error', 1, { failureStreak: { ...emptyStreak(), count: 3, failingSince: 'start', escalated: true } }),
      ...Array.from({ length: 1100 }, () => record('other', 'success', 2, { responseExcerpt: 'x'.repeat(1024) }))]);
    await command('health'); expect(process.exitCode).toBe(1); expect(output()).toContain('3 consecutive failures since start');
  });
  it('reports no recent runs rather than no runs yet when older history exceeds the cap', async () => {
    const id = task();
    writeFileSync(getSchedulesPath(), JSON.stringify(loadSchedules().map((s) => ({
      ...s, createdAt: '2025-12-31T00:00:00Z',
    }))));
    fixture([
      record(id, 'success', 1),
      ...Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () =>
        record('other', 'success', 2, { durationMs: 0, responseExcerpt: 'x'.repeat(1024) })),
    ]);
    await command('health');
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('no recent runs found (indeterminate; history boundary unavailable)');
    expect(output()).not.toContain('no runs yet');
    log.mockClear();
    await command('list');
    expect(output()).toContain('no recent runs found | >=0');
    expect(output()).not.toContain('no runs yet');
  });
  it.each([
    ['2026-01-03T00:00:00Z', 0, true],
    ['2026-01-01T00:00:00Z', 0, false],
    [undefined, 0, false],
    ['malformed', 0, false],
    ['2026-01-03T00:00:00Z', 2 * 86400000, false],
  ])('checks an absent task created at %s against completed history (%i ms)', async (createdAt, durationMs, exact) => {
    const id = task();
    writeFileSync(getSchedulesPath(), JSON.stringify(loadSchedules().map((s) => ({ ...s, createdAt }))));
    fixture(Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () =>
      record('other', 'success', 2, { durationMs, responseExcerpt: 'x'.repeat(1024) })));
    process.exitCode = 0;
    await command('health');
    expect(process.exitCode).toBe(exact ? 0 : 1);
    expect(output()).toContain(exact
      ? `${id} (Fixture), threshold 3: no runs yet`
      : 'no recent runs found (indeterminate; history boundary unavailable)');
    expect(output()).not.toContain(exact ? 'indeterminate' : 'no runs yet');
    log.mockClear();
    await command('list');
    expect(output()).toContain(exact ? 'no runs yet | 0' : 'no recent runs found | >=0');
  });

  it('reports no runs yet after poller ticks and a usable completion boundary', async () => {
    const id = task();
    writeFileSync(getSchedulesPath(), JSON.stringify(loadSchedules().map((s) => ({
      ...s, createdAt: '2026-01-03T00:00:00Z',
    }))));
    const tick = JSON.stringify({ surface: 'github-event-poller', timestamp: '2025-01-01T00:00:00Z' });
    const boundary = JSON.stringify(record('other', 'success', 1, { durationMs: 86400000 }));
    const ending = `${`${tick}\n`.repeat(4)}${boundary}\n`;
    const prefix = `${'x'.repeat(STREAK_HISTORY_BYTE_CAP - Buffer.byteLength(ending))}\n`;
    writeFileSync(getTelemetryPath(), prefix + ending);
    process.exitCode = 0;
    await command('health');
    expect(process.exitCode).toBe(0);
    expect(output()).toContain(`${id} (Fixture), threshold 3: no runs yet`);
    expect(output()).not.toContain('indeterminate');
  });

  it('prints capped failure counts as lower bounds in health and list', async () => {
    const id = task(2);
    fixture([
      record(id, 'success', 1),
      ...Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () =>
        record('other', 'success', 2, { responseExcerpt: 'x'.repeat(1024) })),
      record(id, 'error', 3),
      record(id, 'blocked', 4),
    ]);
    await command('health');
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('at least 2 consecutive failures since 2026-01-03');
    await command('list');
    expect(output()).toContain('blocked | >=2 | 2026-01-03');
  });
  it('no runs is not unhealthy; a success establishes health', async () => {
    const id = task(); await command('health');
    expect(output()).toContain('no runs yet'); expect(process.exitCode).toBeUndefined();
    fixture([record(id, 'error', 1), record(id, 'success', 2)]);
    await command('health'); expect(output()).toContain('healthy (0 consecutive failures)'); expect(process.exitCode).toBeUndefined();
  });
  it('legacy boundary missing under threshold is indeterminate, never healthy', async () => {
    const id = task(10); fixture([record(id, 'error', 1), record(id, 'skipped', 2)]);
    await command('health'); expect(output()).toContain('indeterminate (at least 1 failures'); expect(process.exitCode).toBe(1);
  });
  it('a stamped skip carries the current count and start and ignores delivery rows', async () => {
    const id = task(); fixture([record(id, 'skipped', 4, { failureStreak: { ...emptyStreak(), count: 4, failingSince: 'original', escalated: true } }),
      { recordType: 'notification-delivery', taskId: id, outcome: 'failed' }]);
    await command('list'); expect(output()).toContain('skipped | 4 | original');
    await command('health'); expect(output()).toContain('4 consecutive failures since original'); expect(process.exitCode).toBe(1);
  });

  it('health reports correct results for multiple tasks from a single telemetry scan', async () => {
    // Three tasks sharing one telemetry file: verifies readAllStreakHistories is used (one pass).
    const id1 = task(1); const id2 = task(1); const id3 = task(1);
    fixture([record(id1, 'success', 1), record(id1, 'error', 2), record(id2, 'success', 3), record(id3, 'error', 4)]);
    await command('health');
    expect(process.exitCode).toBe(1);
    const out = output();
    expect(out).toContain(`${id1} (Fixture), threshold 1: 1 consecutive failures`);
    expect(out).toContain(`${id2} (Fixture), threshold 1: healthy`);
    expect(out).toContain(`${id3} (Fixture), threshold 1: at least 1 consecutive failures`);
  });
});
