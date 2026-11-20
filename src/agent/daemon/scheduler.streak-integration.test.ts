import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSession } from '../session/agent-session.js';
import type { TelemetryRecord, TaskCompletionDetails } from './scheduler.js';
import { readTelemetryHistory } from './telemetry-reader.js';
import { readStreakHistory, STREAK_HISTORY_BYTE_CAP } from './scheduler.streak-history.js';
import { addSchedule, toScheduledTask } from './schedule-store.js';
import { enqueue } from './queue-store.js';

vi.mock('node-cron', () => ({ schedule: vi.fn(() => ({ stop() {}, destroy() {} })) }));
vi.mock('../providers/index.js', () => ({ providerForModel: () => 'anthropic-direct' }));
vi.mock('../default-hook-registry.js', () => ({ createDefaultHookRegistry: () => ({ registry: undefined, memoryStore: { close() {} } }) }));
import { CronScheduler } from './scheduler.js';
import { _resetDaemonDefaultCwdCache } from './session-spawn.js';

let dir: string;
let path: string;
let fails: boolean;
const schedulers: CronScheduler[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'streak-integration-'));
  path = join(dir, 'telemetry.jsonl');
  vi.stubEnv('AFK_HOME', dir);
  vi.stubEnv('AFK_ALLOW_PROJECT_MCP', '0');
  fails = true;
});
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map((s) => s.stop()));
  vi.unstubAllEnvs();
  _resetDaemonDefaultCwdCache();
  rmSync(dir, { recursive: true, force: true });
});
function scheduler(onTaskComplete?: NonNullable<ConstructorParameters<typeof CronScheduler>[0]>['onTaskComplete'], notifyOn: 'failure' | 'never' = 'failure'): CronScheduler {
  const s = new CronScheduler({ telemetryPath: path, budgetGate: async () => ({ skip: false }),
    sessionFactory: () => ({ sendMessage: () => fails ? Promise.reject(new Error('diagnostic')) : Promise.resolve({ content: 'ok' }), close: async () => {} }) as unknown as AgentSession,
    ...(onTaskComplete !== undefined ? { onTaskComplete } : {}),
  });
  s.register({ taskId: 't', command: 'test', trigger: 'cron', cronExpression: '* * * * *', notifyOn });
  schedulers.push(s);
  return s;
}
function rows(): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}
describe('durable scheduler streak integration', () => {
  it('stamps a new schedule\'s first failure as exact even when telemetry exceeds the cap', async () => {
    mkdirSync(join(dir, 'agent-framework'), { recursive: true });
    const config = addSchedule({ name: 'New task', command: 'test', cron: '* * * * *', enabled: true });
    const padding = JSON.stringify({
      taskId: 'other', status: 'success', triggeredAt: '2020-01-01T00:00:00Z', durationMs: 0,
      responseExcerpt: 'x'.repeat(1024),
    });
    writeFileSync(path, `${padding}\n`.repeat(Math.ceil(STREAK_HISTORY_BYTE_CAP / 1024)));
    const s = scheduler();
    s.register(toScheduledTask(config));
    await s.tick(config.id);
    const history = await readTelemetryHistory(path, { taskId: config.id, limit: 1 }) as TelemetryRecord[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ status: 'error', failureStreak: { count: 1, exact: true } });
  });

  it('runs synthetic pull queue tasks without hydration or per-id tracker state', async () => {
    const cb = vi.fn();
    const s = scheduler(cb);
    const hydrate = vi.spyOn(s.failureStreaks, 'hydrate');
    const record = vi.spyOn(s.failureStreaks, 'record');
    const state = s.failureStreaks as unknown as {
      streaks: Map<string, unknown>;
      hydrated: Set<string>;
    };
    const queueDir = join(dir, 'pull-queue');
    const ids = Array.from({ length: 10 }, () => enqueue('test', { notifyOn: 'failure' }, queueDir).id);
    for (const _id of ids) {
      await (s as unknown as { pullTick: (queueDir: string) => Promise<void> }).pullTick(queueDir);
    }
    expect(hydrate).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(state.streaks.size).toBe(0);
    expect(state.hydrated.size).toBe(0);
    const runs = rows().filter((row) => row['recordType'] !== 'notification-delivery') as unknown as TelemetryRecord[];
    expect(runs.map((run) => run.taskId)).toEqual(ids);
    expect(runs.every((run) => run.trigger === 'pull' && run.failureStreak === undefined)).toBe(true);
    expect(runs.every((run) => run.notificationDecision?.kind === 'failure')).toBe(true);
    expect(cb).toHaveBeenCalledTimes(10);
  });

  it('forgets unregistered recurring tasks, including their hydration cache', async () => {
    const s = scheduler();
    await s.tick('t');
    const state = s.failureStreaks as unknown as {
      streaks: Map<string, unknown>;
      hydrated: Set<string>;
    };
    expect(state.streaks.size).toBe(1);
    expect(state.hydrated.size).toBe(1);
    s.unregister('t');
    expect(state.streaks.size).toBe(0);
    expect(state.hydrated.size).toBe(0);
  });

  it('preserves count/start/escalation on restart and sends just one recovery', async () => {
    const notices: Array<{ record: TelemetryRecord; details?: TaskCompletionDetails }> = [];
    const cb = (record: TelemetryRecord, details?: TaskCompletionDetails): void => { notices.push({ record, details }); };
    const s = scheduler(cb);
    for (let n = 0; n < 4; n++) await s.tick('t');
    await s.stop();
    const restarted = scheduler(cb);
    await restarted.tick('t');
    fails = false;
    await restarted.tick('t');
    await restarted.tick('t');
    const history = await readTelemetryHistory(path, { taskId: 't', limit: 20 }) as TelemetryRecord[];
    expect(history).toHaveLength(7);
    expect(history.map((r) => r.failureStreak?.count)).toEqual([1, 2, 3, 4, 5, 0, 0]);
    expect(history[4]?.failureStreak?.failingSince).toBe(history[0]?.triggeredAt);
    expect(history.filter((r) => r.notificationDecision?.kind === 'escalation')).toHaveLength(1);
    expect(history.filter((r) => r.notificationDecision?.kind === 'recovery')).toHaveLength(1);
    expect(history[6]?.notificationDecision?.state).toBe('not-due');
    expect(notices).toHaveLength(6);
    expect(notices[3]?.details?.responseText).toContain('Failure 4 in a row');
    expect(notices[3]?.details?.responseText).toContain(history[0]!.triggeredAt);
    expect(notices[4]?.details?.responseText).toContain(history[0]!.triggeredAt);
    expect(notices[4]?.details?.responseText).toContain('Failure 5 in a row');
    expect(notices[4]?.details?.responseText).toContain('diagnostic');
    expect(readStreakHistory(path, 't').snapshot.count).toBe(0);
    expect(rows().filter((r) => r['recordType'] === 'notification-delivery').every((r) => r['outcome'] === 'unknown')).toBe(true);
  });
  it('completes a tick and writes the run before a rejecting delivery settles', async () => {
    let reject!: (error: Error) => void;
    const s = scheduler(() => new Promise<void>((_resolve, rej) => { reject = rej; }));
    await s.tick('t');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.['notificationDecision']).toEqual({ state: 'due', kind: 'failure' });
    reject(new Error('offline'));
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[1]).toMatchObject({ recordType: 'notification-delivery', outcome: 'failed', target: null });
    expect(rows()[1]?.['runId']).toBe(rows()[0]?.['runId']);
    expect(await readTelemetryHistory(path, { taskId: 't', limit: 1 })).toHaveLength(1);
  });
  it.each(['delivered', 'failed', 'unconfigured', 'unknown'] as const)('persists a structured %s outcome with its destination', async (outcome) => {
    const s = scheduler(async () => ({ target: [123], outcome }));
    await s.tick('t');
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[1]).toMatchObject({ recordType: 'notification-delivery', outcome, target: [123] });
    const runs = await readTelemetryHistory(path, { taskId: 't', limit: 10 }) as TelemetryRecord[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.notificationDecision).toEqual({ state: 'due', kind: 'failure' });
  });
  it('stamps due without a callback instead of claiming delivery', async () => {
    const s = scheduler(); await s.tick('t');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.['notificationDecision']).toEqual({ state: 'due', kind: 'failure', reason: 'no-callback' });
  });
  it('stamps a skip with the live snapshot and retains the streak for recovery', async () => {
    const s = scheduler(() => {});
    for (let n = 0; n < 3; n++) await s.tick('t');
    const since = readStreakHistory(path, 't').snapshot.failingSince;
    // An expired run is a real scheduler skip, not a tracker-only fixture.
    s.unregister('t');
    s.register({ taskId: 't', command: 'test', trigger: 'cron', cronExpression: '* * * * *', expiresAt: '2000-01-01T00:00:00Z', notifyOn: 'failure' });
    await s.tick('t');
    const history = await readTelemetryHistory(path, { taskId: 't', limit: 10 }) as TelemetryRecord[];
    expect(history[3]?.status).toBe('skipped');
    expect(history[3]?.failureStreak).toMatchObject({ count: 3, failingSince: since, escalated: true });
    expect(history[3]?.notificationDecision?.state).toBe('not-due');
    fails = false;
    const restarted = scheduler(() => {}); await restarted.tick('t');
    expect(readStreakHistory(path, 't').snapshot.count).toBe(0);
    const recovery = await readTelemetryHistory(path, { taskId: 't', limit: 1 }) as TelemetryRecord[];
    expect(recovery[0]?.notificationDecision?.kind).toBe('recovery');
  });
  it('notifyOn never suppresses all callbacks through escalation, re-escalation and recovery', async () => {
    const cb = vi.fn();
    const s = scheduler(cb, 'never');
    for (let n = 0; n < 13; n++) await s.tick('t');
    fails = false;
    await s.tick('t');
    expect(cb).not.toHaveBeenCalled();
    const history = await readTelemetryHistory(path, { taskId: 't', limit: 20 }) as TelemetryRecord[];
    expect(history.every((r) => r.notificationDecision?.state === 'suppressed')).toBe(true);
    expect(history[2]?.notificationDecision?.kind).toBe('escalation');
    expect(history[12]?.notificationDecision?.kind).toBe('re-escalation');
    expect(history[13]?.notificationDecision?.kind).toBe('recovery');
    expect(history[13]?.failureStreak?.count).toBe(0);
  });
});
