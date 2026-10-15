/**
 * Tests for #3466/#3756: unrecovered AFK gate blocks remain failures;
 * conservatively declared recoveries retain gate evidence as success.
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
import { formatTaskCompletion } from '../../cli/commands/daemon.js';
import type { ResponseMetadata } from '../types/message-types.js';
import type { GateBlockCall } from './scheduler-gate-recovery.js';
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

function makeSession(response = 'all done', metadata = {}, aborted = false) {
  return {
    abortSignal: { aborted },
    sendMessage: vi.fn().mockResolvedValue({ role: 'assistant', content: response, metadata }),
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
    calls?: GateBlockCall[];
    response?: string;
    metadata?: ResponseMetadata;
    aborted?: boolean;
    error?: Error;
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
        gateBlockCounter.calls = opts.calls;
      }
      const session = makeSession(response, opts.metadata, opts.aborted);
      if (opts.error) session.sendMessage.mockRejectedValue(opts.error);
      return {
        session: session as never,
        memoryStore: makeMemoryStore() as never,
        stateStore: makeStateStore() as never,
        dispose: vi.fn(),
        elicitationKey: 'gate-test',
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

  it.each(['end_turn', 'stop'])('records recovered success on normal %s and suppresses failure notifications', async (stopReason) => {
    const cb = vi.fn();
    const { ctx, telemetryRecords } = makeCtx({
      hardBlocks: 1, response: '**Done**\n50 forecasts ingested', metadata: { stopReason },
      calls: [{ blockedTool: 'bash', followingTools: ['web_request'] }],
    });
    const task = makeTask();
    const record = await executeAgentTask(ctx, task, 'cron');
    fireOnTaskComplete(record, { onTaskComplete: cb }, task);
    expect(record.status).toBe('success');
    expect(record.gateBlocks).toBe(1);
    expect(record.gateBlockCalls).toEqual([{ blockedTool: 'bash', followingTools: ['web_request'] }]);
    expect(record.gateRecoveryNote).toContain('Recovered after 1 AFK gate block(s)');
    expect(telemetryRecords[0]).toEqual(record);
    expect(cb).not.toHaveBeenCalled();
    fireOnTaskComplete(record, { onTaskComplete: cb }, makeTask({ notifyOn: 'always' }));
    expect(cb).toHaveBeenCalledOnce();
    expect(formatTaskCompletion(record)).toContain(record.gateRecoveryNote);
  });

  it.each([
    { response: '**Blocked**\nNeed approval', metadata: { stopReason: 'end_turn' } },
    { response: '**Done**\nInitially completed\n**Blocked**\nNeed approval', metadata: { stopReason: 'end_turn' } },
    { response: '```\nDone\n```', metadata: { stopReason: 'end_turn' } },
    { response: '**Asking**\nNeed input', metadata: { stopReason: 'end_turn' } },
    { response: '**Interrupted**', metadata: { stopReason: 'end_turn' } },
    { response: '50 forecasts ingested', metadata: { stopReason: 'end_turn' } },
    { response: '', metadata: { stopReason: 'end_turn' } },
    { response: '**Done**', metadata: {} },
    { response: '**Done**', metadata: { stopReason: 'max_tokens' } },
    { response: '**Done**', metadata: { stopReason: 'tool_use_loop_capped' } },
    { response: '**Done**', metadata: { stopReason: 'interrupted' } },
    { response: '**Done**', metadata: { stopReason: 'end_turn', isError: true } },
    { response: '**Done**', metadata: { stopReason: 'end_turn', resultSubtype: 'error_during_execution' } },
    { response: '**Done**', metadata: { stopReason: 'end_turn', errors: ['failed'] } },
    { response: '**Done**', metadata: { stopReason: 'end_turn' }, aborted: true },
  ])('keeps ambiguous/incomplete recovery blocked: %j', async (signals) => {
    const cb = vi.fn();
    const { ctx } = makeCtx({ hardBlocks: 1, ...signals });
    const task = makeTask();
    const record = await executeAgentTask(ctx, task, 'cron');
    fireOnTaskComplete(record, { onTaskComplete: cb }, task);
    expect(record.status).toBe('blocked');
    expect(record.gateRecoveryNote).toBeUndefined();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('preserves thrown errors rather than claiming recovery', async () => {
    const { ctx } = makeCtx({ hardBlocks: 1, error: new Error('turn aborted') });
    const record = await executeAgentTask(ctx, makeTask(), 'cron');
    expect(record.status).toBe('error');
    expect(record.gateBlocks).toBe(1);
    expect(record.gateRecoveryNote).toBeUndefined();
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


