/**
 * Tests for runAt one-shot and expiresAt hard-expiry logic in CronScheduler.
 *
 * Uses the same injection seams as scheduler.test.ts (sessionFactory,
 * telemetryPath, now, budgetGate) so no real AgentSession or filesystem path
 * outside the tmp dir is ever touched.
 *
 * @module agent/daemon/scheduler.runat-expiry.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CronScheduler } from './scheduler.js';
import type { AgentSession } from '../session/agent-session.js';
import type { ScheduledTask } from './triggers.js';
import { validateScheduledTask } from './triggers.js';
import { loadSchedules, addSchedule, updateSchedule, toScheduledTask } from './schedule-store.js';

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({
    registry: undefined,
    memoryStore: { close: () => undefined },
  }),
}));

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(response = 'ok'): AgentSession {
  return {
    sendMessage: vi.fn().mockResolvedValue({ content: response }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSession;
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'afk-runat-expiry-'));
}

const FUTURE_ISO = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 min
const PAST_ISO = new Date(Date.now() - 10 * 60 * 1000).toISOString();   // -10 min
const NOW_ISO = new Date().toISOString();

// ---------------------------------------------------------------------------
// Schema / validation
// ---------------------------------------------------------------------------

describe('validateScheduledTask — runAt and expiresAt', () => {
  it('accepts a task with a valid runAt and no cronExpression', () => {
    expect(() =>
      validateScheduledTask({
        taskId: 'one-shot',
        command: 'do it',
        trigger: 'cron',
        runAt: FUTURE_ISO,
      }),
    ).not.toThrow();
  });

  it('accepts a task with a valid expiresAt', () => {
    expect(() =>
      validateScheduledTask({
        taskId: 'expiring',
        command: 'do it',
        trigger: 'cron',
        cronExpression: '0 * * * *',
        expiresAt: FUTURE_ISO,
      }),
    ).not.toThrow();
  });

  it('rejects runAt + cronExpression (mutually exclusive)', () => {
    expect(() =>
      validateScheduledTask({
        taskId: 'bad',
        command: 'x',
        trigger: 'cron',
        cronExpression: '0 * * * *',
        runAt: FUTURE_ISO,
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects an invalid runAt string', () => {
    expect(() =>
      validateScheduledTask({
        taskId: 'bad-runat',
        command: 'x',
        trigger: 'cron',
        runAt: 'not-a-date',
      }),
    ).toThrow(/runAt must be a valid ISO 8601/);
  });

  it('rejects an invalid expiresAt string', () => {
    expect(() =>
      validateScheduledTask({
        taskId: 'bad-expiry',
        command: 'x',
        trigger: 'cron',
        cronExpression: '0 * * * *',
        expiresAt: 'not-a-date',
      }),
    ).toThrow(/expiresAt must be a valid ISO 8601/);
  });
});

// ---------------------------------------------------------------------------
// runAt one-shot — scheduler behaviour
// ---------------------------------------------------------------------------

describe('CronScheduler — runAt one-shot', () => {
  let dir: string;
  let telemetryPath: string;
  let savedAfkHome: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'telemetry.jsonl');
    savedAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = dir;
  });

  afterEach(() => {
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const task = (runAt: string): ScheduledTask => ({
    taskId: 'one-shot',
    command: 'run once',
    trigger: 'cron',
    runAt,
  });

  it('skips with skipReason:not-yet when runAt is in the future', async () => {
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession(),
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(FUTURE_ISO));
    const record = await scheduler.tick('one-shot');

    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('not-yet');
    await scheduler.stop();
  });

  it('does NOT write a telemetry line for a not-yet skip (silent pre-fire polling)', async () => {
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession(),
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(FUTURE_ISO));
    await scheduler.tick('one-shot');

    // No JSONL line should be written for a not-yet skip
    let content = '';
    try { content = readFileSync(telemetryPath, 'utf-8'); } catch { /* file may not exist */ }
    expect(content.trim()).toBe('');
    await scheduler.stop();
  });

  it('fires the task when runAt is in the past', async () => {
    let sessionCalled = false;
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => {
        sessionCalled = true;
        return makeSession('done');
      },
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(PAST_ISO));
    const record = await scheduler.tick('one-shot');

    expect(record.status).toBe('success');
    expect(sessionCalled).toBe(true);
    await scheduler.stop();
  });

  it('auto-disables the task in the store after firing', async () => {
    // Write a minimal schedules.json so toggleScheduleEnabled has a record to update.
    const schedulesPath = join(dir, 'config', 'schedules.json');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(
      schedulesPath,
      JSON.stringify([
        {
          id: 'one-shot',
          name: 'One Shot',
          command: 'run once',
          cron: '* * * * *',
          trigger: 'cron',
          enabled: true,
          runAt: PAST_ISO,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ]),
    );
    vi.stubEnv('AFK_HOME', dir);

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession('done'),
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(PAST_ISO));
    await scheduler.tick('one-shot');

    // After firing, the store record must be disabled.
    const stored = loadSchedules(schedulesPath);
    expect(stored[0]?.enabled).toBe(false);

    vi.unstubAllEnvs();
    await scheduler.stop();
  });

  it('unregisters the task from the scheduler after firing (no more cron ticks)', async () => {
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession('done'),
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(PAST_ISO));
    await scheduler.tick('one-shot');

    // After firing, the task must not be in the registry.
    expect(scheduler.list().find((t) => t.taskId === 'one-shot')).toBeUndefined();
    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// expiresAt hard expiry — scheduler behaviour
// ---------------------------------------------------------------------------

describe('CronScheduler — expiresAt expiry', () => {
  let dir: string;
  let telemetryPath: string;
  let savedAfkHome: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'telemetry.jsonl');
    savedAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = dir;
  });

  afterEach(() => {
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    rmSync(dir, { recursive: true, force: true });
  });

  const task = (expiresAt: string): ScheduledTask => ({
    taskId: 'expiring',
    command: 'periodic work',
    trigger: 'cron',
    cronExpression: '0 * * * *',
    expiresAt,
  });

  it('skips with skipReason:expired when expiresAt is in the past', async () => {
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession(),
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(PAST_ISO));
    const record = await scheduler.tick('expiring');

    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('expired');
    await scheduler.stop();
  });

  it('writes a telemetry line for an expired skip', async () => {
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession(),
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(PAST_ISO));
    await scheduler.tick('expiring');

    const line = readFileSync(telemetryPath, 'utf-8').trim();
    const record = JSON.parse(line) as { status: string; skipReason: string };
    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('expired');
    await scheduler.stop();
  });

  it('auto-disables the task in the store on expiry', async () => {
    const schedulesPath = join(dir, 'config', 'schedules.json');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(
      schedulesPath,
      JSON.stringify([
        {
          id: 'expiring',
          name: 'Expiring Task',
          command: 'periodic work',
          cron: '0 * * * *',
          trigger: 'cron',
          enabled: true,
          expiresAt: PAST_ISO,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ]),
    );
    vi.stubEnv('AFK_HOME', dir);

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession(),
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(PAST_ISO));
    await scheduler.tick('expiring');

    const stored = loadSchedules(schedulesPath);
    expect(stored[0]?.enabled).toBe(false);

    vi.unstubAllEnvs();
    await scheduler.stop();
  });

  it('unregisters the task after expiry so no further ticks fire', async () => {
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession(),
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(PAST_ISO));
    await scheduler.tick('expiring');

    expect(scheduler.list().find((t) => t.taskId === 'expiring')).toBeUndefined();
    await scheduler.stop();
  });

  it('runs normally when expiresAt is in the future', async () => {
    let sessionCalled = false;
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => {
        sessionCalled = true;
        return makeSession('ok');
      },
      budgetGate: async () => ({ skip: false }),
    });
    scheduler.register(task(FUTURE_ISO));
    const record = await scheduler.tick('expiring');

    expect(record.status).toBe('success');
    expect(sessionCalled).toBe(true);
    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// schedule-store round-trip
// ---------------------------------------------------------------------------

describe('schedule-store — runAt / expiresAt round-trip', () => {
  let dir: string;
  let savedAfkHome: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    savedAfkHome = process.env['AFK_HOME'];
    vi.stubEnv('AFK_HOME', dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists runAt and expiresAt through addSchedule → loadSchedules', async () => {
    const config = addSchedule({
      name: 'Test One-Shot',
      command: 'go',
      cron: '* * * * *',
      trigger: 'cron',
      enabled: true,
      runAt: FUTURE_ISO,
      expiresAt: FUTURE_ISO,
    });
    expect(config.runAt).toBe(FUTURE_ISO);
    expect(config.expiresAt).toBe(FUTURE_ISO);

    const loaded = loadSchedules();
    const found = loaded.find((s) => s.id === config.id);
    expect(found?.runAt).toBe(FUTURE_ISO);
    expect(found?.expiresAt).toBe(FUTURE_ISO);
  });

  it('updateSchedule patches runAt and expiresAt', async () => {
    const config = addSchedule({
      name: 'Patchable',
      command: 'go',
      cron: '* * * * *',
      trigger: 'cron',
      enabled: true,
    });
    const updated = updateSchedule(config.id, { runAt: FUTURE_ISO, expiresAt: FUTURE_ISO });
    expect(updated?.runAt).toBe(FUTURE_ISO);
    expect(updated?.expiresAt).toBe(FUTURE_ISO);
  });

  it('updateSchedule clears runAt and expiresAt when null is passed', async () => {
    const config = addSchedule({
      name: 'Clearable',
      command: 'go',
      cron: '* * * * *',
      trigger: 'cron',
      enabled: true,
      runAt: FUTURE_ISO,
      expiresAt: FUTURE_ISO,
    });
    const updated = updateSchedule(config.id, { runAt: null, expiresAt: null });
    expect(updated?.runAt).toBeUndefined();
    expect(updated?.expiresAt).toBeUndefined();
  });

  it('toScheduledTask threads runAt and expiresAt through', async () => {
    const task = toScheduledTask({
      id: 'x',
      name: 'X',
      command: 'go',
      cron: '* * * * *',
      trigger: 'cron',
      enabled: true,
      runAt: FUTURE_ISO,
      expiresAt: FUTURE_ISO,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    });
    expect(task.runAt).toBe(FUTURE_ISO);
    expect(task.expiresAt).toBe(FUTURE_ISO);
  });

  it('existing schedules without runAt/expiresAt load unchanged (backward compat)', async () => {
    const schedulesPath = join(dir, 'config', 'schedules.json');
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(
      schedulesPath,
      JSON.stringify([
        {
          id: 'legacy',
          name: 'Legacy',
          command: 'go',
          cron: '0 * * * *',
          trigger: 'cron',
          enabled: true,
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        },
      ]),
    );
    const loaded = loadSchedules(schedulesPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.runAt).toBeUndefined();
    expect(loaded[0]?.expiresAt).toBeUndefined();
    expect(loaded[0]?.id).toBe('legacy');
  });
});
