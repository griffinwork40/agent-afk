/**
 * Tests for Phase 5 — daemon mode (cron-only v1).
 *
 * Covers:
 *   - Trigger validation (`validateScheduledTask`).
 *   - CronScheduler: register/unregister, tick(taskId), error containment,
 *     telemetry write, sessionFactory injection.
 *   - Daemon: HTTP control surface (/health, /tasks, 404), tickOnce,
 *     graceful shutdown.
 *   - End-to-end Gap-B closure: spin daemon → tickOnce → telemetry record
 *     written to the configured sink with expected shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, Message } from './types.js';
import { validateScheduledTask, type ScheduledTask } from './daemon/triggers.js';
import { CronScheduler } from './daemon/scheduler.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { getDaemonStateDir } from '../paths.js';

// node-cron schedules tasks against real wall-clock time. We never let them
// fire — every test uses scheduler.tick(taskId) directly to invoke the
// on-tick handler synchronously. Cron timing is integration territory.

vi.mock('../utils/debug.js', () => ({ debugLog: vi.fn() }));

interface FakeAgentSessionShape {
  sendMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeSession(reply: string | Error): FakeAgentSessionShape {
  return {
    sendMessage: vi.fn(async (_content: string): Promise<Message> => {
      if (reply instanceof Error) throw reply;
      return { role: 'assistant', content: reply, timestamp: new Date() };
    }),
    close: vi.fn(async () => undefined),
  };
}

function tmpTelemetryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-afk-daemon-'));
  return join(dir, 'forge-telemetry.jsonl');
}

function readTelemetryRecords(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('validateScheduledTask', () => {
  it('accepts a valid cron task', () => {
    expect(() =>
      validateScheduledTask({
        taskId: 'a',
        command: '/forge-friction --auto',
        trigger: 'cron',
        cronExpression: '* * * * *',
      }),
    ).not.toThrow();
  });

  it('rejects missing taskId', () => {
    expect(() =>
      validateScheduledTask({
        taskId: '',
        command: 'x',
        trigger: 'cron',
        cronExpression: '* * * * *',
      }),
    ).toThrow(/taskId is required/);
  });

  it('rejects missing command', () => {
    expect(() =>
      validateScheduledTask({
        taskId: 'a',
        command: '',
        trigger: 'cron',
        cronExpression: '* * * * *',
      }),
    ).toThrow(/command is required/);
  });

  it('rejects cron trigger without cronExpression', () => {
    expect(() =>
      validateScheduledTask({
        taskId: 'a',
        command: 'x',
        trigger: 'cron',
      }),
    ).toThrow(/cronExpression required/);
  });

  it('accepts sessionstart trigger (Phase 6)', () => {
    expect(() =>
      validateScheduledTask({ taskId: 'a', command: 'x', trigger: 'sessionstart' }),
    ).not.toThrow();
  });

  it('accepts both trigger when cronExpression is supplied (Phase 6)', () => {
    expect(() =>
      validateScheduledTask({
        taskId: 'a',
        command: 'x',
        trigger: 'both',
        cronExpression: '* * * * *',
      }),
    ).not.toThrow();
  });

  it('rejects both trigger without cronExpression', () => {
    expect(() =>
      validateScheduledTask({ taskId: 'a', command: 'x', trigger: 'both' }),
    ).toThrow(/cronExpression required/);
  });
});

describe('CronScheduler', () => {
  let telemetryPath: string;
  let scheduler: CronScheduler;
  let lastFakeSession: FakeAgentSessionShape | null = null;
  let nextReply: string | Error = 'ok';

  beforeEach(() => {
    telemetryPath = tmpTelemetryFile();
    lastFakeSession = null;
    nextReply = 'ok';
    scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: (_config: AgentConfig) => {
        const fake = makeFakeSession(nextReply);
        lastFakeSession = fake;
        return fake as unknown as ReturnType<SessionFactoryReturn>;
      },
    });
  });

  afterEach(async () => {
    await scheduler.stop();
    rmSync(telemetryPath, { force: true });
  });

  it('register adds the task to list()', () => {
    scheduler.register({
      taskId: 't',
      command: '/forge-friction --auto',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });
    expect(scheduler.list().map((t) => t.taskId)).toEqual(['t']);
  });

  it('rejects double-registration of the same taskId', () => {
    const task: ScheduledTask = {
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    };
    scheduler.register(task);
    expect(() => scheduler.register(task)).toThrow(/already registered/);
  });

  it('unregister removes the task', () => {
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });
    scheduler.unregister('t');
    expect(scheduler.list()).toHaveLength(0);
  });

  it('unregister on unknown taskId is a no-op', () => {
    expect(() => scheduler.unregister('missing')).not.toThrow();
  });

  it('tick on unknown taskId throws', async () => {
    await expect(scheduler.tick('missing')).rejects.toThrow(/not registered/);
  });

  it('tick spawns a session, sends the command, drains output, writes telemetry success', async () => {
    nextReply = 'forge-friction completed; 0 themes promoted';
    scheduler.register({
      taskId: 'forge-friction',
      command: '/forge-friction --auto',
      trigger: 'cron',
      cronExpression: '0 */6 * * *',
    });

    const record = await scheduler.tick('forge-friction');

    expect(record).toMatchObject({
      taskId: 'forge-friction',
      command: '/forge-friction --auto',
      trigger: 'cron',
      cronExpression: '0 */6 * * *',
      status: 'success',
      responseExcerpt: 'forge-friction completed; 0 themes promoted',
    });
    expect(typeof record.durationMs).toBe('number');
    expect(typeof record.triggeredAt).toBe('string');

    expect(lastFakeSession).not.toBeNull();
    expect(lastFakeSession!.sendMessage).toHaveBeenCalledWith('/forge-friction --auto');
    expect(lastFakeSession!.close).toHaveBeenCalled();

    const records = readTelemetryRecords(telemetryPath);
    expect(records).toHaveLength(1);
    expect((records[0] as { taskId: string }).taskId).toBe('forge-friction');
  });

  it('error in session.sendMessage is captured in telemetry, scheduler keeps running', async () => {
    nextReply = new Error('SDK boom');
    scheduler.register({
      taskId: 'failing',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const record = await scheduler.tick('failing');

    expect(record.status).toBe('error');
    expect(record.errorMessage).toBe('SDK boom');
    expect(lastFakeSession!.close).toHaveBeenCalled();

    const records = readTelemetryRecords(telemetryPath);
    expect(records).toHaveLength(1);
    expect((records[0] as { status: string }).status).toBe('error');
  });

  it('multiple ticks append to the same telemetry file', async () => {
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });
    await scheduler.tick('t');
    await scheduler.tick('t');
    await scheduler.tick('t');
    const records = readTelemetryRecords(telemetryPath);
    expect(records).toHaveLength(3);
  });
});

describe('CronScheduler onTaskComplete callback', () => {
  let telemetryPath: string;
  let scheduler: CronScheduler;
  let nextReply: string | Error = 'ok';

  beforeEach(() => {
    telemetryPath = tmpTelemetryFile();
    nextReply = 'ok';
  });

  afterEach(async () => {
    await scheduler.stop();
    rmSync(telemetryPath, { force: true });
  });

  it('fires onTaskComplete with the final telemetry record on success', async () => {
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession(nextReply) as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });
    await scheduler.tick('t');

    expect(callback).toHaveBeenCalledTimes(1);
    const record = callback.mock.calls[0]![0] as { taskId: string; status: string };
    expect(record.taskId).toBe('t');
    expect(record.status).toBe('success');
  });

  it('fires onTaskComplete on error path too', async () => {
    nextReply = new Error('boom');
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession(nextReply) as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });
    await scheduler.tick('t');

    expect(callback).toHaveBeenCalledTimes(1);
    const record = callback.mock.calls[0]![0] as { status: string; errorMessage: string };
    expect(record.status).toBe('error');
    expect(record.errorMessage).toBe('boom');
  });

  it('callback errors do not crash the scheduler or prevent telemetry write', async () => {
    const callback = vi.fn(() => {
      throw new Error('callback crash');
    });
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession(nextReply) as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    await expect(scheduler.tick('t')).resolves.toMatchObject({ status: 'success' });
    expect(callback).toHaveBeenCalledTimes(1);
    const records = readTelemetryRecords(telemetryPath);
    expect(records).toHaveLength(1);
  });

  it('async callback rejection is swallowed (does not crash scheduler)', async () => {
    const callback = vi.fn(async () => {
      throw new Error('async callback crash');
    });
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession(nextReply) as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    await expect(scheduler.tick('t')).resolves.toMatchObject({ status: 'success' });
    // Allow the rejected promise to settle so the test doesn't race the
    // background `.catch` handler.
    await new Promise((r) => setImmediate(r));
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('onTaskComplete is NOT fired when appendFileSync throws', async () => {
    // Point telemetryPath at a location that will fail to write (a directory
    // path masquerading as a file path — writing to a directory errors on all
    // platforms).
    const badTelemetryPath = mkdtempSync(join(tmpdir(), 'agent-afk-badtel-'));
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath: badTelemetryPath, // is a directory, appendFileSync will throw
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession(nextReply) as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    // tick still resolves (telemetry failure is swallowed)
    await expect(scheduler.tick('t')).resolves.toMatchObject({ status: 'success' });
    // callback must NOT have been called because the write threw before it was reached
    expect(callback).not.toHaveBeenCalled();

    rmSync(badTelemetryPath, { recursive: true, force: true });
  });
});

describe('CronScheduler.fireOnStart (Phase 6)', () => {
  let telemetryPath: string;
  let scheduler: CronScheduler;
  let lastFakeSession: FakeAgentSessionShape | null = null;
  let nextReply: string | Error = 'ok';

  beforeEach(() => {
    telemetryPath = tmpTelemetryFile();
    lastFakeSession = null;
    nextReply = 'ok';
  });

  afterEach(async () => {
    await scheduler.stop();
    rmSync(telemetryPath, { force: true });
  });

  function spinScheduler(now: () => number = Date.now, cooldownMs = 0): CronScheduler {
    scheduler = new CronScheduler({
      telemetryPath,
      cooldownMs,
      now,
      sessionFactory: (_config: AgentConfig) => {
        const fake = makeFakeSession(nextReply);
        lastFakeSession = fake;
        return fake as unknown as ReturnType<SessionFactoryReturn>;
      },
    });
    return scheduler;
  }

  it('fires registered sessionstart tasks and records trigger="sessionstart"', async () => {
    nextReply = 'fired';
    spinScheduler();
    scheduler.register({
      taskId: 'ss-task',
      command: '/forge-friction --auto',
      trigger: 'sessionstart',
    });

    const records = await scheduler.fireOnStart();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      taskId: 'ss-task',
      trigger: 'sessionstart',
      status: 'success',
      responseExcerpt: 'fired',
    });
    expect(lastFakeSession!.sendMessage).toHaveBeenCalledWith('/forge-friction --auto');
  });

  it('skips cron-only tasks (no fire-on-start for pure cron)', async () => {
    spinScheduler();
    scheduler.register({
      taskId: 'cron-only',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const records = await scheduler.fireOnStart();
    expect(records).toHaveLength(0);
    expect(lastFakeSession).toBeNull();
  });

  it('fires both-trigger tasks on start (alongside cron registration)', async () => {
    spinScheduler();
    scheduler.register({
      taskId: 'both-task',
      command: 'x',
      trigger: 'both',
      cronExpression: '* * * * *',
    });

    const records = await scheduler.fireOnStart();
    expect(records).toHaveLength(1);
    expect(records[0].trigger).toBe('sessionstart');
    expect(records[0].cronExpression).toBe('* * * * *');
  });

  it('records a skipped telemetry entry when cooldown blocks fire', async () => {
    const nowMs = Date.parse('2026-04-18T12:00:00Z');
    // Seed telemetry with a fire 1h ago.
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({
        taskId: 't',
        triggeredAt: '2026-04-18T11:00:00Z',
      })}\n`,
    );
    spinScheduler(() => nowMs, 6 * 60 * 60 * 1000); // 6h cooldown
    scheduler.register({ taskId: 't', command: 'x', trigger: 'sessionstart' });

    const records = await scheduler.fireOnStart();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      taskId: 't',
      trigger: 'sessionstart',
      status: 'skipped',
      skipReason: 'cooldown',
      durationMs: 0,
    });
    expect(lastFakeSession).toBeNull();
  });

  it('per-task debounceMs overrides scheduler default', async () => {
    const nowMs = Date.parse('2026-04-18T12:00:00Z');
    // 30 min ago — blocked by 1h task-level cooldown but would pass 0 default.
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({
        taskId: 't',
        triggeredAt: '2026-04-18T11:30:00Z',
      })}\n`,
    );
    spinScheduler(() => nowMs, 0); // default: no cooldown
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'sessionstart',
      debounceMs: 60 * 60 * 1000, // override: 1h
    });

    const records = await scheduler.fireOnStart();
    expect(records[0].status).toBe('skipped');
    expect(records[0].skipReason).toBe('cooldown');
  });
});

describe('startDaemon', () => {
  let telemetryPath: string;
  let handle: DaemonHandle | null = null;
  let nextReply: string | Error = 'ok';

  beforeEach(() => {
    telemetryPath = tmpTelemetryFile();
    nextReply = 'ok';
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    rmSync(telemetryPath, { force: true });
  });

  async function spinDaemon(tasks: ScheduledTask[] = []): Promise<DaemonHandle> {
    handle = await startDaemon({
      port: 0, // ask the OS for any free port
      telemetryPath,
      tasks,
      sessionFactory: () => makeFakeSession(nextReply) as unknown as ReturnType<SessionFactoryReturn>,
    });
    return handle;
  }

  it('listens on a port and returns it on the handle', async () => {
    const h = await spinDaemon();
    expect(h.port).toBeGreaterThan(0);
  });

  it('GET /health returns 200 + tasks count', async () => {
    const h = await spinDaemon([
      { taskId: 't1', command: 'x', trigger: 'cron', cronExpression: '* * * * *' },
    ]);
    const res = await fetch(`http://localhost:${h.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; tasks: number };
    expect(body).toEqual({ status: 'ok', tasks: 1 });
  });

  it('GET /tasks returns the task list', async () => {
    const task: ScheduledTask = {
      taskId: 't1',
      command: '/forge-friction --auto',
      trigger: 'cron',
      cronExpression: '0 */6 * * *',
    };
    const h = await spinDaemon([task]);
    const res = await fetch(`http://localhost:${h.port}/tasks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ScheduledTask[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject(task);
  });

  it('returns 404 on unknown routes', async () => {
    const h = await spinDaemon();
    const res = await fetch(`http://localhost:${h.port}/whatever`);
    expect(res.status).toBe(404);
  });

  it('registerTask after start adds to scheduler', async () => {
    const h = await spinDaemon();
    h.registerTask({
      taskId: 'late',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });
    expect(h.scheduler.list().map((t) => t.taskId)).toContain('late');
  });

  it('tickOnce fires a registered task immediately and returns telemetry', async () => {
    nextReply = 'one-shot reply';
    const h = await spinDaemon([
      { taskId: 'demo', command: '/forge-friction --auto', trigger: 'cron', cronExpression: '* * * * *' },
    ]);
    const record = await h.tickOnce('demo');
    expect(record.status).toBe('success');
    expect(record.responseExcerpt).toBe('one-shot reply');
  });

  it('stop() closes the HTTP server', async () => {
    const h = await spinDaemon();
    const port = h.port;
    await h.stop();
    handle = null; // prevent afterEach double-stop
    await expect(fetch(`http://localhost:${port}/health`)).rejects.toThrow();
  });
});

describe('end-to-end: Gap-B closure', () => {
  it('spinning a daemon and firing /forge-friction --auto writes one telemetry record with the expected shape', async () => {
    const telemetryPath = tmpTelemetryFile();
    const handle = await startDaemon({
      port: 0,
      telemetryPath,
      tasks: [
        {
          taskId: 'forge-friction',
          command: '/forge-friction --auto',
          trigger: 'cron',
          cronExpression: '0 */6 * * *',
        },
      ],
      sessionFactory: () =>
        makeFakeSession('forge-friction --auto: 1 theme promoted, /forge invoked') as unknown as ReturnType<
          SessionFactoryReturn
        >,
    });

    try {
      const record = await handle.tickOnce('forge-friction');

      expect(record).toMatchObject({
        taskId: 'forge-friction',
        command: '/forge-friction --auto',
        trigger: 'cron',
        cronExpression: '0 */6 * * *',
        status: 'success',
      });
      expect(record.responseExcerpt).toContain('theme promoted');

      const persisted = readTelemetryRecords(telemetryPath) as Array<{ taskId: string }>;
      expect(persisted).toHaveLength(1);
      expect(persisted[0].taskId).toBe('forge-friction');
    } finally {
      await handle.stop();
      rmSync(telemetryPath, { force: true });
    }
  });
});

describe('POST /tasks and DELETE /tasks/:id routes', () => {
  let telemetryPath: string;
  let handle: DaemonHandle | null = null;

  beforeEach(() => {
    telemetryPath = tmpTelemetryFile();
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    rmSync(telemetryPath, { force: true });
  });

  async function spinDaemon(): Promise<DaemonHandle> {
    handle = await startDaemon({
      port: 0,
      telemetryPath,
      sessionFactory: () => makeFakeSession('ok') as unknown as ReturnType<SessionFactoryReturn>,
    });
    return handle;
  }

  it('POST /tasks with valid body → GET /tasks confirms registration', async () => {
    const h = await spinDaemon();
    const res = await fetch(`http://localhost:${h.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'new-task', command: '/cmd', cron: '* * * * *' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const listRes = await fetch(`http://localhost:${h.port}/tasks`);
    const tasks = (await listRes.json()) as Array<{ taskId: string }>;
    expect(tasks.some((t) => t.taskId === 'new-task')).toBe(true);
  });

  it('POST /tasks with duplicate taskId → 409', async () => {
    const h = await spinDaemon();
    const body = { taskId: 'dup-task', command: '/cmd', cron: '* * * * *' };
    await fetch(`http://localhost:${h.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res2 = await fetch(`http://localhost:${h.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res2.status).toBe(409);
  });

  it('POST /tasks with missing command → 400', async () => {
    const h = await spinDaemon();
    const res = await fetch(`http://localhost:${h.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /tasks preserves a numeric notifyChat through GET /tasks', async () => {
    const h = await spinDaemon();
    const res = await fetch(`http://localhost:${h.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: 'nc-task',
        command: '/cmd',
        cron: '* * * * *',
        notifyChat: -1001234567890,
      }),
    });
    expect(res.status).toBe(201);

    const listRes = await fetch(`http://localhost:${h.port}/tasks`);
    const tasks = (await listRes.json()) as Array<{ taskId: string; notifyChat?: number | string }>;
    const task = tasks.find((t) => t.taskId === 'nc-task');
    expect(task?.notifyChat).toBe(-1001234567890);
  });

  it('POST /tasks preserves a string (alias) notifyChat', async () => {
    const h = await spinDaemon();
    const res = await fetch(`http://localhost:${h.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: 'nc-alias-task',
        command: '/cmd',
        cron: '* * * * *',
        notifyChat: 'ops',
      }),
    });
    expect(res.status).toBe(201);

    const listRes = await fetch(`http://localhost:${h.port}/tasks`);
    const tasks = (await listRes.json()) as Array<{ taskId: string; notifyChat?: number | string }>;
    const task = tasks.find((t) => t.taskId === 'nc-alias-task');
    expect(task?.notifyChat).toBe('ops');
  });

  it('POST /tasks ignores a non-number/non-string notifyChat (default routing)', async () => {
    const h = await spinDaemon();
    const res = await fetch(`http://localhost:${h.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: 'nc-bad-task',
        command: '/cmd',
        cron: '* * * * *',
        notifyChat: { nope: true },
      }),
    });
    expect(res.status).toBe(201);

    const listRes = await fetch(`http://localhost:${h.port}/tasks`);
    const tasks = (await listRes.json()) as Array<{ taskId: string; notifyChat?: number | string }>;
    const task = tasks.find((t) => t.taskId === 'nc-bad-task');
    expect(task?.notifyChat).toBeUndefined();
  });

  it('DELETE /tasks/:id for registered task → 200', async () => {
    const h = await spinDaemon();
    // Register first
    await fetch(`http://localhost:${h.port}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'to-delete', command: '/cmd', cron: '* * * * *' }),
    });
    const res = await fetch(`http://localhost:${h.port}/tasks/to-delete`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('DELETE /tasks/:id for unknown task → 404', async () => {
    const h = await spinDaemon();
    const res = await fetch(`http://localhost:${h.port}/tasks/ghost`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('notifyOn filter in CronScheduler', () => {
  let telemetryPath: string;
  let scheduler: CronScheduler;

  beforeEach(() => {
    telemetryPath = tmpTelemetryFile();
  });

  afterEach(async () => {
    await scheduler.stop();
    rmSync(telemetryPath, { force: true });
  });

  it('notifyOn: failure suppresses callback on success record', async () => {
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession('ok') as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
      notifyOn: 'failure',
    });
    await scheduler.tick('t');

    // Success record should NOT trigger callback because notifyOn is 'failure'
    expect(callback).not.toHaveBeenCalled();
  });

  it('notifyOn: failure triggers callback on error record', async () => {
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession(new Error('boom')) as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
      notifyOn: 'failure',
    });
    await scheduler.tick('t');

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('notifyOn: never suppresses callback always', async () => {
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession('ok') as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
      notifyOn: 'never',
    });
    await scheduler.tick('t');

    expect(callback).not.toHaveBeenCalled();
  });

  it('notifyOn: always triggers callback even on success', async () => {
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession('ok') as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
      notifyOn: 'always',
    });
    await scheduler.tick('t');

    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe('notifyChat threading in CronScheduler', () => {
  let telemetryPath: string;
  let scheduler: CronScheduler;

  beforeEach(() => {
    telemetryPath = tmpTelemetryFile();
  });

  afterEach(async () => {
    await scheduler.stop();
    rmSync(telemetryPath, { force: true });
  });

  it("threads the task's numeric notifyChat onto TaskCompletionDetails", async () => {
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession('ok') as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
      notifyChat: -1001234567890,
    });
    await scheduler.tick('t');

    expect(callback).toHaveBeenCalledTimes(1);
    const details = callback.mock.calls[0]![1] as { notifyChat?: number | string } | undefined;
    expect(details?.notifyChat).toBe(-1001234567890);
  });

  it("threads the task's string (alias) notifyChat onto TaskCompletionDetails", async () => {
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession('ok') as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
      notifyChat: 'ops',
    });
    await scheduler.tick('t');

    const details = callback.mock.calls[0]![1] as { notifyChat?: number | string } | undefined;
    expect(details?.notifyChat).toBe('ops');
  });

  it('leaves notifyChat undefined when the task has none (default routing)', async () => {
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession('ok') as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });
    await scheduler.tick('t');

    const details = callback.mock.calls[0]![1] as { notifyChat?: number | string } | undefined;
    expect(details?.notifyChat).toBeUndefined();
  });

  it('threads notifyChat on the error path too', async () => {
    const callback = vi.fn();
    scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: callback,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession(new Error('boom')) as unknown as ReturnType<SessionFactoryReturn>,
    });
    scheduler.register({
      taskId: 't',
      command: 'x',
      trigger: 'cron',
      cronExpression: '* * * * *',
      notifyChat: 555,
    });
    await scheduler.tick('t');

    const record = callback.mock.calls[0]![0] as { status: string };
    const details = callback.mock.calls[0]![1] as { notifyChat?: number | string } | undefined;
    expect(record.status).toBe('error');
    expect(details?.notifyChat).toBe(555);
  });
});

// SessionFactory return-type indirection — keeps the cast localized so the
// fake-session shape doesn't need to satisfy the full AgentSession class.
type SessionFactoryReturn = NonNullable<
  ConstructorParameters<typeof CronScheduler>[0]
>['sessionFactory'] extends infer F
  ? F extends (...args: never[]) => infer R
    ? () => R
    : never
  : never;

describe('port file lifecycle', () => {
  let tmpHome: string;
  const portFilePath = (): string => join(getDaemonStateDir('default'), 'port');

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'agent-afk-portfile-'));
    vi.stubEnv('AFK_HOME', tmpHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes the port file by default and removes it on stop', async () => {
    const h = await startDaemon({ port: 0 });
    expect(readFileSync(portFilePath(), 'utf-8').trim()).toBe(String(h.port));
    await h.stop();
    expect(existsSync(portFilePath())).toBe(false);
  });

  it('writePortFile: false skips the port file entirely', async () => {
    const h = await startDaemon({ port: 0, writePortFile: false });
    expect(existsSync(portFilePath())).toBe(false);
    await h.stop();
    expect(existsSync(portFilePath())).toBe(false);
  });

  it('stop() leaves a port file it no longer owns intact', async () => {
    const h = await startDaemon({ port: 0 });
    // Another instance (re)claims the discovery path while we are running —
    // unconditional unlink would sever live-sync for that instance.
    writeFileSync(portFilePath(), '65501', 'utf-8');
    await h.stop();
    expect(existsSync(portFilePath())).toBe(true);
    expect(readFileSync(portFilePath(), 'utf-8')).toBe('65501');
  });

  it('binds the control surface to loopback (127.0.0.1) by default', async () => {
    const h = await startDaemon({ port: 0, writePortFile: false });
    // Regression guard: the prior code omitted the host argument, so Node bound
    // the unspecified address (all interfaces) — exposing the unauthenticated
    // control surface to the local network. Loopback-by-default closes that.
    // This assertion fails on the old behaviour (address would be '::'/'0.0.0.0').
    expect(h.host).toBe('127.0.0.1');
    await h.stop();
  });

  it('honors an explicit bind host option', async () => {
    // Exercises the `options.host`-defined branch (the default test above
    // covers the fallback branch). Loopback only — no external interface bind.
    const h = await startDaemon({ port: 0, host: '127.0.0.1', writePortFile: false });
    expect(h.host).toBe('127.0.0.1');
    await h.stop();
  });

  it('POST /tasks accepts cronExpression as an alias for cron', async () => {
    const h = await startDaemon({ port: 0, writePortFile: false });
    try {
      const res = await fetch(`http://localhost:${h.port}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: 'alias-task',
          command: '/x',
          cronExpression: '59 23 31 12 *',
        }),
      });
      expect(res.status).toBe(201);
      const list = (await (await fetch(`http://localhost:${h.port}/tasks`)).json()) as Array<{
        taskId: string;
        cronExpression: string;
      }>;
      expect(
        list.some((t) => t.taskId === 'alias-task' && t.cronExpression === '59 23 31 12 *'),
      ).toBe(true);
    } finally {
      await h.stop();
    }
  });
});
