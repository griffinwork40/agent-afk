/**
 * Tests for CronScheduler with multiple registered tasks.
 *
 * Verifies that two tasks with distinct cron expressions each produce
 * independent telemetry records — i.e., tick() on task A never writes
 * task B's record, and vice versa.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, Message } from '../types.js';
import { CronScheduler } from './scheduler.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

function tmpTelemetryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-multitask-'));
  return join(dir, 'forge-telemetry.jsonl');
}

function readTelemetryRecords(path: string): Array<{ taskId: string; status: string; trigger: string }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { taskId: string; status: string; trigger: string });
}

type FakeSession = {
  sendMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function makeFakeSession(reply: string | Error): FakeSession {
  return {
    sendMessage: vi.fn(async (_content: string): Promise<Message> => {
      if (reply instanceof Error) throw reply;
      return { role: 'assistant', content: reply, timestamp: new Date() };
    }),
    close: vi.fn(async () => undefined),
  };
}

describe('CronScheduler multi-task', () => {
  let telemetryPath: string;
  let scheduler: CronScheduler;

  beforeEach(() => {
    telemetryPath = tmpTelemetryFile();
    scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: (_config: AgentConfig) =>
        makeFakeSession('ok') as unknown as ReturnType<
          NonNullable<ConstructorParameters<typeof CronScheduler>[0]>['sessionFactory']
        >,
    });
  });

  afterEach(async () => {
    await scheduler.stop();
    rmSync(telemetryPath, { force: true });
  });

  it('registers 2 tasks with distinct cron expressions', () => {
    scheduler.register({ taskId: 'task-a', command: '/cmd-a', trigger: 'cron', cronExpression: '* * * * *' });
    scheduler.register({ taskId: 'task-b', command: '/cmd-b', trigger: 'cron', cronExpression: '0 * * * *' });

    const ids = scheduler.list().map((t) => t.taskId);
    expect(ids).toContain('task-a');
    expect(ids).toContain('task-b');
    expect(ids).toHaveLength(2);
  });

  it('tick() task A → only task A record written', async () => {
    scheduler.register({ taskId: 'task-a', command: '/cmd-a', trigger: 'cron', cronExpression: '* * * * *' });
    scheduler.register({ taskId: 'task-b', command: '/cmd-b', trigger: 'cron', cronExpression: '0 * * * *' });

    await scheduler.tick('task-a');

    const records = readTelemetryRecords(telemetryPath);
    expect(records).toHaveLength(1);
    expect(records[0]?.taskId).toBe('task-a');
  });

  it('tick() task B → task B record written', async () => {
    scheduler.register({ taskId: 'task-a', command: '/cmd-a', trigger: 'cron', cronExpression: '* * * * *' });
    scheduler.register({ taskId: 'task-b', command: '/cmd-b', trigger: 'cron', cronExpression: '0 * * * *' });

    await scheduler.tick('task-b');

    const records = readTelemetryRecords(telemetryPath);
    expect(records).toHaveLength(1);
    expect(records[0]?.taskId).toBe('task-b');
  });

  it('both records present after ticking both tasks', async () => {
    scheduler.register({ taskId: 'task-a', command: '/cmd-a', trigger: 'cron', cronExpression: '* * * * *' });
    scheduler.register({ taskId: 'task-b', command: '/cmd-b', trigger: 'cron', cronExpression: '0 * * * *' });

    await scheduler.tick('task-a');
    await scheduler.tick('task-b');

    const records = readTelemetryRecords(telemetryPath);
    expect(records).toHaveLength(2);
    const ids = records.map((r) => r.taskId);
    expect(ids).toContain('task-a');
    expect(ids).toContain('task-b');
  });
});
