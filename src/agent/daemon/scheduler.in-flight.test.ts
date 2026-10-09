/**
 * Tests for CronScheduler.getInFlightTasks() (#3248) against a REAL scheduler
 * instance with an injected clock — in particular that the command head is
 * secret-redacted before it can reach a crash notice (#3323 review finding:
 * crash notices are pushed to Telegram verbatim, pushIfConfigured does not
 * redact).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

// Never arm a real wall-clock cron timer — runs are driven via tick().
vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

// Drive in-flight duration deterministically: the shell executor blocks on a
// test-controlled gate instead of spawning a child process.
const gateState = vi.hoisted(() => ({ release: (): void => undefined, gate: Promise.resolve() }));
vi.mock('./shell-task.js', () => ({
  runShellTask: vi.fn(async (task: { taskId: string; command: string }) => {
    await gateState.gate;
    return {
      taskId: task.taskId,
      command: task.command,
      trigger: 'cron' as const,
      triggeredAt: new Date().toISOString(),
      durationMs: 0,
      status: 'success' as const,
    };
  }),
}));

import { CronScheduler } from './scheduler.js';

describe('CronScheduler.getInFlightTasks', () => {
  let dir: string;
  let nowMs: number;
  let scheduler: CronScheduler;
  const releaseRun = (): void => gateState.release();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scheduler-in-flight-'));
    nowMs = 1_000_000;
    gateState.gate = new Promise<void>((resolve) => { gateState.release = resolve; });
    scheduler = new CronScheduler({
      telemetryPath: join(dir, 'telemetry.jsonl'),
      now: () => nowMs,
      sessionConfig: { cwd: dir },
    });
  });

  afterEach(async () => {
    releaseRun();
    await scheduler.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Start a tick and yield until the in-flight entry is recorded. Returns the
   * pending run wrapped in an object — returning the bare promise from an
   * async function would flatten it and await the whole (gated) run.
   */
  async function startTick(taskId: string): Promise<{ pending: Promise<unknown> }> {
    const pending = scheduler.tick(taskId);
    await Promise.resolve();
    return { pending };
  }

  it('redacts an inline secret in the command head (redact before truncate)', async () => {
    // sk- pattern needs ≥20 chars after "sk-" (prompt-dump.ts INLINE_SECRET_PATTERNS).
    const rawSecret = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789';
    scheduler.register({
      taskId: 'leaky',
      // Secret straddles the 60-char boundary: truncating first would leave a
      // raw prefix of the key in the head.
      command: `deploy --target production-cluster --token ${rawSecret} --verbose`,
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'shell',
    });

    const { pending } = await startTick('leaky');
    nowMs += 4_500;
    const tasks = scheduler.getInFlightTasks();

    expect(tasks).toHaveLength(1);
    const [entry] = tasks;
    expect(entry?.taskId).toBe('leaky');
    expect(entry?.elapsedMs).toBe(4_500);
    expect(entry?.commandHead.length).toBeLessThanOrEqual(60);
    expect(entry?.commandHead).not.toContain(rawSecret);
    // No 8+ char fragment of the secret body may survive either.
    expect(entry?.commandHead).not.toMatch(/sk-proj-[A-Za-z0-9]{8,}/);
    expect(entry?.commandHead).toContain('REDACTED');

    releaseRun();
    await pending;
    expect(scheduler.getInFlightTasks()).toEqual([]);
  });

  it('keeps a secret-free command head verbatim (truncated to 60 chars)', async () => {
    const command = '/forge-friction --auto ' + 'x'.repeat(80);
    scheduler.register({ taskId: 'plain', command, trigger: 'cron', cronExpression: '* * * * *', executor: 'shell' });

    const { pending } = await startTick('plain');
    const [entry] = scheduler.getInFlightTasks();
    expect(entry?.commandHead).toBe(command.slice(0, 60));
    expect(entry?.elapsedMs).toBe(0);

    releaseRun();
    await pending;
  });

  it('redacts a secret in the taskId fallback (registry entry missing mid-flight)', async () => {
    // sk- pattern needs ≥20 chars after "sk-" (prompt-dump.ts INLINE_SECRET_PATTERNS).
    const secretTaskId = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789';
    scheduler.register({
      taskId: secretTaskId,
      command: '/safe-command --no-secrets',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'shell',
    });

    // Start the tick (adds to inFlightTasks), then unregister (removes from registry).
    // getInFlightTasks() must hit the taskId fallback branch — and redact it.
    const { pending } = await startTick(secretTaskId);
    scheduler.unregister(secretTaskId);

    const tasks = scheduler.getInFlightTasks();
    expect(tasks).toHaveLength(1);
    const [entry] = tasks;
    // The taskId field is the raw id (not redacted — it is the identifier, not a crash notice body).
    expect(entry?.taskId).toBe(secretTaskId);
    // displayId MUST be redacted — it is what crash notices send to Telegram.
    expect(entry?.displayId).not.toContain(secretTaskId);
    expect(entry?.displayId).toContain('REDACTED');
    // The commandHead fallback MUST be redacted and within the 60-char cap.
    expect(entry?.commandHead.length).toBeLessThanOrEqual(60);
    expect(entry?.commandHead).not.toContain(secretTaskId);
    expect(entry?.commandHead).not.toMatch(/sk-proj-[A-Za-z0-9]{8,}/);
    expect(entry?.commandHead).toContain('REDACTED');

    releaseRun();
    await pending;
  });
});
