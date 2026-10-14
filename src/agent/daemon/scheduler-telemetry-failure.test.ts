/**
 * Regression test for issue #2305: a telemetry append failure must never
 * suppress the task-completion push (onTaskComplete callback).
 *
 * Lives in its own file because vi.mock('node:fs', ...) is hoisted to module
 * scope and would contaminate scheduler.test.ts if placed there.
 *
 * @module agent/daemon/scheduler-telemetry-failure.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock strategy: make appendFileSync throw on demand while delegating every
// other fs call to the real implementation so CronScheduler's mkdirSync and
// test setup/teardown work normally.
// ---------------------------------------------------------------------------

let appendShouldThrow = false;

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    appendFileSync: (...args: Parameters<typeof original.appendFileSync>): void => {
      if (appendShouldThrow) {
        const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      }
      original.appendFileSync(...args);
    },
  };
});

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({
    registry: undefined,
    memoryStore: { close: () => {} },
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

// Import AFTER vi.mock is registered.
import { CronScheduler } from './scheduler.js';
import { AgentSession } from '../session/agent-session.js';

function makeSession(response = 'done'): AgentSession {
  return {
    sendMessage: () => Promise.resolve({ content: response }),
    close: () => Promise.resolve(),
  } as unknown as AgentSession;
}

let tmpDir: string;
let telemetryPath: string;

beforeEach(() => {
  appendShouldThrow = false;
  tmpDir = realFs.mkdtempSync(join(tmpdir(), 'afk-sched-telemetry-fail-'));
  telemetryPath = join(tmpDir, 'forge-telemetry.jsonl');
});

afterEach(() => {
  // Assert the flag was reset by the test itself (via finally) — a live `true`
  // here means a prior test leaked the flag without resetting it.
  expect(appendShouldThrow, 'appendShouldThrow was not reset — flag leaked from a test').toBe(false);
  // Defensive reset so subsequent tests are not poisoned even on assertion failure.
  appendShouldThrow = false;
  realFs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CronScheduler — telemetry append failure (issue #2305)', () => {
  it('still calls onTaskComplete when appendFileSync throws', async () => {
    // Arm: every telemetry append will throw ENOSPC.
    appendShouldThrow = true;

    const onTaskComplete = vi.fn();
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession('task completed'),
      onTaskComplete,
    });

    scheduler.register({
      taskId: 'telemetry-fail-test',
      command: 'run-report',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    // Suppress the expected console.error from the append failure.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await scheduler.tick('telemetry-fail-test');
    } finally {
      errSpy.mockRestore();
      // Reset the flag so the afterEach assertion does not report a leak.
      appendShouldThrow = false;
    }

    // The push callback must have fired despite the failed write.
    expect(onTaskComplete).toHaveBeenCalledOnce();

    await scheduler.stop();
  });

  it('logs the append error to stderr before firing the push', async () => {
    appendShouldThrow = true;

    const onTaskComplete = vi.fn();
    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: () => makeSession('done'),
      onTaskComplete,
    });

    scheduler.register({
      taskId: 'telemetry-fail-log-test',
      command: 'health-check',
      trigger: 'cron',
      cronExpression: '* * * * *',
    });

    const loggedErrors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      loggedErrors.push(args.map(String).join(' '));
    });
    try {
      await scheduler.tick('telemetry-fail-log-test');
    } finally {
      errSpy.mockRestore();
      // Reset the flag so the afterEach assertion does not report a leak.
      appendShouldThrow = false;
    }

    // A "[daemon] telemetry write failed" line must appear in stderr.
    const telemetryLog = loggedErrors.find((l) => l.includes('telemetry write failed'));
    expect(telemetryLog).toBeDefined();

    // And the push still fires.
    expect(onTaskComplete).toHaveBeenCalledOnce();

    await scheduler.stop();
  });
});
