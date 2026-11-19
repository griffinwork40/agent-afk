import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { addSchedule } from '../../agent/daemon/schedule-store.js';
import { getTelemetryPath } from '../../paths.js';
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
    fixture([
      record(id, 'success', 1),
      ...Array.from({ length: Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024) }, () =>
        record('other', 'success', 2, { responseExcerpt: 'x'.repeat(1024) })),
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
});
