/**
 * Tests for issue #3466: daemon runs whose tool calls the AFK gate hard-blocked
 * are recorded as status:'blocked' and trigger notifyOn:'failure'.
 *
 * Strategy: exercise `executeAgentTask` directly with a mock `spawnSession`
 * that simulates the gate-block counting shim by incrementing the supplied
 * `gateBlockCounter` before resolving (mirroring what the real
 * `makeGateBlockTraceWriter` shim does in `session-spawn.ts`).
 *
 * Separately, tests for `fireOnTaskComplete` cover the notification filter.
 *
 * @module agent/daemon/scheduler-gate-blocks.test
 */

import { describe, it, expect, vi } from 'vitest';
import { executeAgentTask } from './scheduler.execute-agent-task.js';
import { fireOnTaskComplete } from './scheduler.pull-tick.js';
import type { AgentTaskContext } from './scheduler.execute-agent-task.js';
import type { TelemetryRecord, TaskCompletionDetails } from './scheduler.js';
import type { ScheduledTask } from './triggers.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeIdleDetector() {
  return { increment: vi.fn(), decrement: vi.fn() };
}

function makeMemoryStore() {
  return { close: vi.fn() };
}

function makeStateStore() {
  return { close: vi.fn() };
}

function makeSession(response = 'all done') {
  return {
    sendMessage: vi.fn().mockResolvedValue({ content: response }),
    close: vi.fn().mockResolvedValue(undefined),
    sessionId: undefined,
    cwd: undefined,
  };
}

/**
 * Build a minimal `AgentTaskContext` whose `spawnSession` simulates N gate
 * hard-blocks by incrementing `gateBlockCounter.count` N times before
 * resolving the session.
 */
function makeCtx(
  opts: {
    hardBlocks?: number;
    response?: string;
    writeTelemetry?: (r: TelemetryRecord, t: ScheduledTask, d?: TaskCompletionDetails) => void;
  } = {},
): { ctx: AgentTaskContext; telemetryRecords: TelemetryRecord[] } {
  const { hardBlocks = 0, response = 'task done', writeTelemetry } = opts;
  const telemetryRecords: TelemetryRecord[] = [];

  const ctx: AgentTaskContext = {
    options: {},
    queueDir: '/tmp/queue',
    idleDetector: makeIdleDetector(),
    now: () => Date.now(),
    spawnSession: vi.fn(async (_task, _trigger, gateBlockCounter) => {
      // Simulate the counting shim incrementing for each hard-block.
      if (gateBlockCounter !== undefined) {
        gateBlockCounter.count += hardBlocks;
      }
      const session = makeSession(response);
      return {
        session: session as never,
        memoryStore: makeMemoryStore() as never,
        stateStore: makeStateStore() as never,
        dispose: vi.fn(),
      };
    }),
    writeTelemetry: writeTelemetry ?? ((r) => { telemetryRecords.push(r); }),
  };

  return { ctx, telemetryRecords };
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    taskId: 'test-task',
    command: 'run report',
    trigger: 'cron',
    cronExpression: '* * * * *',
    executor: 'agent',
    enabled: true,
    notifyOn: 'failure',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// executeAgentTask — status classification
// ---------------------------------------------------------------------------

describe('executeAgentTask — gate-block status (#3466)', () => {
  it('records status:success when no gate blocks occurred', async () => {
    const { ctx, telemetryRecords } = makeCtx({ hardBlocks: 0 });
    const task = makeTask();
    const record = await executeAgentTask(ctx, task, 'cron');

    expect(record.status).toBe('success');
    expect(record.gateBlocks).toBeUndefined();
    expect(telemetryRecords[0]?.status).toBe('success');
    expect(telemetryRecords[0]?.gateBlocks).toBeUndefined();
  });

  it('records status:blocked and gateBlocks:1 when one hard-block occurred', async () => {
    const { ctx, telemetryRecords } = makeCtx({ hardBlocks: 1 });
    const task = makeTask();
    const record = await executeAgentTask(ctx, task, 'cron');

    expect(record.status).toBe('blocked');
    expect(record.gateBlocks).toBe(1);
    expect(telemetryRecords[0]?.status).toBe('blocked');
    expect(telemetryRecords[0]?.gateBlocks).toBe(1);
  });

  it('records gateBlocks equal to the total number of hard-blocks', async () => {
    const { ctx, telemetryRecords } = makeCtx({ hardBlocks: 3 });
    const task = makeTask();
    const record = await executeAgentTask(ctx, task, 'cron');

    expect(record.status).toBe('blocked');
    expect(record.gateBlocks).toBe(3);
    expect(telemetryRecords[0]?.gateBlocks).toBe(3);
  });

  it('preserves responseExcerpt on a blocked run (model explains the refusal)', async () => {
    const explanation = 'AFK gate refused write_file — path escapes workspace';
    const { ctx } = makeCtx({ hardBlocks: 1, response: explanation });
    const task = makeTask();
    const record = await executeAgentTask(ctx, task, 'cron');

    expect(record.status).toBe('blocked');
    expect(record.responseExcerpt).toBe(explanation);
  });

  it('passes gateBlockCounter into spawnSession', async () => {
    const { ctx } = makeCtx({ hardBlocks: 0 });
    const task = makeTask();
    await executeAgentTask(ctx, task, 'cron');

    // The third argument to spawnSession must be the counter object.
    const spawnCalls = (ctx.spawnSession as ReturnType<typeof vi.fn>).mock.calls;
    expect(spawnCalls.length).toBeGreaterThan(0);
    const counter = spawnCalls[0]?.[2];
    expect(counter).toBeDefined();
    expect(typeof counter?.count).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// fireOnTaskComplete — notifyOn:'failure' fires on status:'blocked'
// ---------------------------------------------------------------------------

describe('fireOnTaskComplete — notifyOn:failure + status:blocked (#3466)', () => {
  it('invokes the callback when status is blocked and notifyOn is failure', () => {
    const cb = vi.fn();
    const record: TelemetryRecord = {
      taskId: 'task-a',
      command: 'run',
      trigger: 'cron',
      triggeredAt: new Date().toISOString(),
      durationMs: 100,
      status: 'blocked',
      gateBlocks: 2,
    };
    const task = makeTask({ notifyOn: 'failure' });

    fireOnTaskComplete(record, { onTaskComplete: cb }, task);

    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(record, undefined);
  });

  it('suppresses callback when status is success and notifyOn is failure', () => {
    const cb = vi.fn();
    const record: TelemetryRecord = {
      taskId: 'task-b',
      command: 'run',
      trigger: 'cron',
      triggeredAt: new Date().toISOString(),
      durationMs: 50,
      status: 'success',
    };
    const task = makeTask({ notifyOn: 'failure' });

    fireOnTaskComplete(record, { onTaskComplete: cb }, task);

    expect(cb).not.toHaveBeenCalled();
  });

  it('invokes the callback on status:blocked when notifyOn is always', () => {
    const cb = vi.fn();
    const record: TelemetryRecord = {
      taskId: 'task-c',
      command: 'run',
      trigger: 'cron',
      triggeredAt: new Date().toISOString(),
      durationMs: 80,
      status: 'blocked',
      gateBlocks: 1,
    };
    const task = makeTask({ notifyOn: 'always' });

    fireOnTaskComplete(record, { onTaskComplete: cb }, task);

    expect(cb).toHaveBeenCalledOnce();
  });

  it('suppresses callback on status:blocked when notifyOn is never', () => {
    const cb = vi.fn();
    const record: TelemetryRecord = {
      taskId: 'task-d',
      command: 'run',
      trigger: 'cron',
      triggeredAt: new Date().toISOString(),
      durationMs: 60,
      status: 'blocked',
      gateBlocks: 1,
    };
    const task = makeTask({ notifyOn: 'never' });

    fireOnTaskComplete(record, { onTaskComplete: cb }, task);

    expect(cb).not.toHaveBeenCalled();
  });
});


