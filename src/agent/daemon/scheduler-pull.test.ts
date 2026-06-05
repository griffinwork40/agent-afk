/**
 * Pull-loop tests for CronScheduler.
 *
 * Uses vi.useFakeTimers() to advance the poll interval without real
 * I/O delays. Real queue files are written to a mkdtempSync directory
 * injected via SchedulerOptions.queueDir. Session spawning is mocked.
 *
 * @module agent/daemon/scheduler-pull.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CronScheduler } from './scheduler.js';
import { enqueue } from './queue-store.js';
import type { AgentConfig } from '../types.js';
import type { AgentSession } from '../session/agent-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSession(response = 'ok'): AgentSession {
  return {
    sendMessage: vi.fn().mockResolvedValue({ content: response }),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentSession;
}

function makeScheduler(
  queueDir: string,
  telemetryPath: string,
  sessionFactory?: (config: AgentConfig) => AgentSession,
): CronScheduler {
  return new CronScheduler({
    queueDir,
    telemetryPath,
    pullPollIntervalMs: 30_000,
    sessionFactory: sessionFactory ?? (() => makeMockSession()),
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let queueDir: string;
let telemetryDir: string;
let telemetryPath: string;

beforeEach(() => {
  vi.useFakeTimers();
  queueDir = mkdtempSync(join(tmpdir(), 'afk-pull-test-queue-'));
  telemetryDir = mkdtempSync(join(tmpdir(), 'afk-pull-test-tel-'));
  telemetryPath = join(telemetryDir, 'forge-telemetry.jsonl');
});

afterEach(async () => {
  vi.useRealTimers();
  rmSync(queueDir, { recursive: true, force: true });
  rmSync(telemetryDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startPullLoop', () => {
  it('is idempotent — calling twice does not create a second interval', async () => {
    const scheduler = makeScheduler(queueDir, telemetryPath);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    scheduler.startPullLoop();
    scheduler.startPullLoop(); // second call should be a no-op

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    await scheduler.stop();
    setIntervalSpy.mockRestore();
  });

  it('does not fire when pullPollIntervalMs is 0', async () => {
    const scheduler = new CronScheduler({
      queueDir,
      telemetryPath,
      pullPollIntervalMs: 0,
      sessionFactory: () => makeMockSession(),
    });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    scheduler.startPullLoop();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    await scheduler.stop();
    setIntervalSpy.mockRestore();
  });
});

describe('pull tick — idle dequeue', () => {
  it('dequeues and fires runOnce when idle, writing a pull telemetry record', async () => {
    enqueue('/forge-friction --auto', {}, queueDir);

    const scheduler = makeScheduler(queueDir, telemetryPath);
    scheduler.startPullLoop();

    // Advance past one poll interval
    await vi.advanceTimersByTimeAsync(30_000);

    const lines = readFileSync(telemetryPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.trigger).toBe('pull');
    expect(record.command).toBe('/forge-friction --auto');
    expect(record.status).toBe('success');

    await scheduler.stop();
  });

  it('dequeues exactly one task per tick when multiple are queued', async () => {
    enqueue('task-a', {}, queueDir);
    enqueue('task-b', {}, queueDir);

    const scheduler = makeScheduler(queueDir, telemetryPath);
    scheduler.startPullLoop();

    // One tick
    await vi.advanceTimersByTimeAsync(30_000);

    const lines = readFileSync(telemetryPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.command).toBe('task-a'); // FIFO: first in, first out

    await scheduler.stop();
  });

  it('dequeues the second task on the second tick', async () => {
    enqueue('task-a', {}, queueDir);
    enqueue('task-b', {}, queueDir);

    const scheduler = makeScheduler(queueDir, telemetryPath);
    scheduler.startPullLoop();

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    const lines = readFileSync(telemetryPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).command).toBe('task-a');
    expect(JSON.parse(lines[1]!).command).toBe('task-b');

    await scheduler.stop();
  });

  it('does nothing on a tick when the queue is empty', async () => {
    const scheduler = makeScheduler(queueDir, telemetryPath);
    scheduler.startPullLoop();

    await vi.advanceTimersByTimeAsync(30_000);

    // Telemetry file should not exist (nothing was written)
    let exists = true;
    try { readFileSync(telemetryPath, 'utf-8'); } catch { exists = false; }
    expect(exists).toBe(false);

    await scheduler.stop();
  });
});

describe('pull tick — telemetry record fields', () => {
  it('carries the QueuedTask id as the telemetry taskId', async () => {
    const queued = enqueue('/my-command', {}, queueDir);

    const scheduler = makeScheduler(queueDir, telemetryPath);
    scheduler.startPullLoop();
    await vi.advanceTimersByTimeAsync(30_000);

    const record = JSON.parse(readFileSync(telemetryPath, 'utf-8').trim());
    expect(record.taskId).toBe(queued.id);
    expect(record.trigger).toBe('pull');

    await scheduler.stop();
  });
});

describe('isDequeuing mutex', () => {
  it('prevents double-fire when the previous task is still running', async () => {
    // Simulate a slow session: holds open until we resolve it
    let resolveSlowSession!: (val: { content: string }) => void;
    const slowSession: AgentSession = {
      sendMessage: vi.fn().mockImplementation(
        () => new Promise<{ content: string }>((res) => { resolveSlowSession = res; }),
      ),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSession;

    enqueue('slow-task', {}, queueDir);
    enqueue('fast-task', {}, queueDir);

    const scheduler = makeScheduler(queueDir, telemetryPath, () => slowSession);
    scheduler.startPullLoop();

    // First tick fires — slow-task is now in-flight (isDequeuing = true, session blocked)
    await vi.advanceTimersByTimeAsync(30_000);

    // Second tick should be a no-op because isDequeuing is still true
    await vi.advanceTimersByTimeAsync(30_000);

    // Only one sendMessage call — the second tick was blocked by the mutex
    expect(slowSession.sendMessage).toHaveBeenCalledTimes(1);

    // Resolve the slow session so we can shut down cleanly
    resolveSlowSession({ content: 'done' });
    // Flush microtasks (Promise resolution chain)
    await Promise.resolve();
    await Promise.resolve();
    await scheduler.stop();
  });
});

describe('stop', () => {
  it('clears the interval — no lingering timer after stop()', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const scheduler = makeScheduler(queueDir, telemetryPath);
    scheduler.startPullLoop();
    await scheduler.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    clearIntervalSpy.mockRestore();
  });

  it('stop() is idempotent when startPullLoop was never called', async () => {
    const scheduler = makeScheduler(queueDir, telemetryPath);
    // Should not throw
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });
});
