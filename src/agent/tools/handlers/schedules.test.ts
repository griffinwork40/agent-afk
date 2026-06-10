/**
 * Tests for schedule tool handlers.
 *
 * Uses vi.stubEnv('AFK_HOME', tmpDir) to redirect the default schedules.json
 * path so tests are fully isolated from the real ~/.afk/ directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createScheduleHandler,
  listSchedulesHandler,
  getScheduleHistoryHandler,
  cancelScheduleHandler,
} from './schedules.js';
import { startDaemon } from '../../daemon.js';

vi.mock('../../../utils/debug.js', () => ({ debugLog: vi.fn() }));

// A no-op AbortSignal for handler invocations
const fakeSignal = new AbortController().signal;

describe('create_schedule handler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedules-handler-'));
    vi.stubEnv('AFK_HOME', tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes file and returns correct shape', async () => {
    const result = await createScheduleHandler(
      { name: 'Test Task', command: '/test', cron: '0 2 * * *' },
      fakeSignal,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as {
      id: string;
      name: string;
      cron: string;
      enabled: boolean;
    };
    expect(parsed.id).toBe('test-task');
    expect(parsed.name).toBe('Test Task');
    expect(parsed.cron).toBe('0 2 * * *');
    expect(parsed.enabled).toBe(true);
  });

  it('invalid cron (3 fields) → isError: true', async () => {
    const result = await createScheduleHandler(
      { name: 'Bad Cron', command: '/cmd', cron: '* * *' },
      fakeSignal,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/cron/i);
  });

  it('duplicate name → slug collision resolved to -2', async () => {
    // Create first task
    await createScheduleHandler(
      { name: 'My Task', command: '/cmd1', cron: '* * * * *' },
      fakeSignal,
    );
    // Create second task with same name
    const result = await createScheduleHandler(
      { name: 'My Task', command: '/cmd2', cron: '* * * * *' },
      fakeSignal,
    );
    const parsed = JSON.parse(result.content as string) as { id: string };
    expect(parsed.id).toBe('my-task-2');
  });

  it('missing name → isError: true', async () => {
    const result = await createScheduleHandler(
      { command: '/cmd', cron: '* * * * *' },
      fakeSignal,
    );
    expect(result.isError).toBe(true);
  });

  it('daemon not running → create_schedule writes file, fetch silently fails, returns success', async () => {
    // No port file exists in tmpDir, so trySyncToDaemon exits early
    const result = await createScheduleHandler(
      { name: 'Silent Daemon', command: '/silent', cron: '0 6 * * *' },
      fakeSignal,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as { id: string };
    expect(parsed.id).toBe('silent-daemon');
  });
});

describe('list_schedules handler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedules-handler-'));
    vi.stubEnv('AFK_HOME', tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('empty store → returns []', async () => {
    const result = await listSchedulesHandler(null, fakeSignal);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as unknown[];
    expect(parsed).toEqual([]);
  });

  it('after create → returns array with correct fields', async () => {
    await createScheduleHandler(
      { name: 'List Test', command: '/list', cron: '30 1 * * *', notifyOn: 'always' },
      fakeSignal,
    );
    const result = await listSchedulesHandler(null, fakeSignal);
    const parsed = JSON.parse(result.content as string) as Array<{
      id: string;
      name: string;
      cron: string;
      enabled: boolean;
      notifyOn?: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe('list-test');
    expect(parsed[0]?.cron).toBe('30 1 * * *');
    expect(parsed[0]?.enabled).toBe(true);
    expect(parsed[0]?.notifyOn).toBe('always');
  });
});

describe('cancel_schedule handler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedules-handler-'));
    vi.stubEnv('AFK_HOME', tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('non-existent taskId → { error: "task not found" }, no throw', async () => {
    const result = await cancelScheduleHandler(
      { taskId: 'ghost-task' },
      fakeSignal,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as { error?: string };
    expect(parsed.error).toBe('task not found');
  });

  it('permanent: true → removes from store', async () => {
    // Create first
    await createScheduleHandler(
      { name: 'To Delete', command: '/del', cron: '* * * * *' },
      fakeSignal,
    );
    // Now cancel permanently
    const result = await cancelScheduleHandler(
      { taskId: 'to-delete', permanent: true },
      fakeSignal,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as { ok: boolean };
    expect(parsed.ok).toBe(true);

    // Verify it's gone
    const listResult = await listSchedulesHandler(null, fakeSignal);
    const list = JSON.parse(listResult.content as string) as unknown[];
    expect(list).toHaveLength(0);
  });

  it('permanent: false → sets enabled: false', async () => {
    await createScheduleHandler(
      { name: 'To Disable', command: '/dis', cron: '* * * * *' },
      fakeSignal,
    );
    const result = await cancelScheduleHandler(
      { taskId: 'to-disable', permanent: false },
      fakeSignal,
    );
    expect(result.isError).toBeUndefined();

    const listResult = await listSchedulesHandler(null, fakeSignal);
    const list = JSON.parse(listResult.content as string) as Array<{
      id: string;
      enabled: boolean;
    }>;
    expect(list[0]?.enabled).toBe(false);
  });
});

describe('get_schedule_history handler', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedules-handler-'));
    vi.stubEnv('AFK_HOME', tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no telemetry file → returns []', async () => {
    const result = await getScheduleHistoryHandler(
      { taskId: 'nope' },
      fakeSignal,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as unknown[];
    expect(parsed).toEqual([]);
  });

  it('returns matching records from telemetry', async () => {
    // Create a fake telemetry file inside the tmpDir agent-framework dir
    const afDir = join(tmpDir, 'agent-framework');
    mkdirSync(afDir, { recursive: true });
    const telemetryPath = join(afDir, 'forge-telemetry.jsonl');
    const records = [
      { taskId: 'task-a', status: 'success', triggeredAt: '2024-01-01T00:00:00Z' },
      { taskId: 'task-b', status: 'error', triggeredAt: '2024-01-01T01:00:00Z' },
      { taskId: 'task-a', status: 'success', triggeredAt: '2024-01-01T02:00:00Z' },
    ];
    writeFileSync(telemetryPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    const result = await getScheduleHistoryHandler({ taskId: 'task-a', limit: 10 }, fakeSignal);
    const parsed = JSON.parse(result.content as string) as Array<{ taskId: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed.every((r) => r.taskId === 'task-a')).toBe(true);
  });

  it('respects limit parameter', async () => {
    const afDir = join(tmpDir, 'agent-framework');
    mkdirSync(afDir, { recursive: true });
    const telemetryPath = join(afDir, 'forge-telemetry.jsonl');
    // Write 5 records for the same task
    const records = Array.from({ length: 5 }, (_, i) => ({
      taskId: 'limited',
      status: 'success',
      triggeredAt: `2024-01-0${i + 1}T00:00:00Z`,
    }));
    writeFileSync(telemetryPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    const result = await getScheduleHistoryHandler({ taskId: 'limited', limit: 3 }, fakeSignal);
    const parsed = JSON.parse(result.content as string) as unknown[];
    expect(parsed).toHaveLength(3);
  });

  it('missing taskId → isError: true', async () => {
    const result = await getScheduleHistoryHandler({}, fakeSignal);
    expect(result.isError).toBe(true);
  });
});

describe('live-sync surface (daemonSynced)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedules-sync-'));
    vi.stubEnv('AFK_HOME', tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  interface SyncShape {
    id?: string;
    enabled?: boolean;
    ok?: boolean;
    daemonSynced: boolean;
    syncDetail: string;
    syncNote?: string;
  }

  it('reports daemonSynced: false (with note) when no daemon is running', async () => {
    const result = await createScheduleHandler(
      { name: 'Lonely Task', command: '/x', cron: '0 8 * * *' },
      fakeSignal,
    );
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as SyncShape;
    expect(parsed.daemonSynced).toBe(false);
    expect(parsed.syncDetail).toMatch(/daemon-not-detected/);
    expect(parsed.syncNote).toMatch(/next daemon/i);
  });

  it('live daemon: create registers the task and reports synced', async () => {
    const handle = await startDaemon({ port: 0 });
    try {
      const result = await createScheduleHandler(
        { name: 'Live Task', command: '/x', cron: '59 23 31 12 *' },
        fakeSignal,
      );
      const parsed = JSON.parse(result.content as string) as SyncShape;
      expect(parsed.daemonSynced).toBe(true);
      expect(parsed.syncDetail).toBe('synced');
      const tasks = (await (await fetch(`http://localhost:${handle.port}/tasks`)).json()) as Array<{
        taskId: string;
      }>;
      expect(tasks.some((t) => t.taskId === 'live-task')).toBe(true);
    } finally {
      await handle.stop();
    }
  });

  it('already-registered in daemon counts as synced (409 → end-state match)', async () => {
    const handle = await startDaemon({
      port: 0,
      tasks: [
        { taskId: 'dup-task', command: '/x', trigger: 'cron', cronExpression: '59 23 31 12 *' },
      ],
    });
    try {
      const result = await createScheduleHandler(
        { name: 'Dup Task', command: '/x', cron: '59 23 31 12 *' },
        fakeSignal,
      );
      const parsed = JSON.parse(result.content as string) as SyncShape;
      expect(parsed.daemonSynced).toBe(true);
      expect(parsed.syncDetail).toBe('already-registered');
    } finally {
      await handle.stop();
    }
  });

  it('disabled task is NOT live-registered into the daemon', async () => {
    const handle = await startDaemon({ port: 0 });
    try {
      const result = await createScheduleHandler(
        { name: 'Sleepy Task', command: '/x', cron: '59 23 31 12 *', enabled: false },
        fakeSignal,
      );
      const parsed = JSON.parse(result.content as string) as SyncShape;
      expect(parsed.daemonSynced).toBe(true);
      expect(parsed.syncDetail).toMatch(/disabled/);
      const tasks = (await (await fetch(`http://localhost:${handle.port}/tasks`)).json()) as Array<{
        taskId: string;
      }>;
      expect(tasks.some((t) => t.taskId === 'sleepy-task')).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it('cancel against a live daemon unregisters and reports synced', async () => {
    const handle = await startDaemon({ port: 0 });
    try {
      await createScheduleHandler(
        { name: 'Cancel Me', command: '/x', cron: '59 23 31 12 *' },
        fakeSignal,
      );
      const cancel = await cancelScheduleHandler(
        { taskId: 'cancel-me', permanent: true },
        fakeSignal,
      );
      const parsed = JSON.parse(cancel.content as string) as SyncShape;
      expect(parsed.ok).toBe(true);
      expect(parsed.daemonSynced).toBe(true);
      const tasks = (await (await fetch(`http://localhost:${handle.port}/tasks`)).json()) as Array<{
        taskId: string;
      }>;
      expect(tasks.some((t) => t.taskId === 'cancel-me')).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it('cancel with no daemon reports daemonSynced: false', async () => {
    await createScheduleHandler({ name: 'Ghost', command: '/x', cron: '0 8 * * *' }, fakeSignal);
    const cancel = await cancelScheduleHandler({ taskId: 'ghost' }, fakeSignal);
    const parsed = JSON.parse(cancel.content as string) as SyncShape;
    expect(parsed.ok).toBe(true);
    expect(parsed.daemonSynced).toBe(false);
    expect(parsed.syncNote).toMatch(/next daemon/i);
  });
});
