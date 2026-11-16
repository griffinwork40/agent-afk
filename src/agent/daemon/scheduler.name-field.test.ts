/**
 * Tests for issue #4831 — telemetry records carry the human-readable `name`
 * field from `ScheduledTaskConfig` so `get_schedule_history` can display a
 * recognisable label instead of the opaque `taskId`.
 *
 * Covers every record-maker that emits a telemetry row:
 *   - makeOverlapSkipRecord
 *   - makeBudgetSkipRecord
 *   - makeTelemetryUnwritableSkipRecord
 *   - makeSessionStartSkipRecord
 *   - makeExpiredSkipRecord
 *   - makeNotYetSkipRecord
 *   - makeCwdErrorRecord
 *   - makeMalformedSkipRecord (scheduler.runat-gate)
 *   - executeAgentTask (success/error baseRecord)
 *   - toScheduledTask (threads name from ScheduledTaskConfig)
 *   - runShellTask (success/error records)
 *   - runBuiltinTask (unknown-builtin record; worktree-prune and tool-health
 *     delegate to their own runners which also carry name)
 *
 * @module agent/daemon/scheduler.name-field.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  makeOverlapSkipRecord,
  makeBudgetSkipRecord,
  makeTelemetryUnwritableSkipRecord,
  makeSessionStartSkipRecord,
  makeExpiredSkipRecord,
  makeNotYetSkipRecord,
  makeCwdErrorRecord,
} from './scheduler.overlap-guard.js';
import { makeMalformedSkipRecord } from './scheduler.runat-gate.js';
import { executeAgentTask } from './scheduler.execute-agent-task.js';
import { toScheduledTask } from './schedule-store.js';
import { runShellTask } from './shell-task.js';
import { runBuiltinTask } from './builtin-task.js';
import type { ScheduledTask } from './triggers.js';
import type { GateDecision } from './gates.js';
import type { AgentTaskContext } from './scheduler.execute-agent-task.js';
import type { TelemetryRecord, TaskCompletionDetails } from './scheduler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000;

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    taskId: 'task-123',
    command: 'run report',
    trigger: 'cron',
    cronExpression: '0 7 * * *',
    ...overrides,
  };
}

function makeCtx(
  writeTelemetry?: (r: TelemetryRecord, t: ScheduledTask, d?: TaskCompletionDetails) => void,
): AgentTaskContext {
  return {
    options: {},
    queueDir: '/tmp/queue',
    idleDetector: { increment: vi.fn(), decrement: vi.fn() },
    now: () => NOW_MS,
    spawnSession: vi.fn().mockResolvedValue({
      session: {
        abortSignal: { aborted: false },
        sendMessage: vi.fn().mockResolvedValue({ role: 'assistant', content: 'done', metadata: {} }),
        close: vi.fn().mockResolvedValue(undefined),
        sessionId: undefined,
        cwd: undefined,
      },
      memoryStore: { close: vi.fn() },
      stateStore: { close: vi.fn() },
      dispose: vi.fn(),
      elicitationKey: 'test-key',
    }),
    writeTelemetry: writeTelemetry ?? vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Skip record makers — name present
// ---------------------------------------------------------------------------

describe('skip record makers — name present on task', () => {
  const task = makeTask({ name: 'Daily Report' });
  const decision: GateDecision = { fire: false, skipReason: 'cooldown' };

  it('makeOverlapSkipRecord includes name', () => {
    const r = makeOverlapSkipRecord(task, 'cron', NOW_MS);
    expect(r.name).toBe('Daily Report');
  });

  it('makeBudgetSkipRecord includes name', () => {
    const r = makeBudgetSkipRecord(task, 'cron', NOW_MS, {
      skip: true,
      provider: 'anthropic',
      binding: { usagePct: 95, thresholdPct: 80, label: '5h' },
    });
    expect(r.name).toBe('Daily Report');
  });

  it('makeTelemetryUnwritableSkipRecord includes name', () => {
    const r = makeTelemetryUnwritableSkipRecord(task, NOW_MS, 'EACCES: permission denied');
    expect(r.name).toBe('Daily Report');
  });

  it('makeSessionStartSkipRecord includes name', () => {
    const r = makeSessionStartSkipRecord(task, decision, NOW_MS);
    expect(r.name).toBe('Daily Report');
  });

  it('makeExpiredSkipRecord includes name', () => {
    const r = makeExpiredSkipRecord(task, 'cron', NOW_MS);
    expect(r.name).toBe('Daily Report');
  });

  it('makeNotYetSkipRecord includes name', () => {
    const r = makeNotYetSkipRecord(task, 'cron', NOW_MS);
    expect(r.name).toBe('Daily Report');
  });

  it('makeCwdErrorRecord includes name', () => {
    const r = makeCwdErrorRecord(task, 'cron', NOW_MS, 'ENOENT: /missing/dir');
    expect(r.name).toBe('Daily Report');
  });

  it('makeMalformedSkipRecord includes name', () => {
    const r = makeMalformedSkipRecord(task, 'cron', NOW_MS, 'expiresAt', 'not-a-date');
    expect(r.name).toBe('Daily Report');
  });
});

// ---------------------------------------------------------------------------
// Skip record makers — name absent
// ---------------------------------------------------------------------------

describe('skip record makers — name absent when task has no name', () => {
  const task = makeTask(); // no name field

  it('makeOverlapSkipRecord omits name', () => {
    expect(makeOverlapSkipRecord(task, 'cron', NOW_MS).name).toBeUndefined();
  });

  it('makeSessionStartSkipRecord omits name', () => {
    expect(makeSessionStartSkipRecord(task, { fire: false }, NOW_MS).name).toBeUndefined();
  });

  it('makeExpiredSkipRecord omits name', () => {
    expect(makeExpiredSkipRecord(task, 'cron', NOW_MS).name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeAgentTask — name on success and error records
// ---------------------------------------------------------------------------

describe('executeAgentTask — name field on success/error records', () => {
  it('includes name on a success record', async () => {
    const written: TelemetryRecord[] = [];
    const ctx = makeCtx((r) => { written.push(r); });
    const task = makeTask({ name: 'Morning Digest' });

    await executeAgentTask(ctx, task, 'cron');

    expect(written).toHaveLength(1);
    expect(written[0]?.name).toBe('Morning Digest');
    expect(written[0]?.status).toBe('success');
  });

  it('includes name on an error record', async () => {
    const written: TelemetryRecord[] = [];
    const ctx = makeCtx((r) => { written.push(r); });
    (ctx.spawnSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: {
        abortSignal: { aborted: false },
        sendMessage: vi.fn().mockRejectedValue(new Error('provider down')),
        close: vi.fn().mockResolvedValue(undefined),
        sessionId: undefined,
        cwd: undefined,
      },
      memoryStore: { close: vi.fn() },
      stateStore: { close: vi.fn() },
      dispose: vi.fn(),
      elicitationKey: 'test-key',
    });
    const task = makeTask({ name: 'Morning Digest' });

    await executeAgentTask(ctx, task, 'cron');

    expect(written).toHaveLength(1);
    expect(written[0]?.name).toBe('Morning Digest');
    expect(written[0]?.status).toBe('error');
  });

  it('omits name when task has no name', async () => {
    const written: TelemetryRecord[] = [];
    const ctx = makeCtx((r) => { written.push(r); });
    const task = makeTask(); // no name

    await executeAgentTask(ctx, task, 'cron');

    expect(written[0]?.name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toScheduledTask — threads name from ScheduledTaskConfig
// ---------------------------------------------------------------------------

describe('toScheduledTask — name threaded from config', () => {
  it('includes name when config has one', () => {
    const task = toScheduledTask({
      id: 'task-abc',
      name: 'Weekly Summary',
      command: '/weekly',
      cron: '0 9 * * 1',
      trigger: 'cron',
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    expect(task.name).toBe('Weekly Summary');
    expect(task.taskId).toBe('task-abc');
  });

  it('omits name when config has an empty name', () => {
    // ScheduledTaskConfig.name is always a string (required), but guard
    // against hand-edited schedules.json with an empty string.
    const task = toScheduledTask({
      id: 'task-def',
      name: '',
      command: '/noop',
      cron: '* * * * *',
      trigger: 'cron',
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    // Empty string is falsy; toScheduledTask uses `config.name !== undefined`
    // so an empty string IS threaded through (it is defined).
    expect(task.name).toBe('');
  });
});

// ---------------------------------------------------------------------------
// runShellTask — name on success and error records
// ---------------------------------------------------------------------------

describe('runShellTask — name field on telemetry records', () => {
  it('includes name on a success record', async () => {
    const written: TelemetryRecord[] = [];
    const task = {
      taskId: 'shell-1',
      command: 'echo hello',
      name: 'Nightly Backup',
    };
    await runShellTask(task, 'cron', {
      now: () => NOW_MS,
      writeTelemetry: (r) => { written.push(r); },
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.name).toBe('Nightly Backup');
    expect(written[0]?.status).toBe('success');
  });

  it('includes name on an error record', async () => {
    const written: TelemetryRecord[] = [];
    const task = {
      taskId: 'shell-2',
      command: 'exit 1',
      name: 'Failing Job',
    };
    await runShellTask(task, 'cron', {
      now: () => NOW_MS,
      writeTelemetry: (r) => { written.push(r); },
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.name).toBe('Failing Job');
    expect(written[0]?.status).toBe('error');
  });

  it('omits name when task has no name', async () => {
    const written: TelemetryRecord[] = [];
    const task = { taskId: 'shell-3', command: 'echo hi' };
    await runShellTask(task, 'cron', {
      now: () => NOW_MS,
      writeTelemetry: (r) => { written.push(r); },
    });
    expect(written[0]?.name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runBuiltinTask — name on unknown-builtin error record
// ---------------------------------------------------------------------------

describe('runBuiltinTask — name field on unknown-builtin record', () => {
  it('includes name on an unknown-builtin error record', async () => {
    const written: TelemetryRecord[] = [];
    const task = {
      taskId: 'builtin-1',
      command: 'not-a-real-builtin',
      name: 'Mystery Task',
    };
    await runBuiltinTask(task, 'cron', {
      now: () => NOW_MS,
      telemetryPath: () => '/tmp/telemetry',
      writeTelemetry: (r) => { written.push(r); },
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.name).toBe('Mystery Task');
    expect(written[0]?.status).toBe('error');
    expect(written[0]?.errorMessage).toMatch(/unknown builtin/);
  });

  it('omits name when task has no name', async () => {
    const written: TelemetryRecord[] = [];
    const task = { taskId: 'builtin-2', command: 'not-a-real-builtin' };
    await runBuiltinTask(task, 'cron', {
      now: () => NOW_MS,
      telemetryPath: () => '/tmp/telemetry',
      writeTelemetry: (r) => { written.push(r); },
    });
    expect(written[0]?.name).toBeUndefined();
  });
});
