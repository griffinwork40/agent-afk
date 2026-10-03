/**
 * Scheduler integration tests for the daemon budget gate.
 *
 * Verifies:
 *  - skip when over: telemetry written, onTaskComplete fires
 *  - shell tasks are never gated
 *  - lease invariant: no lease file created on budget skip
 *  - pass when ok/unknown/stale (gate returns skip:false)
 *
 * Uses vi.mock('./budget-gate.js') to control gate results without real
 * network calls. Unit tests for evaluateBudgetGate itself are in
 * budget-gate.test.ts.
 *
 * @module agent/daemon/budget-gate.scheduler.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelemetryRecord, TaskCompletionDetails } from './scheduler.js';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be at the very top before any imports of mocked modules)
// ---------------------------------------------------------------------------

const budgetMock = vi.hoisted(() => ({
  result: { skip: false } as import('./budget-gate.js').BudgetGateResult,
}));

vi.mock('./budget-gate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./budget-gate.js')>();
  return {
    ...original,
    evaluateBudgetGate: vi.fn(async () => budgetMock.result),
  };
});

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used in budget gate tests'); },
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
    responseExcerpt: 'ok',
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CronScheduler } from './scheduler.js';
import { runShellTask } from './shell-task.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-afk-bgsched-'));
}

function overSkipResult(): import('./budget-gate.js').BudgetGateResult {
  return {
    skip: true,
    provider: 'anthropic',
    binding: { key: 'fiveHour', label: '5h', utilization: 0.95, pct: 95 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CronScheduler + budget gate', () => {
  let dir: string;
  let telemetryPath: string;
  let savedAfkHome: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
    savedAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = dir;
    // Reset to pass by default
    budgetMock.result = { skip: false };
  });

  afterEach(() => {
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes budget-over skipped telemetry and invokes onTaskComplete', async () => {
    budgetMock.result = overSkipResult();

    const notifications: Array<[TelemetryRecord, TaskCompletionDetails | undefined]> = [];
    const scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: (record, details) => {
        notifications.push([record, details]);
      },
    });

    scheduler.register({
      taskId: 'budget-over-task',
      command: 'do something',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'agent',
    });

    const record = await scheduler.tick('budget-over-task');
    await scheduler.stop();

    expect(record.status).toBe('skipped');
    expect(record.skipReason).toBe('budget-over');
    expect(record.errorMessage).toContain('Claude 5h window');
    expect(record.errorMessage).toContain('95%');

    // Telemetry persisted to disk
    const lines = readFileSync(telemetryPath, 'utf-8').trim().split('\n');
    const parsed = JSON.parse(lines[lines.length - 1]) as TelemetryRecord;
    expect(parsed.skipReason).toBe('budget-over');
    expect(parsed.taskId).toBe('budget-over-task');

    // Notification fired
    expect(notifications.length).toBeGreaterThan(0);
    const [notifRecord] = notifications[0];
    expect(notifRecord.skipReason).toBe('budget-over');
  });

  it('shell tasks (executor: shell) are never gated — run even when budget is over', async () => {
    budgetMock.result = overSkipResult();

    vi.mocked(runShellTask).mockClear();

    const scheduler = new CronScheduler({ telemetryPath });
    scheduler.register({
      taskId: 'shell-immune',
      command: 'echo hello',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'shell',
    });

    const record = await scheduler.tick('shell-immune');
    await scheduler.stop();

    // Shell task ran, not gated
    expect(record.skipReason).not.toBe('budget-over');
    expect(vi.mocked(runShellTask)).toHaveBeenCalledOnce();
  });

  it('passes agent task when budget is ok (gate returns skip:false)', async () => {
    budgetMock.result = { skip: false };

    const fakeSession = {
      sendMessage: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'Done' }] },
        metadata: { successfulToolNames: [] },
      }),
      dispose: vi.fn(),
      close: vi.fn(),
      traceWriter: undefined,
    };

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => fakeSession as unknown as import('../session/agent-session.js').AgentSession,
    });

    scheduler.register({
      taskId: 'ok-agent-task',
      command: 'do work',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'agent',
    });

    const record = await scheduler.tick('ok-agent-task');
    await scheduler.stop();

    expect(record.skipReason).not.toBe('budget-over');
  });

  it('passes agent task when budget is unknown/stale (gate returns skip:false)', async () => {
    // Unknown = usage unavailable — gate always passes fail-open
    budgetMock.result = { skip: false };

    const fakeSession = {
      sendMessage: vi.fn().mockResolvedValue({
        response: { content: [{ type: 'text', text: 'Done' }] },
        metadata: { successfulToolNames: [] },
      }),
      dispose: vi.fn(),
      close: vi.fn(),
      traceWriter: undefined,
    };

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => fakeSession as unknown as import('../session/agent-session.js').AgentSession,
    });

    scheduler.register({
      taskId: 'unknown-usage-task',
      command: 'do work',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'agent',
    });

    const record = await scheduler.tick('unknown-usage-task');
    await scheduler.stop();

    expect(record.skipReason).not.toBe('budget-over');
  });

  it('lease invariant: no leased/ file created when budget gate skips the task', async () => {
    budgetMock.result = overSkipResult();

    const queueDir = join(dir, 'queue');
    const scheduler = new CronScheduler({ telemetryPath, queueDir });
    scheduler.register({
      taskId: 'lease-guard',
      command: 'check',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'agent',
    });

    const record = await scheduler.tick('lease-guard');
    await scheduler.stop();

    expect(record.status).toBe('skipped');

    // leased/ directory must not exist — no lease was claimed before the skip
    const leasedDir = join(queueDir, 'leased');
    expect(existsSync(leasedDir)).toBe(false);
  });

  it('notification fires with always semantics on budget skip (even if notifyOn is not set)', async () => {
    budgetMock.result = overSkipResult();

    const notifications: TelemetryRecord[] = [];
    const scheduler = new CronScheduler({
      telemetryPath,
      onTaskComplete: (record) => notifications.push(record),
    });

    scheduler.register({
      taskId: 'notify-check',
      command: 'run',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'agent',
      notifyOn: 'failure',  // would normally suppress 'skipped' results
    });

    await scheduler.tick('notify-check');
    await scheduler.stop();

    // Budget skip overrides notifyOn and always notifies
    expect(notifications.length).toBeGreaterThan(0);
  });
});

describe('CronScheduler + budget gate: one alert per episode', () => {
  let dir: string;
  let savedAfkHome: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    savedAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = dir;
    budgetMock.result = { skip: false };
  });

  afterEach(() => {
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('alerts on the first skip, suppresses the rest, and re-alerts after a pass', async () => {
    const delivered: TelemetryRecord[] = [];
    const scheduler = new CronScheduler({
      telemetryPath: join(dir, 'forge-telemetry.jsonl'),
      // fireOnTaskComplete applies the notifyOn filter before this callback.
      onTaskComplete: (record) => delivered.push(record),
    });
    for (const id of ['a', 'b']) {
      scheduler.register({ taskId: id, command: 'run', trigger: 'cron', cronExpression: '* * * * *', executor: 'agent' });
    }

    budgetMock.result = overSkipResult();
    await scheduler.tick('a');
    await scheduler.tick('b');
    await scheduler.tick('a');
    expect(delivered).toHaveLength(1);

    const lines = readFileSync(join(dir, 'forge-telemetry.jsonl'), 'utf-8').trim().split('\n');
    expect(lines.filter((l) => l.includes('budget-over'))).toHaveLength(3); // every skip is still recorded

    budgetMock.result = { skip: false };
    await scheduler.tick('a').catch(() => undefined); // passes the gate (session may fail in this harness)
    budgetMock.result = overSkipResult();
    await scheduler.tick('b');
    await scheduler.stop();
    expect(delivered.filter((r) => r.skipReason === 'budget-over')).toHaveLength(2);
  });
});
