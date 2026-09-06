/**
 * Unit tests for sendMessageToAgent — the model-side steering dispatcher.
 *
 * Key behaviors under test:
 *   - Input validation (missing jobId / message)
 *   - Missing registry
 *   - Unknown / user-backgrounded / cross-session / non-running job guards
 *   - Missing handle guard
 *   - Provider-capability check: returns isError when setBeforeNextRound is absent
 *   - Happy path: queues message and returns success when provider supports steering
 */

import { describe, it, expect, vi } from 'vitest';
import { sendMessageToAgent } from './send-message.js';
import type { BackgroundAgentRegistry, BackgroundJob } from '../../background-registry.js';
import type { SubagentHandle } from '../../subagent/handle.js';
import type { IAgentSession } from '../../types.js';
import type { ToolCall } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCall(jobId: unknown, message: unknown): ToolCall {
  return {
    id: 'call-1',
    name: 'send_message_to_agent',
    input: { jobId, message },
  } as unknown as ToolCall;
}

/** Build a minimal BackgroundJob stub. */
function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    jobId: 'job-abc',
    parentSessionId: 'session-parent',
    provenance: 'model',
    status: 'running',
    startedAt: new Date(),
    ...overrides,
  } as BackgroundJob;
}

/** Build a session double with or without setBeforeNextRound support. */
function makeSession(supportsSteer: boolean): IAgentSession {
  const base = {
    interrupt: vi.fn(),
    close: vi.fn(),
    reset: vi.fn(),
    getInputStreamRef: vi.fn(),
    pushUserMessage: vi.fn(),
    supportedCommands: vi.fn().mockReturnValue([]),
  } as unknown as IAgentSession;
  if (supportsSteer) {
    (base as Record<string, unknown>)['setBeforeNextRound'] = vi.fn();
  }
  return base;
}

/** Build a minimal SubagentHandle stub. */
function makeHandle(session: IAgentSession): SubagentHandle {
  return {
    id: 'handle-1',
    status: 'running',
    session,
    run: vi.fn(),
    runToResult: vi.fn(),
    runInBackground: vi.fn(),
    cancel: vi.fn(),
    teardown: vi.fn(),
    getLastStopInjectContext: vi.fn(),
    durationMs: undefined,
    sendMessage: vi.fn(),
    steer: vi.fn(),
  } as unknown as SubagentHandle;
}

/** Build a minimal BackgroundAgentRegistry stub. */
function makeRegistry(
  job: BackgroundJob | undefined,
  handle: SubagentHandle | undefined,
): BackgroundAgentRegistry {
  return {
    get: vi.fn().mockReturnValue(job),
    getHandle: vi.fn().mockReturnValue(handle),
    list: vi.fn().mockReturnValue(job ? [job] : []),
  } as unknown as BackgroundAgentRegistry;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('sendMessageToAgent — input validation', () => {
  it('returns isError when jobId is missing', async () => {
    const result = await sendMessageToAgent(undefined, makeCall('', 'hello'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('non-empty jobId');
  });

  it('returns isError when message is missing', async () => {
    const result = await sendMessageToAgent(undefined, makeCall('job-1', ''));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('non-empty');
  });

  it('returns isError when both are missing', async () => {
    const result = await sendMessageToAgent(undefined, makeCall('', ''));
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry / job guards
// ---------------------------------------------------------------------------

describe('sendMessageToAgent — registry and job guards', () => {
  it('returns isError when registry is not wired', async () => {
    const result = await sendMessageToAgent(undefined, makeCall('job-1', 'hi'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('BackgroundAgentRegistry');
  });

  it('returns isError when job is not found', async () => {
    const registry = makeRegistry(undefined, undefined);
    (registry.list as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const result = await sendMessageToAgent(registry, makeCall('job-xyz', 'hi'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  it('returns isError for user-backgrounded job', async () => {
    const job = makeJob({ provenance: 'user' } as Partial<BackgroundJob>);
    const registry = makeRegistry(job, undefined);
    const result = await sendMessageToAgent(registry, makeCall('job-abc', 'hi'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('user');
  });

  it('returns isError for cross-session ownership violation', async () => {
    const job = makeJob({ parentSessionId: 'other-session' });
    const registry = makeRegistry(job, undefined);
    const result = await sendMessageToAgent(registry, makeCall('job-abc', 'hi'), 'my-session');
    expect(result.isError).toBe(true);
    expect(result.content).toContain('different session');
  });

  it('returns non-error for a non-running job', async () => {
    const job = makeJob({ status: 'succeeded' } as Partial<BackgroundJob>);
    const registry = makeRegistry(job, undefined);
    const result = await sendMessageToAgent(registry, makeCall('job-abc', 'hi'));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('succeeded');
  });

  it('returns isError when handle is not available', async () => {
    const job = makeJob();
    const registry = makeRegistry(job, undefined);
    const result = await sendMessageToAgent(registry, makeCall('job-abc', 'hi'));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not available');
  });
});

// ---------------------------------------------------------------------------
// Provider-capability check (the core fix for #1495)
// ---------------------------------------------------------------------------

describe('sendMessageToAgent — provider steering capability check', () => {
  it('returns isError when provider does not support setBeforeNextRound', async () => {
    const job = makeJob();
    const session = makeSession(false); // OpenAI-compatible: no setBeforeNextRound
    const handle = makeHandle(session);
    const registry = makeRegistry(job, handle);

    const result = await sendMessageToAgent(registry, makeCall('job-abc', 'redirect here'));

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Steering is not supported');
    // The message must NOT have been queued
    expect(handle.steer).not.toHaveBeenCalled();
  });

  it('does not queue the message to the ring buffer on unsupported provider', async () => {
    const job = makeJob();
    const session = makeSession(false);
    const handle = makeHandle(session);
    // Expose the steeringMessages so we can confirm nothing was pushed
    (handle as Record<string, unknown>)['_steeringMessages'] = [];
    const registry = makeRegistry(job, handle);

    await sendMessageToAgent(registry, makeCall('job-abc', 'should not land'));

    expect((handle as Record<string, unknown>)['_steeringMessages']).toHaveLength(0);
  });

  it('mentions "Anthropic" in the error to guide the user', async () => {
    const job = makeJob();
    const session = makeSession(false);
    const handle = makeHandle(session);
    const registry = makeRegistry(job, handle);

    const result = await sendMessageToAgent(registry, makeCall('job-abc', 'steer'));

    expect(result.content).toMatch(/anthropic/i);
  });
});

// ---------------------------------------------------------------------------
// Happy path (Anthropic provider — setBeforeNextRound IS present)
// ---------------------------------------------------------------------------

describe('sendMessageToAgent — happy path (Anthropic provider)', () => {
  it('calls handle.steer() and returns success', async () => {
    const job = makeJob();
    const session = makeSession(true); // Anthropic: setBeforeNextRound present
    const handle = makeHandle(session);
    const registry = makeRegistry(job, handle);

    const result = await sendMessageToAgent(registry, makeCall('job-abc', 'focus on the tests'));

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('queued');
    expect(handle.steer).toHaveBeenCalledWith('focus on the tests');
  });

  it('trims whitespace from jobId and message', async () => {
    const job = makeJob();
    const session = makeSession(true);
    const handle = makeHandle(session);
    const registry = makeRegistry(job, handle);

    const result = await sendMessageToAgent(
      registry,
      makeCall('  job-abc  ', '  pivot the plan  '),
    );

    expect(result.isError).toBeFalsy();
    expect(handle.steer).toHaveBeenCalledWith('pivot the plan');
  });

  it('respects callerSessionId ownership for the happy path', async () => {
    const job = makeJob({ parentSessionId: 'my-session' });
    const session = makeSession(true);
    const handle = makeHandle(session);
    const registry = makeRegistry(job, handle);

    const result = await sendMessageToAgent(
      registry,
      makeCall('job-abc', 'do this instead'),
      'my-session',
    );

    expect(result.isError).toBeFalsy();
    expect(handle.steer).toHaveBeenCalled();
  });
});
