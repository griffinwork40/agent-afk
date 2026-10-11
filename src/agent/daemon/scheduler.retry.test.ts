/**
 * Integration tests for optional cron-task retries wired into CronScheduler
 * (#3243 gap 3). Uses the `sessionFactory` seam so no real AgentSession runs.
 *
 * @module agent/daemon/scheduler.retry.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({ start: () => {}, stop: () => {}, destroy: () => {}, getStatus: () => 'stopped' })),
}));

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used in retry tests'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({ registry: undefined, memoryStore: { close: () => {} } }),
}));

import { CronScheduler, type TelemetryRecord } from './scheduler.js';
import type { AgentSession } from '../session/agent-session.js';
import type { ScheduledTask } from './triggers.js';

type Factory = NonNullable<ConstructorParameters<typeof CronScheduler>[0]>['sessionFactory'];

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Each spawned session runs the next script step: an Error throws, a string resolves. */
function scriptedFactory(steps: Array<Error | string>, counter: { n: number }): Factory {
  return (() => {
    const step = steps[Math.min(counter.n, steps.length - 1)]!;
    counter.n += 1;
    return {
      sendMessage: () => step instanceof Error
        ? Promise.reject(step)
        : Promise.resolve({ role: 'assistant', content: step, timestamp: new Date() }),
      close: () => Promise.resolve(),
    } as unknown as AgentSession;
  }) as Factory;
}

function task(extra: Partial<ScheduledTask> = {}): ScheduledTask {
  return { taskId: 'retry-task', command: '/cmd', trigger: 'cron', cronExpression: '* * * * *', ...extra };
}

describe('CronScheduler optional retries', () => {
  let dir: string;
  let telemetryPath: string;
  let savedAfkHome: string | undefined;
  let savedProjectMcp: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-sched-retry-'));
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
    savedAfkHome = process.env['AFK_HOME'];
    savedProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
    process.env['AFK_HOME'] = dir;
    process.env['AFK_ALLOW_PROJECT_MCP'] = '0';
  });

  afterEach(() => {
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    if (savedProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
    else process.env['AFK_ALLOW_PROJECT_MCP'] = savedProjectMcp;
    rmSync(dir, { recursive: true, force: true });
  });

  function readRecords(): TelemetryRecord[] {
    return readFileSync(telemetryPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as TelemetryRecord);
  }

  function makeScheduler(steps: Array<Error | string>, counter: { n: number }, retrySleep?: (ms: number, s: AbortSignal) => Promise<void>): CronScheduler {
    return new CronScheduler({
      telemetryPath,
      budgetGate: async () => ({ skip: false }),
      sessionFactory: scriptedFactory(steps, counter),
      ...(retrySleep ? { retrySleep } : {}),
    });
  }

  it('default (no maxAttempts) → a transient failure is not retried; no attempts field', async () => {
    const counter = { n: 0 };
    const s = makeScheduler([httpError(503), 'ok'], counter, async () => {});
    s.register(task());
    const rec = await s.tick('retry-task');
    await s.stop();
    expect(counter.n).toBe(1);
    expect(rec.status).toBe('error');
    expect(rec.attempts).toBeUndefined();
  });

  it('maxAttempts=2: transient failure then success → success, attempts=2, one telemetry record', async () => {
    const counter = { n: 0 };
    const delays: number[] = [];
    const s = makeScheduler([httpError(429), 'all good'], counter, async (ms) => { delays.push(ms); });
    s.register(task({ maxAttempts: 2, retryDelayMs: 1_000 }));
    const rec = await s.tick('retry-task');
    await s.stop();
    expect(counter.n).toBe(2);
    expect(rec.status).toBe('success');
    expect(rec.attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'success', attempts: 2 });
  });

  it('non-transient failure never retries even with maxAttempts=5', async () => {
    const counter = { n: 0 };
    const s = makeScheduler([new Error('tool exploded'), 'ok'], counter, async () => {});
    s.register(task({ maxAttempts: 5 }));
    const rec = await s.tick('retry-task');
    await s.stop();
    expect(counter.n).toBe(1);
    expect(rec).toMatchObject({ status: 'error', attempts: 1, errorMessage: 'tool exploded' });
  });

  it('stop() during backoff ends the run promptly without another attempt', async () => {
    const counter = { n: 0 };
    // Real (default) sleepWithAbort with a long delay: only the abort ends it.
    const s = makeScheduler([httpError(503), 'ok'], counter);
    s.register(task({ maxAttempts: 3, retryDelayMs: 60_000 }));
    const started = Date.now();
    const pending = s.tick('retry-task');
    await new Promise((r) => setTimeout(r, 20));
    await s.stop();
    const rec = await pending;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(counter.n).toBe(1);
    expect(rec).toMatchObject({ status: 'error', attempts: 1 });
  });

  it('a tick landing during a retry backoff is an overlap skip (guard held across retries)', async () => {
    const counter = { n: 0 };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = makeScheduler([httpError(503), 'ok'], counter, () => gate);
    s.register(task({ maxAttempts: 2 }));
    const first = s.tick('retry-task');
    await new Promise((r) => setTimeout(r, 10));
    const overlapped = await s.tick('retry-task');
    expect(overlapped).toMatchObject({ status: 'skipped', skipReason: 'overlap' });
    release();
    const rec = await first;
    await s.stop();
    expect(rec).toMatchObject({ status: 'success', attempts: 2 });
    expect(counter.n).toBe(2);
  });
});
