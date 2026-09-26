/**
 * Unit tests for getBackgroundJobHealth — the model-side job health inspector.
 *
 * Key behaviors under test:
 *   - Input validation (missing / empty jobId)
 *   - Missing registry
 *   - Unknown jobId (no leak of other IDs)
 *   - Cross-session ownership guard
 *   - Happy path: returns a JSON health snapshot for a caller-owned running job
 *   - idleSinceMs present for running jobs, absent for terminal jobs
 *   - Surfaces pendingSteeringMessages when handle has _steeringMessages
 *   - Surfaces recentProgressEvents when handle has _progressEvents
 */

import { describe, it, expect, vi } from 'vitest';
import { getBackgroundJobHealth } from './background-health.js';
import type { BackgroundAgentRegistry, BackgroundJob } from '../../background-registry.js';
import type { SubagentHandle } from '../../subagent/handle.js';
import type { ToolCall } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCall(jobId: unknown): ToolCall {
  return {
    id: 'call-health-1',
    name: 'get_background_job_health',
    input: { jobId },
  } as unknown as ToolCall;
}

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    jobId: 'job-health-abc',
    parentSessionId: 'session-parent',
    provenance: 'model',
    status: 'running',
    startedAt: Date.now() - 5000,
    lastActivityAt: Date.now() - 1000,
    model: 'claude-3-5-haiku',
    label: 'test background job',
    ...overrides,
  } as unknown as BackgroundJob;
}

function makeHandle(extras: Record<string, unknown> = {}): SubagentHandle {
  return {
    id: 'handle-1',
    status: 'running',
    steer: vi.fn(),
    cancel: vi.fn(),
    ...extras,
  } as unknown as SubagentHandle;
}

function makeRegistry(
  job: BackgroundJob,
  handle?: SubagentHandle,
): BackgroundAgentRegistry {
  return {
    get: vi.fn((id: string) => (id === job.jobId ? job : undefined)),
    list: vi.fn(() => [job]),
    getHandle: vi.fn(() => handle),
  } as unknown as BackgroundAgentRegistry;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('getBackgroundJobHealth — input validation', () => {
  it('returns isError when jobId is empty string', () => {
    const registry = makeRegistry(makeJob());
    const result = getBackgroundJobHealth(registry, makeCall(''));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/non-empty jobId/i);
  });

  it('returns isError when jobId is not a string', () => {
    const registry = makeRegistry(makeJob());
    const result = getBackgroundJobHealth(registry, makeCall(42));
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing registry
// ---------------------------------------------------------------------------

describe('getBackgroundJobHealth — missing registry', () => {
  it('returns isError when registry is undefined', () => {
    const result = getBackgroundJobHealth(undefined, makeCall('job-health-abc'));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not available/i);
  });
});

// ---------------------------------------------------------------------------
// Unknown jobId — no leak
// ---------------------------------------------------------------------------

describe('getBackgroundJobHealth — unknown jobId', () => {
  it('returns isError without listing other job IDs', () => {
    const registry = makeRegistry(makeJob());
    const result = getBackgroundJobHealth(registry, makeCall('no-such-job'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no-such-job');
    // Must NOT expose the real job IDs
    expect(result.content).not.toContain('job-health-abc');
  });
});

// ---------------------------------------------------------------------------
// Cross-session ownership guard
// ---------------------------------------------------------------------------

describe('getBackgroundJobHealth — cross-session guard', () => {
  it('rejects when callerSessionId does not match parentSessionId', () => {
    const job = makeJob({ parentSessionId: 'session-owner' });
    const registry = makeRegistry(job);
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'), 'session-intruder');
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/different session/i);
  });

  it('allows access when callerSessionId matches parentSessionId', () => {
    const job = makeJob({ parentSessionId: 'session-owner' });
    const registry = makeRegistry(job, makeHandle());
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'), 'session-owner');
    expect(result.isError).toBeFalsy();
  });

  it('allows access when no callerSessionId is provided (unconstrained)', () => {
    const registry = makeRegistry(makeJob(), makeHandle());
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'));
    expect(result.isError).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Happy path: running job
// ---------------------------------------------------------------------------

describe('getBackgroundJobHealth — running job snapshot', () => {
  it('returns a JSON snapshot with expected fields', () => {
    const job = makeJob();
    const registry = makeRegistry(job, makeHandle());
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'));

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.jobId).toBe('job-health-abc');
    expect(parsed.status).toBe('running');
    expect(parsed.model).toBe('claude-3-5-haiku');
    expect(parsed.label).toBe('test background job');
    expect(typeof parsed.elapsedMs).toBe('number');
    expect(parsed.elapsedMs).toBeGreaterThan(0);
    expect(typeof parsed.startedAt).toBe('string');
    expect(typeof parsed.lastActivityAt).toBe('string');
  });

  it('includes idleSinceMs for running jobs', () => {
    const job = makeJob({ status: 'running', lastActivityAt: Date.now() - 2000 });
    const registry = makeRegistry(job, makeHandle());
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'));

    const parsed = JSON.parse(result.content as string);
    expect(typeof parsed.idleSinceMs).toBe('number');
    expect(parsed.idleSinceMs).toBeGreaterThanOrEqual(0);
  });

  it('omits idleSinceMs for terminal jobs', () => {
    const job = makeJob({ status: 'completed', endedAt: Date.now() - 1000 });
    const registry = makeRegistry(job, undefined); // no handle for terminal job
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'));

    const parsed = JSON.parse(result.content as string);
    expect(parsed.idleSinceMs).toBeUndefined();
    expect(typeof parsed.endedAt).toBe('string');
  });

  it('uses startedAt as fallback when lastActivityAt is absent', () => {
    const now = Date.now();
    const job = makeJob({ startedAt: now - 3000, lastActivityAt: undefined });
    const registry = makeRegistry(job, makeHandle());
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'));

    const parsed = JSON.parse(result.content as string);
    // lastActivityAt should fall back to startedAt ISO string
    expect(parsed.lastActivityAt).toBe(new Date(now - 3000).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Handle-level signals
// ---------------------------------------------------------------------------

describe('getBackgroundJobHealth — handle-level signals', () => {
  it('surfaces pendingSteeringMessages when handle has _steeringMessages', () => {
    const job = makeJob();
    const handle = makeHandle({ _steeringMessages: ['msg1', 'msg2'] });
    const registry = makeRegistry(job, handle);
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'));

    const parsed = JSON.parse(result.content as string);
    expect(parsed.pendingSteeringMessages).toBe(2);
  });

  it('omits pendingSteeringMessages when handle lacks _steeringMessages', () => {
    const job = makeJob();
    const handle = makeHandle(); // no _steeringMessages
    const registry = makeRegistry(job, handle);
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'));

    const parsed = JSON.parse(result.content as string);
    expect(parsed.pendingSteeringMessages).toBeUndefined();
  });

  it('surfaces up to 5 recentProgressEvents when handle has _progressEvents', () => {
    const events = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'];
    const job = makeJob();
    const handle = makeHandle({ _progressEvents: events });
    const registry = makeRegistry(job, handle);
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'));

    const parsed = JSON.parse(result.content as string);
    expect(parsed.recentProgressEvents).toHaveLength(5);
    expect(parsed.recentProgressEvents).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']);
  });

  it('omits recentProgressEvents when _progressEvents is empty', () => {
    const job = makeJob();
    const handle = makeHandle({ _progressEvents: [] });
    const registry = makeRegistry(job, handle);
    const result = getBackgroundJobHealth(registry, makeCall('job-health-abc'));

    const parsed = JSON.parse(result.content as string);
    expect(parsed.recentProgressEvents).toBeUndefined();
  });
});
