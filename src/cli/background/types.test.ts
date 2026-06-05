import { describe, it, expect } from 'vitest';
import type { BackgroundTask } from '../commands/interactive/background.js';
import type { BackgroundJob } from '../../agent/background-registry.js';
import { type BackgroundItem, itemId, itemStartedAt, itemIsRunning } from './types.js';

// ---------------------------------------------------------------------------
// Minimal fixtures — cast to the real types so tsc validates field names
// ---------------------------------------------------------------------------

const runningTask = {
  id: 'bg-1',
  label: 'test task',
  startedAt: 1_000_000,
  status: 'running',
  stats: { tokens: 0, toolUses: 0, durationMs: 0 },
} as BackgroundTask;

const succeededTask = {
  id: 'bg-2',
  label: 'done task',
  startedAt: 2_000_000,
  status: 'succeeded',
  stats: { tokens: 10, toolUses: 1, durationMs: 500 },
} as BackgroundTask;

const runningJob = {
  jobId: 'bgsub-1',
  subagentId: 'sub-abc',
  label: 'test job',
  model: 'claude-3-5-sonnet-20241022',
  startedAt: 3_000_000,
  status: 'running',
} as BackgroundJob;

const completedJob = {
  jobId: 'bgsub-2',
  subagentId: 'sub-def',
  label: 'done job',
  model: 'claude-3-5-sonnet-20241022',
  startedAt: 4_000_000,
  status: 'completed',
  endedAt: 4_001_000,
} as BackgroundJob;

const failedJob = {
  jobId: 'bgsub-3',
  subagentId: 'sub-ghi',
  label: 'failed job',
  model: 'claude-3-5-sonnet-20241022',
  startedAt: 5_000_000,
  status: 'failed',
  endedAt: 5_002_000,
} as BackgroundJob;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('itemId', () => {
  it('returns task.id for turn-kind', () => {
    const item: BackgroundItem = { kind: 'turn', task: runningTask };
    expect(itemId(item)).toBe('bg-1');
  });

  it('returns job.jobId for subagent-kind', () => {
    const item: BackgroundItem = { kind: 'subagent', job: runningJob };
    expect(itemId(item)).toBe('bgsub-1');
  });
});

describe('itemStartedAt', () => {
  it('returns task.startedAt for turn-kind', () => {
    const item: BackgroundItem = { kind: 'turn', task: runningTask };
    expect(itemStartedAt(item)).toBe(1_000_000);
  });

  it('returns job.startedAt for subagent-kind', () => {
    const item: BackgroundItem = { kind: 'subagent', job: completedJob };
    expect(itemStartedAt(item)).toBe(4_000_000);
  });
});

describe('itemIsRunning', () => {
  it('returns true for a running turn-task', () => {
    const item: BackgroundItem = { kind: 'turn', task: runningTask };
    expect(itemIsRunning(item)).toBe(true);
  });

  it('returns false for a succeeded turn-task', () => {
    const item: BackgroundItem = { kind: 'turn', task: succeededTask };
    expect(itemIsRunning(item)).toBe(false);
  });

  it('returns true for a running subagent-job', () => {
    const item: BackgroundItem = { kind: 'subagent', job: runningJob };
    expect(itemIsRunning(item)).toBe(true);
  });

  it('returns false for a completed subagent-job', () => {
    const item: BackgroundItem = { kind: 'subagent', job: completedJob };
    expect(itemIsRunning(item)).toBe(false);
  });

  it('returns false for a failed subagent-job', () => {
    const item: BackgroundItem = { kind: 'subagent', job: failedJob };
    expect(itemIsRunning(item)).toBe(false);
  });
});

describe('type discrimination', () => {
  it('builds a mixed BackgroundItem[] and retrieves stable ids', () => {
    const items: BackgroundItem[] = [
      { kind: 'turn', task: runningTask },
      { kind: 'subagent', job: runningJob },
      { kind: 'turn', task: succeededTask },
      { kind: 'subagent', job: completedJob },
    ];

    const ids = items.map((item) => itemId(item));
    expect(ids).toEqual(['bg-1', 'bgsub-1', 'bg-2', 'bgsub-2']);

    // Verify that type narrowing compiles: tsc will error if the discriminant
    // branches don't cover the full union.
    for (const item of items) {
      if (item.kind === 'turn') {
        // item.task must be BackgroundTask — tsc validates this
        expect(typeof item.task.id).toBe('string');
      } else {
        // item.job must be BackgroundJob — tsc validates this
        expect(typeof item.job.jobId).toBe('string');
      }
    }
  });
});
