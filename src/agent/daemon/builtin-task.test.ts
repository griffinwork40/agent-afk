/**
 * Unit tests for builtin-task dispatcher.
 *
 * Covers:
 * 1. Known builtin (`worktree-prune`) delegates to `runBuiltinWorktreePruneTask`.
 * 2. Legacy sentinel (`__BUILTIN_WORKTREE_PRUNE__`) passed directly produces an
 *    unknown-builtin error record — normalization to `worktree-prune` is the
 *    scheduler's responsibility (tested in scheduler tests), not builtin-task's.
 * 3. Unknown builtin name produces a status:error telemetry record.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the worktree-prune-task module so no real git sweep executes.
vi.mock('./worktree-prune-task.js', () => ({
  runBuiltinWorktreePruneTask: vi.fn(),
}));

// Import after mocking so the mock is in place when builtin-task.ts loads.
import { runBuiltinTask } from './builtin-task.js';
import { runBuiltinWorktreePruneTask } from './worktree-prune-task.js';
import type { TelemetryRecord } from './scheduler.js';

const mockRunWorktreePrune = vi.mocked(runBuiltinWorktreePruneTask);

beforeEach(() => {
  mockRunWorktreePrune.mockClear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<{
  now: () => number;
  telemetryPath: () => string;
  writeTelemetry: (r: TelemetryRecord) => void;
}> = {}) {
  const records: TelemetryRecord[] = [];
  return {
    now: () => 1_700_000_000_000,
    telemetryPath: () => '/tmp/fake-telemetry.jsonl',
    writeTelemetry: (r: TelemetryRecord) => records.push(r),
    records,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Known builtin dispatches to runBuiltinWorktreePruneTask
// ---------------------------------------------------------------------------

describe('runBuiltinTask – worktree-prune dispatch', () => {
  it('delegates to runBuiltinWorktreePruneTask for command "worktree-prune"', async () => {
    const fakeRecord: TelemetryRecord = {
      taskId: 'prune-task',
      command: 'worktree-prune',
      trigger: 'cron',
      triggeredAt: new Date(1_700_000_000_000).toISOString(),
      durationMs: 42,
      status: 'success',
      responseExcerpt: 'pruned 2 worktrees',
    };
    mockRunWorktreePrune.mockResolvedValueOnce(fakeRecord);

    const opts = makeOptions();
    const task = { taskId: 'prune-task', command: 'worktree-prune' };
    const result = await runBuiltinTask(task, 'cron', opts);

    // Should delegate — runBuiltinWorktreePruneTask called exactly once
    expect(mockRunWorktreePrune).toHaveBeenCalledTimes(1);
    expect(mockRunWorktreePrune).toHaveBeenCalledWith(
      task,
      'cron',
      expect.objectContaining({
        now: opts.now,
        telemetryPath: opts.telemetryPath,
        writeTelemetry: opts.writeTelemetry,
      }),
    );

    // Return value is whatever runBuiltinWorktreePruneTask returned
    expect(result).toBe(fakeRecord);
  });

  it('passes cronExpression through to the worktree-prune handler', async () => {
    const fakeRecord: TelemetryRecord = {
      taskId: 'prune-cron',
      command: 'worktree-prune',
      trigger: 'cron',
      cronExpression: '0 2 * * *',
      triggeredAt: new Date(1_700_000_000_000).toISOString(),
      durationMs: 10,
      status: 'success',
    };
    mockRunWorktreePrune.mockResolvedValueOnce(fakeRecord);

    const opts = makeOptions();
    const task = { taskId: 'prune-cron', command: 'worktree-prune', cronExpression: '0 2 * * *' };
    await runBuiltinTask(task, 'cron', opts);

    expect(mockRunWorktreePrune).toHaveBeenCalledWith(
      expect.objectContaining({ cronExpression: '0 2 * * *' }),
      'cron',
      expect.anything(),
    );
  });

  it('works with sessionstart trigger', async () => {
    const fakeRecord: TelemetryRecord = {
      taskId: 'prune-ss',
      command: 'worktree-prune',
      trigger: 'sessionstart',
      triggeredAt: new Date(1_700_000_000_000).toISOString(),
      durationMs: 5,
      status: 'skipped',
      responseExcerpt: 'no roots',
    };
    mockRunWorktreePrune.mockResolvedValueOnce(fakeRecord);

    const opts = makeOptions();
    const result = await runBuiltinTask(
      { taskId: 'prune-ss', command: 'worktree-prune' },
      'sessionstart',
      opts,
    );

    expect(mockRunWorktreePrune).toHaveBeenCalledWith(
      expect.anything(),
      'sessionstart',
      expect.anything(),
    );
    expect(result.trigger).toBe('sessionstart');
  });

  it('does NOT call writeTelemetry itself — delegates entirely to the handler', async () => {
    mockRunWorktreePrune.mockResolvedValueOnce({
      taskId: 'prune-nw',
      command: 'worktree-prune',
      trigger: 'cron',
      triggeredAt: new Date().toISOString(),
      durationMs: 0,
      status: 'success',
    });

    const writeSpy = vi.fn();
    const opts = makeOptions({ writeTelemetry: writeSpy });
    await runBuiltinTask({ taskId: 'prune-nw', command: 'worktree-prune' }, 'cron', opts);

    // builtin-task itself never calls writeTelemetry for the worktree-prune path
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Legacy sentinel passed directly → unknown builtin error
//    (The scheduler normalises __BUILTIN_WORKTREE_PRUNE__ → worktree-prune
//    before calling runBuiltinTask; if the raw sentinel somehow reaches here it
//    is treated as an unknown builtin.)
// ---------------------------------------------------------------------------

describe('runBuiltinTask – legacy sentinel produces unknown-builtin error', () => {
  it('returns status:error when command is __BUILTIN_WORKTREE_PRUNE__', async () => {
    const records: TelemetryRecord[] = [];
    const opts = makeOptions({ writeTelemetry: (r) => records.push(r) });

    const result = await runBuiltinTask(
      { taskId: 'legacy', command: '__BUILTIN_WORKTREE_PRUNE__' },
      'cron',
      opts,
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('unknown builtin');
    expect(result.errorMessage).toContain('__BUILTIN_WORKTREE_PRUNE__');
    // runBuiltinWorktreePruneTask must NOT have been invoked
    expect(mockRunWorktreePrune).not.toHaveBeenCalled();
  });

  it('calls writeTelemetry for the legacy sentinel error record', async () => {
    const writeSpy = vi.fn();
    const opts = makeOptions({ writeTelemetry: writeSpy });

    await runBuiltinTask(
      { taskId: 'legacy-wt', command: '__BUILTIN_WORKTREE_PRUNE__' },
      'sessionstart',
      opts,
    );

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [record] = writeSpy.mock.calls[0] as [TelemetryRecord];
    expect(record.status).toBe('error');
    expect(record.taskId).toBe('legacy-wt');
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown builtin name produces a status:error telemetry record
// ---------------------------------------------------------------------------

describe('runBuiltinTask – unknown builtin', () => {
  it('returns status:error with errorMessage containing the unknown name', async () => {
    const opts = makeOptions();
    const result = await runBuiltinTask(
      { taskId: 'task-bad', command: 'nonexistent-builtin' },
      'cron',
      opts,
    );

    expect(result.status).toBe('error');
    expect(result.errorMessage).toMatch(/unknown builtin: nonexistent-builtin/);
  });

  it('populates all standard telemetry fields', async () => {
    const fixedNow = 1_700_000_000_000;
    const opts = makeOptions({ now: () => fixedNow });

    const result = await runBuiltinTask(
      { taskId: 'task-fields', command: 'does-not-exist' },
      'cron',
      opts,
    );

    expect(result.taskId).toBe('task-fields');
    expect(result.command).toBe('does-not-exist');
    expect(result.trigger).toBe('cron');
    expect(result.triggeredAt).toBe(new Date(fixedNow).toISOString());
    expect(result.durationMs).toBe(0);
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('unknown builtin');
  });

  it('calls writeTelemetry exactly once with the error record', async () => {
    const writeSpy = vi.fn();
    const opts = makeOptions({ writeTelemetry: writeSpy });

    const result = await runBuiltinTask(
      { taskId: 'task-spy', command: 'mystery-builtin' },
      'sessionstart',
      opts,
    );

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [passedRecord] = writeSpy.mock.calls[0] as [TelemetryRecord];
    expect(passedRecord).toBe(result);
    expect(passedRecord.status).toBe('error');
    expect(passedRecord.errorMessage).toContain('mystery-builtin');
  });

  it('does not call runBuiltinWorktreePruneTask for an unknown command', async () => {
    const opts = makeOptions();
    await runBuiltinTask(
      { taskId: 'task-noproxy', command: 'another-unknown' },
      'cron',
      opts,
    );

    expect(mockRunWorktreePrune).not.toHaveBeenCalled();
  });

  it('omits cronExpression from the error record when not provided', async () => {
    const opts = makeOptions();
    const result = await runBuiltinTask(
      { taskId: 'task-nocron', command: 'bad-builtin' },
      'cron',
      opts,
    );

    expect('cronExpression' in result).toBe(false);
  });

  it('returns consistent error records for different unknown names', async () => {
    const opts = makeOptions();
    const names = ['foo-builtin', 'bar', '42', ''];
    for (const name of names) {
      const result = await runBuiltinTask(
        { taskId: `task-${name}`, command: name },
        'cron',
        opts,
      );
      expect(result.status).toBe('error');
      if (name.length > 0) {
        expect(result.errorMessage).toContain(name);
      } else {
        // Empty string is also unknown
        expect(result.errorMessage).toContain('unknown builtin');
      }
      expect(mockRunWorktreePrune).not.toHaveBeenCalled();
    }
  });
});
