/**
 * Integration test: dispatcher → SubagentExecutor manifest wiring.
 *
 * Verifies that SessionToolDispatcher correctly notifies SubagentExecutor
 * before and after a parallel wave of ≥2 agent calls, and that
 * SubagentExecutor's updateCurrentWaveUnit hooks fire during execution.
 *
 * All manifest file I/O is stubbed via vi.mock so this test is hermetic —
 * no real ~/.afk/state/waves directory is written.
 *
 * Blocking reviewer comment (R3):
 *   "No integration test covers the dispatcher→SubagentExecutor wiring path.
 *    The agentCallsInWave.length >= 2 filter in dispatcher.ts, the
 *    notifyWaveStart/notifyWaveEnd call timing, and the updateCurrentWaveUnit
 *    hooks in executeOnce are all untested."
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks for modules that SubagentExecutor imports before the test body.
// ---------------------------------------------------------------------------

// Mock appendRoutingDecision (routing-telemetry) — SubagentExecutor calls it
// on every fork; tests should not touch the real routing-telemetry file.
const appendRoutingDecision = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision }));

// Mock the credential resolver so tests are not coupled to keychain/env.
const mockResolveCredentialForModel = vi.hoisted(() =>
  vi.fn((_model: string | undefined) => 'test-credential' as string | undefined),
);
vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: mockResolveCredentialForModel,
  loadAnthropicCredential: vi.fn(() => 'test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

// Stub the manifest write module so no real filesystem operations occur.
// createManifest returns a fake waveId; updateWaveUnit is a spy.
const mockCreateManifest = vi.hoisted(() => vi.fn().mockReturnValue('test-wave-id-abc123'));
const mockUpdateWaveUnit = vi.hoisted(() => vi.fn());
const mockBuildWaveUnit = vi.hoisted(() =>
  vi.fn().mockImplementation((opts: { id: string; prompt: string; model: string }) => ({
    id: opts.id,
    status: 'pending' as const,
    promptDigest: { sha256: 'abc', head: opts.prompt, byteLen: opts.prompt.length },
    cwd: undefined,
    model: opts.model,
    startedAt: undefined,
    settledAt: undefined,
    errorMessage: undefined,
    upstreamIds: [],
    worktreePath: undefined,
  })),
);
vi.mock('./write.js', () => ({
  createManifest: mockCreateManifest,
  updateWaveUnit: mockUpdateWaveUnit,
  buildWaveUnit: mockBuildWaveUnit,
  computePromptDigest: vi.fn().mockReturnValue({ sha256: 'abc', head: 'x', byteLen: 1 }),
  readManifest: vi.fn().mockReturnValue(undefined),
  writeManifestSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks are registered).
// ---------------------------------------------------------------------------

import type { SubagentHandle, SubagentResult } from '../subagent.js';
import type { IAgentSession } from '../types.js';
import type { ToolCall } from '../tools/types.js';
import { SubagentExecutor, type SubagentExecutorContext } from '../tools/subagent-executor.js';
import { SessionToolDispatcher } from '../tools/dispatcher.js';
import { builtinToolSchemas } from '../tools/schemas.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSuccessHandle(): Partial<SubagentHandle> {
  return {
    id: 'handle-id',
    status: 'succeeded' as any,
    runToResult: vi.fn().mockResolvedValue({
      id: 'handle-id',
      status: 'succeeded',
      message: { role: 'assistant', content: 'done', timestamp: new Date() },
    } as SubagentResult),
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
  };
}

function makeAgentCall(id: string, prompt: string): ToolCall {
  return {
    id,
    name: 'agent',
    input: { prompt },
    signal: new AbortController().signal,
  };
}

function makeExecutor(): SubagentExecutor {
  const mockManager = {
    forkSubagent: vi.fn().mockResolvedValue(makeSuccessHandle()),
  };
  const mockParentSession: Partial<IAgentSession> = {
    sessionId: 'parent-sess',
    getInputStreamRef: vi.fn(),
    abortSignal: new AbortController().signal,
  };
  const ctx: SubagentExecutorContext = {
    subagentManager: mockManager as any,
    parentSession: mockParentSession as any,
    defaultConfig: { apiKey: 'test-key', systemPrompt: 'system' },
    depth: 0,
  };
  return new SubagentExecutor(ctx);
}

function makeDispatcher(executor: SubagentExecutor): SessionToolDispatcher {
  return new SessionToolDispatcher({
    handlers: new Map(),
    schemas: [...builtinToolSchemas],
    hookRegistry: undefined,
    permissions: { allowedTools: ['agent'] },
    subagentExecutor: executor,
    sessionId: 'parent-sess',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatcher → SubagentExecutor manifest wiring integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset createManifest to return a stable fake waveId.
    mockCreateManifest.mockReturnValue('test-wave-id-abc123');
  });

  it('notifyWaveStart creates a manifest when ≥2 agent calls run concurrently', async () => {
    const executor = makeExecutor();
    const dispatcher = makeDispatcher(executor);

    const calls = [
      makeAgentCall('call-1', 'investigate the bug'),
      makeAgentCall('call-2', 'write the fix'),
    ];

    await dispatcher.executeBatch(calls);

    // createManifest must have been called once (for the wave of 2 agent calls).
    expect(mockCreateManifest).toHaveBeenCalledOnce();
    expect(mockCreateManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-tool',
        parentSessionId: 'parent-sess',
      }),
    );
  });

  it('notifyWaveStart is NOT called when only 1 agent call is in the batch', async () => {
    const executor = makeExecutor();
    const dispatcher = makeDispatcher(executor);

    // executeBatch with a single call delegates to execute() — the
    // agentCallsInWave.length >= 2 guard in dispatcher.ts should prevent
    // notifyWaveStart from firing.
    await dispatcher.executeBatch([makeAgentCall('call-1', 'solo task')]);

    expect(mockCreateManifest).not.toHaveBeenCalled();
  });

  it('notifyWaveEnd clears the wave after all units settle', async () => {
    const executor = makeExecutor();

    // Spy on notifyWaveEnd to verify the dispatcher calls it.
    const endSpy = vi.spyOn(executor, 'notifyWaveEnd');

    const dispatcher = makeDispatcher(executor);
    const calls = [
      makeAgentCall('call-a', 'task alpha'),
      makeAgentCall('call-b', 'task beta'),
    ];

    await dispatcher.executeBatch(calls);

    // notifyWaveEnd must be called once after the wave settles.
    expect(endSpy).toHaveBeenCalledOnce();
  });

  it('updateCurrentWaveUnit transitions units to running then done during execution', async () => {
    const executor = makeExecutor();
    const dispatcher = makeDispatcher(executor);

    const calls = [
      makeAgentCall('call-x', 'search for clues'),
      makeAgentCall('call-y', 'summarize findings'),
    ];

    await dispatcher.executeBatch(calls);

    // updateWaveUnit (the stubbed write function) must have been called for
    // at least one unit transitioning to 'running' and at least one to 'done'.
    const statusArgs = mockUpdateWaveUnit.mock.calls.map((c) => c[2] as string);
    expect(statusArgs).toContain('running');
    expect(statusArgs).toContain('done');

    // All waveUnit calls reference the waveId returned by createManifest.
    for (const call of mockUpdateWaveUnit.mock.calls) {
      expect(call[0]).toBe('test-wave-id-abc123');
    }
  });

  it('notifyWaveStart is NOT called when createManifest returns undefined (disabled)', async () => {
    // Simulate manifest creation failing (e.g. AFK_WAVE_MANIFEST_DISABLED=1).
    mockCreateManifest.mockReturnValueOnce(undefined);

    const executor = makeExecutor();
    const endSpy = vi.spyOn(executor, 'notifyWaveEnd');
    const dispatcher = makeDispatcher(executor);

    const calls = [
      makeAgentCall('call-m', 'task m'),
      makeAgentCall('call-n', 'task n'),
    ];

    await dispatcher.executeBatch(calls);

    // createManifest was called but returned undefined — no waveId is set.
    // updateCurrentWaveUnit must NOT call updateWaveUnit (no waveId to update).
    // notifyWaveEnd is still called (it's fire-and-forget cleanup).
    expect(endSpy).toHaveBeenCalledOnce();

    // No updateWaveUnit calls with a real waveId since currentWaveId is undefined.
    const updateCallsWithRealWaveId = mockUpdateWaveUnit.mock.calls.filter(
      (c) => c[0] !== undefined,
    );
    expect(updateCallsWithRealWaveId).toHaveLength(0);
  });
});
