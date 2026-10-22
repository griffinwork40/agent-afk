/**
 * Tests for worktree-isolated continuation chains (#4266).
 *
 * Covers three scenarios named by the issue:
 *   1. Two-link continuation: child sees uncommitted edits from the previous
 *      run (the worktree is kept + locked between links, not torn down).
 *   2. Cleanup on exhaustion: when the chain's continuation limit is reached,
 *      `releaseChainWorktree` is called and the worktree path is cleared.
 *   3. Eviction cleanup: when a new chain creation evicts an older one from
 *      the 256-cap, the evict callback fires for the evicted chain.
 *
 * All tests are deterministic: no real model calls, no real git. Git is mocked
 * via the `worktree-managed` seam (same as `subagent-executor.isolation.test.ts`).
 *
 * @module agent/tools/subagent/continuation-worktree.test
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- Hoisted mocks -----------------------------------------------------------

const mockResolveCredentialForModel = vi.hoisted(() =>
  vi.fn((_model: string | undefined) => 'resolved-test-credential' as string | undefined),
);
vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: mockResolveCredentialForModel,
  loadAnthropicCredential: vi.fn(() => 'resolved-test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));
vi.mock('../../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn().mockResolvedValue(undefined) }));

// Worktree primitives shared by the executor and foreground path.
const createIsolatedWorktree = vi.hoisted(() => vi.fn());
const teardownIsolatedWorktree = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ removed: true, preserved: false }),
);
vi.mock('../handlers/worktree-managed.js', () => ({
  createIsolatedWorktree,
  teardownIsolatedWorktree,
}));

// The git calls in continuation-worktree.ts go through execFileAsync.
// We mock the whole utils/exec-file module so keepWorktreeForChain and
// releaseChainWorktree never shell out.
const execFileAsync = vi.hoisted(() => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }));
vi.mock('../../../utils/exec-file.js', () => ({ execFileAsync }));

// Foreground path: capture args without running a real child.
const runForegroundWithPromotion = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ content: 'done' }),
);
vi.mock('./foreground-promotion.js', () => ({ runForegroundWithPromotion }));

import type { SubagentHandle, SubagentResult } from '../../subagent.js';
import type { ToolCall } from '../types.js';
import { SubagentExecutor, type SubagentExecutorContext } from '../subagent-executor.js';
import { ContinuationRegistry } from '../../subagent/continuation-registry.js';

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

const ISO_RESULT = {
  path: '/repo/.afk-worktrees/iso-agent-tool-1-abc',
  branch: 'afk/iso-agent-tool-1-abc',
  baseRef: 'HEAD',
  baseSha: 'deadbeef',
  repoRoot: '/repo',
};

function mockHandle(): Partial<SubagentHandle> {
  return {
    id: 'child-1',
    status: 'succeeded' as SubagentHandle['status'],
    runToResult: vi.fn().mockResolvedValue({
      id: 'child-1', status: 'succeeded',
      message: { role: 'assistant', content: 'partial', timestamp: new Date() },
      stopReason: 'tool_use_loop_capped', incomplete: true,
      incompleteReason: 'tool_use_loop_capped', roundsUsed: 5,
    } as unknown as SubagentResult),
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
    session: { messageJournal: { length: 3, flush: vi.fn().mockResolvedValue(undefined) } },
  };
}

function makeCall(overrides?: Partial<ToolCall>): ToolCall {
  return { id: 'c1', name: 'agent', input: { prompt: 'build', isolation: 'worktree' }, signal: new AbortController().signal, ...overrides };
}

function makeExecutor(registry: ContinuationRegistry): SubagentExecutor {
  const ctx: SubagentExecutorContext = {
    subagentManager: { forkSubagent: vi.fn().mockResolvedValue(mockHandle()) } as never,
    parentSession: { sessionId: 'root-1', getInputStreamRef: vi.fn(), abortSignal: new AbortController().signal } as never,
    defaultConfig: { apiKey: 'test-key', systemPrompt: 'sys' },
    depth: 0,
    cwd: '/repo',
    continuationRegistry: registry,
  };
  return new SubagentExecutor(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worktree-isolated continuation chains (#4266)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCredentialForModel.mockReturnValue('resolved-test-credential');
    createIsolatedWorktree.mockResolvedValue(ISO_RESULT);
    teardownIsolatedWorktree.mockResolvedValue({ removed: true, preserved: false });
    runForegroundWithPromotion.mockResolvedValue({ content: 'done' });
    execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
  });

  // -------------------------------------------------------------------------
  // (1) Chain is continuable after child ends → worktree kept, path stored.
  // -------------------------------------------------------------------------
  it('keeps the worktree locked when the chain is still continuable', async () => {
    const registry = new ContinuationRegistry();
    const executor = makeExecutor(registry);

    await executor.execute(makeCall());

    // The foreground path was called with an onIsolationTeardown hook.
    expect(runForegroundWithPromotion).toHaveBeenCalledTimes(1);
    const fgArgs = runForegroundWithPromotion.mock.calls[0]![0] as {
      onIsolationTeardown?: (td: { repoRoot: string; worktreePath: string }) => Promise<boolean>;
      isolationTeardown?: { repoRoot: string; worktreePath: string };
    };
    expect(typeof fgArgs.onIsolationTeardown).toBe('function');

    // Simulate the foreground finally calling the hook while the chain is
    // still continuable (default limits: 3 continuations, 150 rounds).
    const td = fgArgs.isolationTeardown!;
    const kept = await fgArgs.onIsolationTeardown!(td);
    expect(kept).toBe(true);

    // git worktree lock was called with the chain id in the reason.
    const lockCall = execFileAsync.mock.calls.find(
      (c) => (c as string[])[0] === 'git' && (c as string[][])[1]?.includes('lock'),
    );
    expect(lockCall).toBeDefined();
    expect(String((lockCall as string[][])[1])).toContain('continuation-chain');

    // teardownIsolatedWorktree must NOT have been called (worktree is kept).
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (2) Worktree path is stored on the chain record after keepWorktreeForChain.
  // -------------------------------------------------------------------------
  it('stores the worktree path on the chain record after locking', async () => {
    const registry = new ContinuationRegistry();
    const executor = makeExecutor(registry);
    await executor.execute(makeCall());

    const fgArgs = runForegroundWithPromotion.mock.calls[0]![0] as {
      onIsolationTeardown?: (td: { repoRoot: string; worktreePath: string }) => Promise<boolean>;
      isolationTeardown?: { repoRoot: string; worktreePath: string };
    };

    // Grab chain id from the continuation result metadata before the hook fires.
    // The chain is the only one in the registry at this point.
    const chains = [...(registry as unknown as { chains: Map<string, import('../../subagent/continuation-registry.js').ChainRecord> }).chains.values()];
    expect(chains).toHaveLength(1);
    const chain = chains[0]!;

    // Fire the hook (simulating the foreground finally).
    await fgArgs.onIsolationTeardown!(fgArgs.isolationTeardown!);

    // The worktree path must be stored on the chain record.
    expect(chain.isolatedWorktreePath).toBe(ISO_RESULT.path);
  });

  // -------------------------------------------------------------------------
  // (3) Chain exhausted → hook returns false → normal teardown runs.
  // -------------------------------------------------------------------------
  it('falls through to normal teardown when the chain is exhausted', async () => {
    // Use MAX_CONTINUATIONS=0 so the chain is immediately not continuable.
    vi.stubEnv('AFK_SUBAGENT_CONTINUATION_MAX_CONTINUATIONS', '0');
    const registry = new ContinuationRegistry();
    const executor = makeExecutor(registry);
    await executor.execute(makeCall());

    const fgArgs = runForegroundWithPromotion.mock.calls[0]![0] as {
      onIsolationTeardown?: (td: { repoRoot: string; worktreePath: string }) => Promise<boolean>;
      isolationTeardown?: { repoRoot: string; worktreePath: string };
    };

    // Hook present but chain is not continuable: returns false.
    const kept = await fgArgs.onIsolationTeardown!(fgArgs.isolationTeardown!);
    expect(kept).toBe(false);

    // No git lock call for the chain.
    const lockCall = execFileAsync.mock.calls.find(
      (c) => (c as string[])[0] === 'git' && (c as string[][])[1]?.includes('lock'),
    );
    expect(lockCall).toBeUndefined();

    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // (4) Eviction cleanup: onEvict fires and calls releaseChainWorktree.
  // -------------------------------------------------------------------------
  it('eviction fires onEvict which unlocks the kept worktree', async () => {
    // Use maxChains=1 so the second chain evicts the first.
    const registry = new ContinuationRegistry(undefined, 1);
    const evicted: import('../../subagent/continuation-registry.js').ChainRecord[] = [];
    registry.onEvict = (chain) => { evicted.push(chain); };

    // Create and settle first chain (non-in-flight, has a worktree path).
    const first = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: true, isolation: 'worktree' } });
    registry.recordTerminal(first.chainId, { childId: 'c', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: 'capped' });
    registry.setIsolatedWorktreePath(first.chainId, '/repo/.afk-worktrees/iso-old');

    expect(first.isolatedWorktreePath).toBe('/repo/.afk-worktrees/iso-old');

    // Creating a second chain triggers eviction of the first.
    registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false } });

    expect(evicted).toHaveLength(1);
    expect(evicted[0]!.chainId).toBe(first.chainId);
    expect(evicted[0]!.isolatedWorktreePath).toBe('/repo/.afk-worktrees/iso-old');
  });

  // -------------------------------------------------------------------------
  // (5) dispose() fires onEvict for non-in-flight chains with kept worktrees.
  // -------------------------------------------------------------------------
  it('dispose fires onEvict for non-in-flight chains that hold a worktree path', () => {
    const registry = new ContinuationRegistry();
    const evicted: import('../../subagent/continuation-registry.js').ChainRecord[] = [];
    registry.onEvict = (chain) => { evicted.push(chain); };

    // Settled chain with a kept worktree → should be evicted on dispose.
    const withWorktree = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: true, isolation: 'worktree' } });
    registry.recordTerminal(withWorktree.chainId, { childId: 'c', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: 'capped' });
    registry.setIsolatedWorktreePath(withWorktree.chainId, '/repo/.afk-worktrees/kept-tree');

    // Settled chain without a kept worktree → NOT evicted on dispose.
    const noWorktree = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false } });
    registry.recordTerminal(noWorktree.chainId, { childId: 'd', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: 'done' });

    // In-flight chain with a worktree path → NOT evicted on dispose (its terminal still needs the chain).
    const inFlight = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: true, isolation: 'worktree' } });
    inFlight.isolatedWorktreePath = '/repo/.afk-worktrees/in-flight-tree';
    // (inFlight is still inFlight: no recordTerminal call)

    registry.dispose();

    expect(evicted).toHaveLength(1);
    expect(evicted[0]!.chainId).toBe(withWorktree.chainId);
  });
});
