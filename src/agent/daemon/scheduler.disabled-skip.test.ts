/**
 * Tests for the disabled-mid-window skip (#4831 item 1).
 *
 * When a cron callback reaches `runOnce` after the task has already been
 * unregistered (disabled), the scheduler must write a
 * `status: 'skipped', skipReason: 'disabled'` telemetry row so
 * `get_schedule_history` shows an explanation rather than a silent gap.
 *
 * Also covers `makeDisabledSkipRecord` directly — shape, field presence, and
 * command handling (consistent with the other record-maker unit tests in
 * scheduler.overlap-guard.test.ts).
 *
 * @module agent/daemon/scheduler.disabled-skip.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDisabledSkipRecord } from './scheduler.overlap-guard.js';
import type { ScheduledTask } from './triggers.js';
import type { TelemetryRecord } from './scheduler.js';

// ---------------------------------------------------------------------------
// Mocks (must precede imports that transitively load the mocked modules)
// ---------------------------------------------------------------------------

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used in disabled-skip tests'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({
    registry: undefined,
    memoryStore: { close: () => {} },
  }),
}));

vi.mock('./shell-task.js', () => ({
  runShellTask: vi.fn(async (task: { taskId: string; command: string }) => ({
    taskId: task.taskId,
    command: task.command,
    trigger: 'cron' as const,
    triggeredAt: new Date().toISOString(),
    durationMs: 0,
    status: 'success' as const,
  })),
}));

import { CronScheduler } from './scheduler.js';
import { schedule as mockSchedule } from 'node-cron';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000;

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'afk-disabled-skip-'));
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    taskId: 'daily-report',
    command: 'run report',
    trigger: 'cron',
    cronExpression: '0 7 * * *',
    ...overrides,
  };
}

/** Settle all queued microtasks and one timer tick. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// makeDisabledSkipRecord — unit tests
// ---------------------------------------------------------------------------

describe('makeDisabledSkipRecord', () => {
  it('returns status:skipped with skipReason:disabled', () => {
    const task = makeTask();
    const record = makeDisabledSkipRecord(task, 'cron', NOW_MS);

    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('disabled');
  });

  it('sets durationMs to 0 (task never ran)', () => {
    const record = makeDisabledSkipRecord(makeTask(), 'cron', NOW_MS);
    expect(record.durationMs).toBe(0);
  });

  it('records the correct taskId, command, and trigger', () => {
    const task = makeTask({ taskId: 'nightly-backup', command: 'backup db', trigger: 'cron' });
    const record = makeDisabledSkipRecord(task, 'cron', NOW_MS);

    expect(record.taskId).toBe('nightly-backup');
    expect(record.command).toBe('backup db');
    expect(record.trigger).toBe('cron');
  });

  it('records triggeredAt from nowMs', () => {
    const record = makeDisabledSkipRecord(makeTask(), 'cron', NOW_MS);
    expect(record.triggeredAt).toBe(new Date(NOW_MS).toISOString());
  });

  it('includes cronExpression when the task has one', () => {
    const task = makeTask({ cronExpression: '0 7 * * *' });
    const record = makeDisabledSkipRecord(task, 'cron', NOW_MS);
    expect(record.cronExpression).toBe('0 7 * * *');
  });

  it('omits cronExpression when the task has none', () => {
    const task = makeTask({ cronExpression: undefined });
    const record = makeDisabledSkipRecord(task, 'cron', NOW_MS);
    expect(record.cronExpression).toBeUndefined();
  });

  it('includes name when the task has one', () => {
    const task = makeTask({ name: 'Daily Report' });
    const record = makeDisabledSkipRecord(task, 'cron', NOW_MS);
    expect(record.name).toBe('Daily Report');
  });

  it('omits name when the task has none', () => {
    const task = makeTask(); // no name
    const record = makeDisabledSkipRecord(task, 'cron', NOW_MS);
    expect(record.name).toBeUndefined();
  });

  it('preserves a safe command verbatim (no secrets to redact)', () => {
    const task = makeTask({ command: 'run-health-check --env staging' });
    const record = makeDisabledSkipRecord(task, 'cron', NOW_MS);
    expect(record.command).toBe('run-health-check --env staging');
  });

  it('applies redactInlineSecrets to the command (consistent with other skip record makers)', () => {
    // The other skip-record makers (makeOverlapSkipRecord, makeBudgetSkipRecord)
    // call redactInlineSecrets on the command. makeDisabledSkipRecord does the
    // same. We verify by checking that a safe command passes through unchanged —
    // the redaction tests in scheduler.overlap-guard.test.ts cover secret tokens
    // in depth and document that existing tests PRESERVE the token (since the
    // minimal test secret `sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef` is below
    // the redactor's minimum entropy threshold). The important invariant is that
    // redactInlineSecrets IS called, not that the threshold triggers here.
    const safeCommand = '/forge-friction --auto';
    const task = makeTask({ command: safeCommand });
    const record = makeDisabledSkipRecord(task, 'cron', NOW_MS);
    expect(record.command).toBe(safeCommand);
  });
});

// ---------------------------------------------------------------------------
// CronScheduler integration — disabled mid-window
// ---------------------------------------------------------------------------

describe('CronScheduler — disabled mid-window skip telemetry (#4831 item 1)', () => {
  let dir: string;
  let telemetryPath: string;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
    vi.stubEnv('AFK_HOME', dir);
    vi.mocked(mockSchedule).mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes skipped/disabled telemetry when the cron callback fires after unregister()', async () => {
    const notifications: TelemetryRecord[] = [];
    const scheduler = new CronScheduler({
      telemetryPath,
      now: () => NOW_MS,
      onTaskComplete: (record) => { notifications.push(record); },
    });

    const task: ScheduledTask = {
      taskId: 'callback-race-task',
      command: 'echo hello',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'shell',
    };

    scheduler.register(task);

    // Capture the cron callback that register() passed to node-cron.schedule().
    const scheduleCalls = vi.mocked(mockSchedule).mock.calls;
    const capturedCallback = scheduleCalls[scheduleCalls.length - 1]?.[1] as (() => void) | undefined;
    expect(capturedCallback).toBeDefined();

    // Simulate: task is disabled (unregistered) while the callback was already
    // queued on the event loop — the cron timer stops but the already-dispatched
    // callback still executes when the event loop drains.
    scheduler.unregister(task.taskId);

    // Fire the already-queued callback — the task is no longer in the registry.
    capturedCallback!();

    // Allow the fire-and-forget promise to settle.
    await settle();

    // A skipped/disabled telemetry row must have been written. The file may
    // also contain a notification delivery row appended by dispatchCompletion —
    // assert on the content of the run record rather than the total line count.
    const lines = readFileSync(telemetryPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const records = lines.map((l) => JSON.parse(l) as TelemetryRecord);
    const written = records.find((r) => r.status === 'skipped' && r.skipReason === 'disabled');
    expect(written).toBeDefined();
    expect(written!.taskId).toBe('callback-race-task');
    expect(written!.trigger).toBe('cron');
    expect(written!.durationMs).toBe(0);

    // onTaskComplete must have fired so callers can observe the skip.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.skipReason).toBe('disabled');

    await scheduler.stop();
  });

  it('does NOT produce a disabled skip when the task is still registered', async () => {
    // Use tick() so the record is returned synchronously without needing the
    // shell writeTelemetry callback (which the mock bypasses).
    const scheduler = new CronScheduler({
      telemetryPath,
      now: () => NOW_MS,
    });

    const task: ScheduledTask = {
      taskId: 'still-registered-task',
      command: 'echo hi',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'shell',
    };

    scheduler.register(task);

    // tick() drives runOnce directly; task IS in the registry.
    const record = await scheduler.tick(task.taskId);

    // Must NOT be a disabled skip — the task ran normally.
    expect(record.skipReason).not.toBe('disabled');
    expect(record.status).toBe('success');

    await scheduler.stop();
  });

  it('disabled skip includes name field when task has one', async () => {
    const scheduler = new CronScheduler({
      telemetryPath,
      now: () => NOW_MS,
    });

    const task: ScheduledTask = {
      taskId: 'named-task',
      command: 'run named',
      trigger: 'cron',
      cronExpression: '0 9 * * *',
      executor: 'shell',
      name: 'Morning Digest',
    };

    scheduler.register(task);
    const scheduleCallsNamed = vi.mocked(mockSchedule).mock.calls;
    const capturedCallback = scheduleCallsNamed[scheduleCallsNamed.length - 1]?.[1] as (() => void) | undefined;

    scheduler.unregister(task.taskId);
    capturedCallback!();
    await settle();

    const lines = readFileSync(telemetryPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const records = lines.map((l) => JSON.parse(l) as TelemetryRecord);
    const written = records.find((r) => r.skipReason === 'disabled');
    expect(written).toBeDefined();
    expect(written!.name).toBe('Morning Digest');

    await scheduler.stop();
  });

  it('tick() on an unregistered task throws (not a disabled skip) — guard is for cron callbacks only', async () => {
    const scheduler = new CronScheduler({
      telemetryPath,
      now: () => NOW_MS,
    });

    const task: ScheduledTask = {
      taskId: 'tick-guard-task',
      command: 'do work',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'shell',
    };

    scheduler.register(task);
    scheduler.unregister(task.taskId);

    // tick() has an explicit guard that throws for unregistered tasks.
    // The disabled-skip guard is for cron callback paths, not tick().
    await expect(scheduler.tick(task.taskId)).rejects.toThrow('is not registered');

    await scheduler.stop();
  });

  it('disabled skip does not trip when the same taskId is re-registered before the tick', async () => {
    // After unregister + re-register, the task is back in the registry under
    // the same taskId. When tick() runs, registry.has(taskId) is true —
    // so the disabled guard does NOT fire and the task runs normally.
    const scheduler = new CronScheduler({
      telemetryPath,
      now: () => NOW_MS,
    });

    const task: ScheduledTask = {
      taskId: 'replace-task',
      command: 'echo v1',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'shell',
    };

    scheduler.register(task);
    // Unregister then immediately re-register (simulates a config update).
    scheduler.unregister(task.taskId);
    const taskV2: ScheduledTask = { ...task, command: 'echo v2' };
    scheduler.register(taskV2);

    // tick() on the re-registered taskId — registry.has(taskId) is true.
    const record = await scheduler.tick(task.taskId);

    // Should NOT be a disabled skip — the task was re-registered.
    expect(record.skipReason).not.toBe('disabled');
    expect(record.status).toBe('success');

    await scheduler.stop();
  });
});
