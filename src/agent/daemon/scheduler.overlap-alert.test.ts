/**
 * Integration tests for the overlap-alert latch wired into CronScheduler.
 *
 * Verifies:
 *   - 3 overlapping ticks of the same task produce exactly 1 onTaskComplete
 *     notification (the first) and 2 silent skips.
 *   - After the in-flight run completes, the next overlap again produces 1
 *     notification (new episode).
 *   - The alert's notifyOn override is 'always' for the first skip and
 *     'never' for subsequent ones, regardless of the task's own notifyOn.
 *
 * Uses the scheduler's in-memory seam (`sessionFactory`) so no real
 * AgentSession is spawned. All mocks follow the pattern established in
 * budget-gate.scheduler.test.ts.
 *
 * @module agent/daemon/scheduler.overlap-alert.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TelemetryRecord, TaskCompletionDetails } from './scheduler.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('node-cron', () => ({
  schedule: vi.fn(() => ({
    start: () => {},
    stop: () => {},
    destroy: () => {},
    getStatus: () => 'stopped',
  })),
}));

vi.mock('../providers/index.js', () => ({
  resolveProvider: () => { throw new Error('not used in overlap-alert tests'); },
  providerForModel: () => 'anthropic-direct',
}));

vi.mock('../default-hook-registry.js', () => ({
  createDefaultHookRegistry: () => ({
    registry: undefined,
    memoryStore: { close: () => {} },
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CronScheduler } from './scheduler.js';
import type { AgentSession } from '../session/agent-session.js';
import type { AgentConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'afk-overlap-alert-'));
}

type Notification = { record: TelemetryRecord; details: TaskCompletionDetails | undefined };

/**
 * Build a session factory that resolves after `delayMs` ms.
 * Used to hold a "slot" open so subsequent ticks trigger the overlap guard.
 */
function makeSlowSession(delayMs: number): AgentSession {
  return {
    sendMessage: () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ role: 'assistant', content: 'done', timestamp: new Date() }),
          delayMs,
        ),
      ),
    close: () => Promise.resolve(),
  } as unknown as AgentSession;
}

function makeInstantSession(reply = 'ok'): AgentSession {
  return {
    sendMessage: () =>
      Promise.resolve({ role: 'assistant', content: reply, timestamp: new Date() }),
    close: () => Promise.resolve(),
  } as unknown as AgentSession;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CronScheduler overlap alert latch', () => {
  let dir: string;
  let telemetryPath: string;
  let savedAfkHome: string | undefined;
  let savedAllowProjectMcp: string | undefined;

  beforeEach(() => {
    dir = makeTmpDir();
    telemetryPath = join(dir, 'forge-telemetry.jsonl');
    savedAfkHome = process.env['AFK_HOME'];
    savedAllowProjectMcp = process.env['AFK_ALLOW_PROJECT_MCP'];
    process.env['AFK_HOME'] = dir;
    process.env['AFK_ALLOW_PROJECT_MCP'] = '0';
  });

  afterEach(() => {
    if (savedAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = savedAfkHome;
    if (savedAllowProjectMcp === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
    else process.env['AFK_ALLOW_PROJECT_MCP'] = savedAllowProjectMcp;
    rmSync(dir, { recursive: true, force: true });
  });

  it('3 overlapping ticks produce exactly 1 onTaskComplete notification', async () => {
    const notifications: Notification[] = [];
    let sessionCount = 0;

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: ((_config: AgentConfig) => {
        sessionCount += 1;
        // First session: slow (holds the slot open while ticks 2+3 fire)
        if (sessionCount === 1) return makeSlowSession(50);
        return makeInstantSession();
      }) as NonNullable<ConstructorParameters<typeof CronScheduler>[0]>['sessionFactory'],
      onTaskComplete: (record, details) => {
        notifications.push({ record, details });
      },
    });

    scheduler.register({
      taskId: 'slow-task',
      command: 'run-slow-report',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'agent',
      notifyOn: 'always',
    });

    // Start tick 1 (will take 50 ms — holds the overlap guard)
    const tick1Promise = scheduler.tick('slow-task');

    // Ticks 2 and 3 fire immediately while tick 1 is still in flight
    const tick2 = await scheduler.tick('slow-task');
    const tick3 = await scheduler.tick('slow-task');

    // Wait for tick 1 to finish
    const tick1 = await tick1Promise;
    await scheduler.stop();

    // Tick 1 succeeded
    expect(tick1.status).toBe('success');
    // Ticks 2 and 3 were skipped as overlaps
    expect(tick2.status).toBe('skipped');
    expect(tick2.skipReason).toBe('overlap');
    expect(tick3.status).toBe('skipped');
    expect(tick3.skipReason).toBe('overlap');

    // Exactly 3 notifications: tick1 success + tick2 (first overlap, 'always')
    // + tick3 suppressed (latch returns false → 'never')
    // Note: tick1 notification fires from writeTelemetry with notifyOn:'always'.
    // tick2 fires because latch.shouldAlert returns true (first overlap) → overridden to 'always'.
    // tick3 fires with notifyOn overridden to 'never' → suppressed by fireOnTaskComplete.
    const overlapNotifs = notifications.filter(
      (n) => n.record.skipReason === 'overlap',
    );
    expect(overlapNotifs).toHaveLength(1);
  });

  it('first overlap of an episode includes the alert text in responseText', async () => {
    const notifications: Notification[] = [];
    let sessionCount = 0;

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: ((_config: AgentConfig) => {
        sessionCount += 1;
        if (sessionCount === 1) return makeSlowSession(50);
        return makeInstantSession();
      }) as NonNullable<ConstructorParameters<typeof CronScheduler>[0]>['sessionFactory'],
      onTaskComplete: (record, details) => {
        notifications.push({ record, details });
      },
    });

    scheduler.register({
      taskId: 'overlap-text-task',
      command: 'my-command',
      trigger: 'cron',
      cronExpression: '*/5 * * * *',
      executor: 'agent',
      notifyOn: 'always',
    });

    const tick1Promise = scheduler.tick('overlap-text-task');
    const _tick2 = await scheduler.tick('overlap-text-task');
    await tick1Promise;
    await scheduler.stop();

    const overlapNotif = notifications.find(
      (n) => n.record.skipReason === 'overlap',
    );
    expect(overlapNotif).toBeDefined();
    // The responseText passed to the callback includes the formatted overlap alert
    expect(overlapNotif?.details?.responseText).toContain('overlap-text-task');
    expect(overlapNotif?.details?.responseText).toContain('my-command');
  });

  it('after task completes, next overlap opens a new episode and alerts again', async () => {
    const notifications: Notification[] = [];
    let sessionCount = 0;

    const scheduler = new CronScheduler({
      telemetryPath,
      sessionFactory: ((_config: AgentConfig) => {
        sessionCount += 1;
        // Sessions 1 and 3 are slow; 2 is instant (clears the latch)
        if (sessionCount === 1 || sessionCount === 3) return makeSlowSession(50);
        return makeInstantSession();
      }) as NonNullable<ConstructorParameters<typeof CronScheduler>[0]>['sessionFactory'],
      onTaskComplete: (record, details) => {
        notifications.push({ record, details });
      },
    });

    scheduler.register({
      taskId: 'episode-reset-task',
      command: 'work',
      trigger: 'cron',
      cronExpression: '* * * * *',
      executor: 'agent',
      notifyOn: 'always',
    });

    // Episode 1: tick 1 slow, tick 2 fires while in-flight → 1 alert
    const ep1tick1 = scheduler.tick('episode-reset-task');
    const ep1tick2 = await scheduler.tick('episode-reset-task');
    await ep1tick1;

    // Episode cleared: tick 3 runs normally, then slow (session 3)
    const ep2tick1 = scheduler.tick('episode-reset-task');
    const ep2tick2 = await scheduler.tick('episode-reset-task');
    await ep2tick1;

    await scheduler.stop();

    expect(ep1tick2.skipReason).toBe('overlap');
    expect(ep2tick2.skipReason).toBe('overlap');

    const overlapNotifs = notifications.filter(
      (n) => n.record.skipReason === 'overlap',
    );
    // One alert per episode = 2 total
    expect(overlapNotifs).toHaveLength(2);
  });
});
