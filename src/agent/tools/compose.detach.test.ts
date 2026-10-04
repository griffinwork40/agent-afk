/**
 * Tests for compose tool detach contract (#2542).
 *
 * Verifies:
 *  - Normal execution is unchanged when no detachRegistry is provided.
 *  - When a detachRegistry is present and detachAll() fires BEFORE the DAG
 *    completes, the executor returns the detach placeholder result.
 *  - deliver() is called with the DAG result once the DAG finishes.
 *  - When detachAll() fires AFTER the DAG has already completed (race),
 *    the normal result is returned and deregister() is called.
 *  - Session abort after detach: DAG continues running under the session
 *    AbortSignal; cancelAll() marks the token settled so late deliver() is
 *    a no-op.
 *  - composeDetachLabel builds human-readable labels correctly.
 *  - buildComposeDelivery maps failed/succeeded states correctly.
 *  - DETACHABLE_TOOLS includes 'compose'.
 *
 * Uses mocked DAG/subagent infrastructure (same mocks as compose-executor.test.ts)
 * so tests run without spawning real subagents.
 *
 * @module agent/tools/compose.detach.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (must be hoisted before imports that reference them)
// ---------------------------------------------------------------------------

// Controllable DAG: default succeeds immediately; individual tests override.
let resolveDAG: ((result: import('../dag.js').DAGRunResult) => void) | undefined;
let rejectDAG: ((err: Error) => void) | undefined;

const mockRunSubagentDAG = vi.fn(
  () =>
    new Promise<import('../dag.js').DAGRunResult>((resolve, reject) => {
      resolveDAG = resolve;
      rejectDAG = reject;
    }),
);

vi.mock('../dag-subagent.js', () => ({
  runSubagentDAG: (...args: unknown[]) => mockRunSubagentDAG(...args),
}));

// Capture the teardownAll spy from the most recently constructed SubagentManager
// so individual tests can assert call counts.
let lastTeardownAll: ReturnType<typeof vi.fn> | undefined;

vi.mock('../subagent.js', () => ({
  SubagentManager: vi.fn(() => {
    const teardownAll = vi.fn(async () => {});
    lastTeardownAll = teardownAll;
    return {
      forkSubagent: vi.fn(),
      teardownAll,
      kill: vi.fn(async () => true),
      setOnSubagentSucceeded: vi.fn(),
      getReadScopeInputs: vi.fn(),
    };
  }),
}));

vi.mock('../routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn(async () => {}),
}));

vi.mock('../manifest/write.js', () => ({
  buildWaveUnit: vi.fn(() => ({ id: 'u', status: 'pending', upstreamIds: [] })),
  createManifest: vi.fn(() => 'fake-wave-id'),
  updateWaveUnit: vi.fn(),
}));

vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'sk-ant-test'),
}));

vi.mock('./subagent/attachment-resolve.js', () => ({
  resolveSubagentAttachments: vi.fn(async () => []),
}));

vi.mock('./nesting.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./nesting.js')>();
  return { ...original };
});

vi.mock('./compose-agent-resolve.js', () => ({
  resolveComposeNodeAgent: vi.fn(() => ({
    systemPrompt: undefined,
    canUseTool: undefined,
    namedAgentModel: undefined,
  })),
}));

vi.mock('./compose-node-provider.js', () => ({
  resolveComposeNodeProvider: vi.fn(() => ({})),
}));

vi.mock('./child-credential.js', () => ({
  applyParentCredentialFallback: vi.fn(
    ({ resolved, parentApiKey }: { childModel: string; resolved: string | undefined; parentApiKey: string | undefined }) =>
      resolved ?? parentApiKey,
  ),
}));

vi.mock('../providers/index.js', () => ({
  providerForModel: vi.fn(() => 'anthropic'),
}));

vi.mock('../subagent/resolve-child-model.js', () => ({
  resolveChildModel: vi.fn(
    ({ callSiteModel, defaultSubagentModel }: { callSiteModel?: string; namedAgentModel?: string; defaultSubagentModel: string; defaultModel?: string }) =>
      callSiteModel ?? defaultSubagentModel,
  ),
}));

vi.mock('../../paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../paths.js')>();
  return {
    ...actual,
    getSessionsDir: vi.fn(() => '/tmp/test-sessions'),
  };
});

vi.mock('../subagent-read-scope.js', () => ({
  resolveChildManagerReadRoots: vi.fn(() => undefined),
}));

vi.mock('../session/session-identity.js', () => ({
  deriveOrigin: vi.fn(() => 'cli'),
  actorFromDepth: vi.fn(() => 'main'),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { ComposeExecutor } from './compose-executor.js';
import { DetachableToolRegistry, type DetachedToolResult } from './detach-registry.js';
import { composeDetachLabel, buildComposeDelivery } from './detach-compose.js';
import { DETACHABLE_TOOLS } from './detach-bash.js';
import type { ToolCall } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCall(id = 'call-1'): ToolCall {
  const abort = new AbortController();
  return {
    id,
    name: 'compose',
    signal: abort.signal,
    input: {
      nodes: [
        { id: 'node-a', prompt: 'do A' },
        { id: 'node-b', prompt: 'do B' },
      ],
    },
  };
}

function makeCtx() {
  const abort = new AbortController();
  return {
    parentSession: {
      sessionId: 'sess-test',
      abortSignal: abort.signal,
      getJournalRef: () => null,
    },
    defaultSubagentModel: 'claude-3-5-haiku-20241022',
    apiKey: 'sk-ant-test',
    systemPrompt: 'You are a test agent.',
    abort,
  };
}

function dagSuccess(): import('../dag.js').DAGRunResult {
  return {
    outputs: { 'node-a': 'output-A', 'node-b': 'output-B' },
    failed: [],
    skipped: [],
  };
}

/**
 * Drain N microtask ticks. The compose executor has multiple async steps before
 * reaching runSubagentDAG (parseComposeInput, Promise.all for node building,
 * detach registration). A single `await Promise.resolve()` is not enough;
 * draining 5+ ticks ensures the executor is blocked on runSubagentDAG.
 */
async function drainMicrotasks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// composeDetachLabel
// ---------------------------------------------------------------------------

describe('composeDetachLabel', () => {
  it('formats 0 nodes', () => {
    expect(composeDetachLabel([])).toBe('compose [0 nodes]');
  });

  it('formats up to 3 nodes inline', () => {
    expect(composeDetachLabel(['a', 'b', 'c'])).toBe('compose [a, b, c]');
  });

  it('collapses >3 nodes with remainder count', () => {
    expect(composeDetachLabel(['a', 'b', 'c', 'd', 'e'])).toBe('compose [a, b, c … +2 more]');
  });

  it('formats 1 node', () => {
    expect(composeDetachLabel(['solo'])).toBe('compose [solo]');
  });
});

// ---------------------------------------------------------------------------
// buildComposeDelivery
// ---------------------------------------------------------------------------

describe('buildComposeDelivery', () => {
  it('maps failed=false to status completed', () => {
    const r = buildComposeDelivery('id-1', 'compose [a]', 'output', false, Date.now() - 100);
    expect(r.status).toBe('completed');
    expect(r.toolUseId).toBe('id-1');
    expect(r.label).toBe('compose [a]');
    expect(r.output).toBe('output');
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('maps failed=true to status failed', () => {
    const r = buildComposeDelivery('id-2', 'compose [x]', 'err', true, Date.now() - 50);
    expect(r.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// DETACHABLE_TOOLS
// ---------------------------------------------------------------------------

describe('DETACHABLE_TOOLS', () => {
  it('includes compose', () => {
    expect(DETACHABLE_TOOLS.has('compose')).toBe(true);
  });

  it('still includes bash', () => {
    expect(DETACHABLE_TOOLS.has('bash')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ComposeExecutor detach contract
// ---------------------------------------------------------------------------

describe('ComposeExecutor detach contract (#2542)', () => {
  beforeEach(() => {
    // Reset the controllable DAG promise on each test.
    resolveDAG = undefined;
    rejectDAG = undefined;
    lastTeardownAll = undefined;
    mockRunSubagentDAG.mockImplementation(
      () =>
        new Promise<import('../dag.js').DAGRunResult>((resolve, reject) => {
          resolveDAG = resolve;
          rejectDAG = reject;
        }),
    );
  });

  it('normal execution is unchanged when no detachRegistry is provided', async () => {
    // Override: auto-resolve immediately when runSubagentDAG is called.
    mockRunSubagentDAG.mockResolvedValueOnce(dagSuccess());

    const call = makeCall('norm-1');
    const { parentSession } = makeCtx();
    const executor = new ComposeExecutor({
      parentSession,
      defaultSubagentModel: 'claude-3-5-haiku-20241022',
      apiKey: 'sk-ant-test',
      systemPrompt: 'test',
    });

    const result = await executor.execute(call);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('node-a');
  });

  it('returns detach placeholder when detachAll() fires before DAG completes', async () => {
    const call = makeCall('detach-1');
    const { parentSession } = makeCtx();
    const registry = new DetachableToolRegistry();
    const executor = new ComposeExecutor({
      parentSession,
      defaultSubagentModel: 'claude-3-5-haiku-20241022',
      apiKey: 'sk-ant-test',
      systemPrompt: 'test',
    });

    const execPromise = executor.execute(call, registry);

    // Drain microtasks so the executor clears node-building and registers with
    // the registry before we fire detachAll().
    await drainMicrotasks();

    expect(registry.hasDetachable()).toBe(true);

    // Fire Ctrl+B
    registry.detachAll();

    const result = await execPromise;

    // Handler must return the detach placeholder (not an error, not the real output)
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as { status: string };
    expect(parsed.status).toBe('detached');

    // Settle the DAG so the test ends cleanly (no dangling promise)
    resolveDAG?.(dagSuccess());
    await drainMicrotasks();
  });

  it('deliver() receives DAG output once detached DAG finishes', async () => {
    const call = makeCall('detach-2');
    const { parentSession } = makeCtx();
    const registry = new DetachableToolRegistry();
    const executor = new ComposeExecutor({
      parentSession,
      defaultSubagentModel: 'claude-3-5-haiku-20241022',
      apiKey: 'sk-ant-test',
      systemPrompt: 'test',
    });

    const deliveredResults: DetachedToolResult[] = [];
    const settledPromise = new Promise<DetachedToolResult>((resolve) => {
      registry.on('settled', (r: DetachedToolResult) => {
        deliveredResults.push(r);
        resolve(r);
      });
    });

    const execPromise = executor.execute(call, registry);

    // Drain so executor registers with registry
    await drainMicrotasks();

    // Detach
    registry.detachAll();

    const placeholder = await execPromise;
    const parsed = JSON.parse(placeholder.content as string) as { status: string };
    expect(parsed.status).toBe('detached');

    // Now the DAG finishes
    resolveDAG?.({
      outputs: { 'node-a': 'hello from A', 'node-b': 'hello from B' },
      failed: [],
      skipped: [],
    });

    // Wait for deliver() to fire
    const settled = await Promise.race([
      settledPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);

    expect(settled).not.toBeNull();
    expect(deliveredResults).toHaveLength(1);
    expect(deliveredResults[0]!.status).toBe('completed');
    expect(deliveredResults[0]!.output).toContain('node-a');
    expect(deliveredResults[0]!.toolUseId).toBe('detach-2');

    // Teardown contract: on the detach path, the `finally` clause in execute()
    // skips teardownAll (detachedRef.value === true). The continuation's .finally
    // owns it and must call it exactly once after the DAG settles.
    // If this assertion fails, a regression flipped detachedRef.value to false,
    // causing double-teardown (both the finally and the continuation fire it).
    await drainMicrotasks();
    expect(lastTeardownAll).toBeDefined();
    expect(lastTeardownAll!.mock.calls).toHaveLength(1);
  });

  it('teardownAll is NOT called synchronously on the detach path (only after DAG settles)', async () => {
    const call = makeCall('teardown-timing-1');
    const { parentSession } = makeCtx();
    const registry = new DetachableToolRegistry();
    const executor = new ComposeExecutor({
      parentSession,
      defaultSubagentModel: 'claude-3-5-haiku-20241022',
      apiKey: 'sk-ant-test',
      systemPrompt: 'test',
    });

    const execPromise = executor.execute(call, registry);
    await drainMicrotasks();

    // Detach fires — the execute() finally clause must skip teardownAll here
    // because detachedRef.value is true at that point.
    registry.detachAll();
    await execPromise;

    // After execute() returns: teardownAll must NOT have been called yet.
    // The continuation hasn't run because the DAG promise hasn't settled.
    expect(lastTeardownAll).toBeDefined();
    expect(lastTeardownAll!.mock.calls).toHaveLength(0);

    // Now settle the DAG — the continuation's .finally() must call teardownAll.
    resolveDAG?.(dagSuccess());
    await drainMicrotasks();

    expect(lastTeardownAll!.mock.calls).toHaveLength(1);
  });

  it('returns normal result when DAG completes before detachAll() fires (race)', async () => {
    // Auto-resolve immediately when runSubagentDAG is called.
    mockRunSubagentDAG.mockResolvedValueOnce(dagSuccess());

    const call = makeCall('race-1');
    const { parentSession } = makeCtx();
    const registry = new DetachableToolRegistry();
    const executor = new ComposeExecutor({
      parentSession,
      defaultSubagentModel: 'claude-3-5-haiku-20241022',
      apiKey: 'sk-ant-test',
      systemPrompt: 'test',
    });

    const result = await executor.execute(call, registry);

    // Fire detachAll AFTER execute() has already returned
    registry.detachAll();

    // Must return normal success, not a detach placeholder
    expect(result.isError).toBeFalsy();
    try {
      const parsed = JSON.parse(result.content as string) as { status?: string };
      expect(parsed.status).not.toBe('detached');
    } catch {
      // Not JSON — definitely not a detach placeholder
    }
    // Token must be cleaned up
    expect(registry.hasDetachable()).toBe(false);
  });

  it('normal-complete deregisters token so hasDetachable() becomes false', async () => {
    const call = makeCall('norm-2');
    const { parentSession } = makeCtx();
    const registry = new DetachableToolRegistry();
    const executor = new ComposeExecutor({
      parentSession,
      defaultSubagentModel: 'claude-3-5-haiku-20241022',
      apiKey: 'sk-ant-test',
      systemPrompt: 'test',
    });

    const execPromise = executor.execute(call, registry);

    // Drain so executor registers with registry before we assert hasDetachable
    await drainMicrotasks();

    // Registry should see the token before DAG completes
    expect(registry.hasDetachable()).toBe(true);

    resolveDAG?.(dagSuccess());
    await execPromise;

    // After normal completion, slot must be freed (Fix #2 analogue)
    expect(registry.hasDetachable()).toBe(false);
    expect(registry.listRunning()).toEqual([]);
  });

  it('cancelAll() on a detached token prevents late deliver() from emitting settled', async () => {
    const call = makeCall('cancel-1');
    const { parentSession } = makeCtx();
    const registry = new DetachableToolRegistry();
    const executor = new ComposeExecutor({
      parentSession,
      defaultSubagentModel: 'claude-3-5-haiku-20241022',
      apiKey: 'sk-ant-test',
      systemPrompt: 'test',
    });

    const settledEvents: DetachedToolResult[] = [];
    registry.on('settled', (r: DetachedToolResult) => settledEvents.push(r));

    const execPromise = executor.execute(call, registry);

    await drainMicrotasks();

    // Detach then simulate session teardown
    registry.detachAll();
    await execPromise;

    registry.cancelAll();

    // Now settle the DAG (simulates the continuation running after cancelAll)
    resolveDAG?.(dagSuccess());
    // Drain microtasks so the continuation's .then() fires
    await drainMicrotasks();

    // deliver() should be a no-op — cancelAll() marked the token settled
    expect(settledEvents).toHaveLength(0);
  });

  it('failed DAG after detach delivers failed status', async () => {
    const call = makeCall('fail-1');
    const { parentSession } = makeCtx();
    const registry = new DetachableToolRegistry();
    const executor = new ComposeExecutor({
      parentSession,
      defaultSubagentModel: 'claude-3-5-haiku-20241022',
      apiKey: 'sk-ant-test',
      systemPrompt: 'test',
    });

    const deliveredResults: DetachedToolResult[] = [];
    const settledPromise = new Promise<DetachedToolResult>((resolve) => {
      registry.on('settled', (r: DetachedToolResult) => {
        deliveredResults.push(r);
        resolve(r);
      });
    });

    const execPromise = executor.execute(call, registry);

    await drainMicrotasks();

    registry.detachAll();
    await execPromise;

    // DAG throws after detach
    rejectDAG?.(new Error('DAG exploded'));

    const settled = await Promise.race([
      settledPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);

    expect(settled).not.toBeNull();
    expect(deliveredResults[0]!.status).toBe('failed');
    expect(deliveredResults[0]!.output).toContain('DAG exploded');
  });
});
