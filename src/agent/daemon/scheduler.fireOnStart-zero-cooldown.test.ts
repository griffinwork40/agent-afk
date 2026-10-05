/**
 * Regression test: CronScheduler.fireOnStart must NOT skip agent tasks whose
 * `debounceMs` is explicitly 0 even when `probeTelemetryWritable` reports an
 * error.
 *
 * Background: scheduler.ts line 291 gates the telemetry-unwritable skip on
 * `cooldownMs > 0`. A task with `debounceMs: 0` has no cooldown to protect, so
 * the skip is unnecessary and would permanently block zero-cooldown tasks whenever
 * the telemetry file becomes temporarily unwritable.
 *
 * This file is intentionally separate from telemetry-write-guard.test.ts so the
 * `vi.mock('./telemetry-write-guard.js')` factory here does not interfere with
 * the direct-import unit tests for `probeTelemetryWritable` in that file.
 *
 * @module agent/daemon/scheduler.fireOnStart-zero-cooldown.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Stub probeTelemetryWritable to always return an error so the test never
// depends on filesystem permissions (portable across root CI and Windows).
vi.mock('./telemetry-write-guard.js', () => ({
  probeTelemetryWritable: vi.fn(() => 'EACCES: permission denied, access \'/fake/path\''),
  TelemetryAlertLatch: class {
    async notify() { /* no-op */ }
    _reset() { /* no-op */ }
  },
}));

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

vi.mock('../../telegram/push.js', () => ({
  pushIfConfigured: vi.fn().mockResolvedValue(null),
}));

// Import AFTER vi.mock declarations so mocks are hoisted first.
import { CronScheduler } from './scheduler.js';

describe('CronScheduler.fireOnStart — zero-cooldown agent task bypasses telemetry-unwritable guard', () => {
  let dir: string;
  let telemetryPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-zero-cool-'));
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires (calls sessionFactory) and is NOT skipped with telemetry-unwritable when debounceMs is 0', async () => {
    // Contract: probeTelemetryWritable is stubbed to return an error.
    // A task with debounceMs: 0 must still fire because cooldownMs > 0 is false,
    // so the guard condition at scheduler.ts:291 is skipped.
    const session = {
      sendMessage: vi.fn().mockResolvedValue({ content: 'done' }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const sessionFactory = vi.fn().mockReturnValue(session);

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory,
      budgetGate: async () => ({ skip: false }),
    });

    scheduler.register({
      taskId: 'zero-cooldown-agent',
      command: 'run on start',
      executor: 'agent',
      trigger: 'sessionstart',
      debounceMs: 0,
    });

    const records = await scheduler.fireOnStart();
    await scheduler.stop();

    // The task must NOT be skipped with the telemetry-unwritable reason.
    const guardSkips = records.filter((r) => r.skipReason === 'telemetry-unwritable');
    expect(guardSkips).toHaveLength(0);

    // The session factory must have been called (task fired).
    expect(sessionFactory).toHaveBeenCalledOnce();

    // Exactly one record, and it must not be a guard skip.
    expect(records).toHaveLength(1);
    expect(records[0].taskId).toBe('zero-cooldown-agent');
  });
});
