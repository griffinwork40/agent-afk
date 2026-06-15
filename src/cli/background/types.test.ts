import { describe, it, expect } from 'vitest';
import type { BackgroundJob } from '../../agent/background-registry.js';
import { type BackgroundItem, itemId, itemStartedAt, itemIsRunning } from './types.js';

// ---------------------------------------------------------------------------
// Minimal fixtures — cast to the real type so tsc validates field names.
// `BackgroundItem` is subagent-only since the whole-turn-detach subsystem
// (BackgroundTaskManager / the `turn` kind) was removed.
// ---------------------------------------------------------------------------

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
  it('returns job.jobId for subagent-kind', () => {
    const item: BackgroundItem = { kind: 'subagent', job: runningJob };
    expect(itemId(item)).toBe('bgsub-1');
  });
});

describe('itemStartedAt', () => {
  it('returns job.startedAt for subagent-kind', () => {
    const item: BackgroundItem = { kind: 'subagent', job: completedJob };
    expect(itemStartedAt(item)).toBe(4_000_000);
  });
});

describe('itemIsRunning', () => {
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

describe('BackgroundItem (subagent-only)', () => {
  it('builds a BackgroundItem[] and retrieves stable ids', () => {
    const items: BackgroundItem[] = [
      { kind: 'subagent', job: runningJob },
      { kind: 'subagent', job: completedJob },
    ];
    expect(items.map(itemId)).toEqual(['bgsub-1', 'bgsub-2']);
    for (const item of items) {
      expect(typeof item.job.jobId).toBe('string');
    }
  });
});
