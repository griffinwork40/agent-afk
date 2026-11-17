/**
 * Which worktree-isolated chains are continuable (#4266 review):
 *   - background (and, by the same path, promoted) isolated runs never keep
 *     their tree, so the chain is not advertised and is refused at admission;
 *   - a foreground isolated chain keeps its tree and every link runs there;
 *   - a read-only isolation:"worktree" dispatch gets no tree and continues in
 *     the parent cwd;
 *   - session end or reset (`dispose()`) releases ended links immediately and
 *     running links when they end; a lock racing dispose or eviction is undone.
 *
 * No real model calls and no real git: the worktree primitives and
 * execFileAsync are mocked, as in continuation-worktree.test.ts.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'resolved-test-credential'),
  loadAnthropicCredential: vi.fn(() => 'resolved-test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));
vi.mock('../../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn().mockResolvedValue(undefined) }));

const createIsolatedWorktree = vi.hoisted(() => vi.fn());
const teardownIsolatedWorktree = vi.hoisted(() => vi.fn());
vi.mock('../handlers/worktree-managed.js', () => ({ createIsolatedWorktree, teardownIsolatedWorktree }));

const execFileAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/exec-file.js', () => ({ execFileAsync }));

// The previous child's journal fold: any non-empty history admits the seed.
vi.mock('../../journal/index.js', async (original) => ({
  ...await original<typeof import('../../journal/index.js')>(),
  loadJournalMessages: vi.fn(() => [{ role: 'user', content: 'earlier run' }]),
}));

// Foreground path: run the child, then the isolation teardown hook, in the
// same order as the real runForegroundWithPromotion finally block.
const runForegroundWithPromotion = vi.hoisted(() => vi.fn());
vi.mock('./foreground-promotion.js', () => ({ runForegroundWithPromotion }));

import type { SubagentHandle, SubagentResult } from '../../subagent.js';
import type { ToolResult } from '../types.js';
import { SubagentExecutor, type SubagentExecutorContext } from '../subagent-executor.js';
import { ContinuationRegistry, type ChainRecord } from '../../subagent/continuation-registry.js';
import { builtinAgents } from '../../agents/builtins.js';
import { buildIsolationTeardownHook, keepWorktreeForChain } from './continuation-worktree.js';
import { isContinuableChain, recordChainTerminal } from './continuation-dispatch.js';
import { buildContinuationRegistry } from '../../session/wire-executors.js';

const ISO = { path: '/repo/.afk-worktrees/iso-agent-tool-1-abc', branch: 'afk/iso', baseRef: 'HEAD', baseSha: 'deadbeef', repoRoot: '/repo' };

function cappedResult(): SubagentResult {
  return {
    id: 'child-1', status: 'succeeded',
    message: { role: 'assistant', content: 'partial', timestamp: new Date() },
    stopReason: 'tool_use_loop_capped', incomplete: true, incompleteReason: 'tool_use_loop_capped', roundsUsed: 5,
  } as unknown as SubagentResult;
}

function mockHandle(): Partial<SubagentHandle> {
  return {
    id: 'child-1',
    status: 'succeeded' as SubagentHandle['status'],
    runToResult: vi.fn().mockResolvedValue(cappedResult()),
    runInBackground: vi.fn((_p: string, cb?: (r: SubagentResult) => void) => { cb?.(cappedResult()); }) as never,
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
    session: { messageJournal: { length: 3, flush: vi.fn().mockResolvedValue(undefined) } } as never,
  };
}

type Out = ToolResult & { continuation?: { chainId: string; continuable: boolean } };

function setup(extra: Partial<SubagentExecutorContext> = {}) {
  const registry = new ContinuationRegistry();
  const forkSubagent = vi.fn(async (_args: unknown) => mockHandle());
  const delivered: SubagentResult[] = [];
  const backgroundRegistry = {
    register: (a: { handle: SubagentHandle; prompt: string; onCleanup?: () => Promise<void> }) => {
      a.handle.runInBackground(a.prompt, (r) => { delivered.push(r); void a.onCleanup?.(); });
      return { jobId: 'job-1', subagentId: 'child-1', label: 'bg' };
    },
    on: vi.fn(), off: vi.fn(),
  };
  const ctx: SubagentExecutorContext = {
    subagentManager: { forkSubagent } as never,
    parentSession: { sessionId: 'root-1', getInputStreamRef: vi.fn(), abortSignal: new AbortController().signal } as never,
    defaultConfig: { apiKey: 'test-key', systemPrompt: 'sys' },
    defaultSubagentModel: 'sonnet',
    depth: 0,
    cwd: '/repo',
    continuationRegistry: registry,
    backgroundRegistry: backgroundRegistry as never,
    ...extra,
  };
  const executor = new SubagentExecutor(ctx);
  let n = 0;
  const run = (input: Record<string, unknown>): Promise<Out> =>
    executor.execute({ id: `c${n++}`, name: 'agent', input, signal: new AbortController().signal }) as Promise<Out>;
  const settled = async (chainId: string): Promise<ChainRecord> => {
    const chain = registry.get(chainId)!;
    await vi.waitFor(() => expect(chain.inFlight).toBe(false));
    return chain;
  };
  return { registry, forkSubagent, delivered, run, settled };
}

beforeEach(() => {
  vi.clearAllMocks();
  createIsolatedWorktree.mockResolvedValue(ISO);
  teardownIsolatedWorktree.mockResolvedValue({ removed: true, preserved: false });
  execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
  runForegroundWithPromotion.mockImplementation(async (a: {
    handle: SubagentHandle; prompt: string;
    isolationTeardown?: { repoRoot: string; worktreePath: string };
    onIsolationTeardown?: (td: { repoRoot: string; worktreePath: string }) => Promise<boolean>;
  }) => {
    const r = await a.handle.runToResult(a.prompt as never);
    if (a.isolationTeardown !== undefined) {
      const kept = a.onIsolationTeardown !== undefined ? await a.onIsolationTeardown(a.isolationTeardown) : false;
      if (!kept) await teardownIsolatedWorktree(a.isolationTeardown);
    }
    return { content: String(r.message?.content), incomplete: r.incomplete, incompleteReason: r.incompleteReason };
  });
});

const lockCalls = () => execFileAsync.mock.calls.filter((c) => (c[1] as string[]).includes('lock'));

describe('isolated chain continuability', () => {
  it('background isolated chain: not advertised, and its continuation is refused as not kept', async () => {
    const { registry, delivered, run, settled, forkSubagent } = setup();
    const started = await run({ prompt: 'build it', isolation: 'worktree', mode: 'background' });
    expect(started.isError, started.content).not.toBe(true);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const result = delivered[0]! as SubagentResult & { continuation?: { chainId: string; continuable: boolean } };
    expect(result.continuation?.continuable).toBe(false);
    expect(String(result.message?.content)).not.toContain('[continuation:');
    const chain = await settled(result.continuation!.chainId);
    expect(chain.worktreeIsolated).toBe(true);
    expect(chain.isolatedWorktreePath).toBeUndefined();
    expect(chain.latestChildId).toBe('child-1'); // refused for the worktree, not for a missing journal

    const cont = await run({ prompt: 'more', continuation_chain_id: chain.chainId });
    expect(cont.isError).toBe(true);
    expect(cont.content).toContain('ran in an isolated worktree that was not kept for it');
    expect(cont.content).toContain('dispatch a new subagent instead');
    expect(forkSubagent).toHaveBeenCalledTimes(1);
    expect(registry.get(chain.chainId)!.continuations).toBe(0);
  });

  it('a failed worktree lock: foreground chain is not advertised and is refused', async () => {
    execFileAsync.mockRejectedValue(new Error('lock failed'));
    const { run, settled } = setup();
    const first = await run({ prompt: 'build it', isolation: 'worktree' });
    expect(first.continuation?.continuable).toBe(false);
    expect(first.content).not.toContain('[continuation:');
    expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1);
    const chain = await settled(first.continuation!.chainId);
    const cont = await run({ prompt: 'more', continuation_chain_id: chain.chainId });
    expect(cont.content).toContain('was not kept for it');
  });

  it('foreground isolated chain: continuable across links, each link runs in the kept worktree', async () => {
    const { run, settled, forkSubagent } = setup();
    const first = await run({ prompt: 'build it', isolation: 'worktree' });
    expect(first.continuation?.continuable).toBe(true);
    expect(first.content).toContain('[continuation:');
    const chainId = first.continuation!.chainId;
    expect((await settled(chainId)).isolatedWorktreePath).toBe(ISO.path);
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();

    for (let link = 1; link <= 2; link++) {
      const next = await run({ prompt: `more ${link}`, continuation_chain_id: chainId });
      expect(next.isError, next.content).not.toBe(true);
      expect(next.continuation?.continuable).toBe(true);
      expect(next.content).toContain('[continuation:');
      const forkArgs = forkSubagent.mock.calls[link]![0] as unknown as { config: { cwd?: string } };
      expect(forkArgs.config.cwd).toBe(ISO.path);
      const chain = await settled(chainId);
      expect(chain.continuations).toBe(link);
      expect(chain.isolatedWorktreePath).toBe(ISO.path);
    }
    expect(createIsolatedWorktree).toHaveBeenCalledTimes(1);
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
  });

  it('read-only isolation:"worktree" chain gets no worktree and stays continuable in the parent cwd', async () => {
    const { run, settled, forkSubagent } = setup({ agentRegistry: builtinAgents() });
    const first = await run({ prompt: 'find where foo is defined', agent_type: 'Explore', isolation: 'worktree' });
    expect(first.isError, first.content).not.toBe(true);
    expect(createIsolatedWorktree).not.toHaveBeenCalled();
    expect(first.continuation?.continuable).toBe(true);
    const chain = await settled(first.continuation!.chainId);
    expect(chain.inputs.isolation).toBe('worktree');
    expect(chain.worktreeIsolated).toBeUndefined();

    const next = await run({ prompt: 'keep looking', continuation_chain_id: chain.chainId });
    expect(next.isError, next.content).not.toBe(true);
    expect(forkSubagent).toHaveBeenCalledTimes(2);
    const forkArgs = forkSubagent.mock.calls[1]![0] as unknown as { config: { cwd?: string } };
    expect(forkArgs.config.cwd ?? '/repo').toBe('/repo');
  });
});

describe('session end or reset releases kept worktrees (dispose)', () => {
  const td = { repoRoot: '/repo', worktreePath: ISO.path };
  const isoInputs = { writeCapable: true, isolation: 'worktree' as const };

  const terminal = { childId: 'child-1', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: 'capped' };

  // Wire the production onEvict callback onto an existing registry so tests
  // stay in sync with wire-executors.ts without maintaining a hand-rolled copy
  // (#4957). Returns a vi.fn() spy wrapping the real callback.
  function wireRelease(registry: ContinuationRegistry): ReturnType<typeof vi.fn> {
    const proto = buildContinuationRegistry(undefined);
    const realOnEvict = proto.onEvict!;
    const onEvict = vi.fn((chain: ChainRecord) => realOnEvict(chain));
    registry.onEvict = onEvict;
    return onEvict;
  }

  async function expectReleasedOnce() {
    await vi.waitFor(() => expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1));
    expect(teardownIsolatedWorktree).toHaveBeenCalledWith(td);
    expect(execFileAsync.mock.calls.filter((c) => (c[1] as string[]).includes('unlock'))).toHaveLength(1);
  }

  it('releases an ended child at dispose while its in flight bookkeeping is settling', async () => {
    const registry = new ContinuationRegistry();
    const onEvict = wireRelease(registry);
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: isoInputs });
    registry.setIsolatedWorktreePath(chain.chainId, ISO.path);
    registry.setSettling(chain.chainId, new Promise<void>(() => undefined));
    expect(chain.inFlight).toBe(true);
    registry.dispose();
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(chain.worktreeReleaseRequested).toBe(true);
    expect(chain.isolatedWorktreePath).toBeUndefined();
    expect(registry.get(chain.chainId)).toBe(chain);
    registry.recordTerminal(chain.chainId, terminal);
    registry.dispose();
    await expectReleasedOnce();
    expect(onEvict).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('defers running child release until terminal, exhausted: %s', async (exhausted) => {
    const registry = new ContinuationRegistry({ maxRounds: 150, maxContinuations: exhausted ? 1 : 3 });
    const onEvict = wireRelease(registry);
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: isoInputs });
    registry.recordTerminal(chain.chainId, terminal);
    registry.setIsolatedWorktreePath(chain.chainId, ISO.path);
    expect(registry.admitContinuation(chain.chainId, 'o', 5, 5).ok).toBe(true);
    expect(chain.settling).toBeUndefined();
    registry.dispose();
    expect(chain.worktreeReleaseRequested).toBe(true);
    expect(chain.isolatedWorktreePath).toBe(ISO.path);
    expect(onEvict).not.toHaveBeenCalled();
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
    expect(execFileAsync).not.toHaveBeenCalled();
    await recordChainTerminal({ registry, chain, ...terminal, cwd: undefined });
    expect(chain.inFlight).toBe(false);
    expect(chain.isolatedWorktreePath).toBeUndefined();
    registry.recordTerminal(chain.chainId, terminal);
    registry.dispose();
    await expectReleasedOnce();
    expect(onEvict).toHaveBeenCalledTimes(1);
  });

  it('defers an admitted but never started link until rollback clears in flight', async () => {
    const registry = new ContinuationRegistry();
    const onEvict = wireRelease(registry);
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: isoInputs });
    registry.recordTerminal(chain.chainId, terminal);
    registry.setIsolatedWorktreePath(chain.chainId, ISO.path);
    const admission = registry.admitContinuation(chain.chainId, 'o', 5, 5);
    expect(admission.ok).toBe(true);
    if (!admission.ok) throw new Error(admission.reason);
    registry.dispose();
    expect(chain.worktreeReleaseRequested).toBe(true);
    expect(onEvict).not.toHaveBeenCalled();
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
    expect(execFileAsync).not.toHaveBeenCalled();
    admission.rollback();
    expect(chain.inFlight).toBe(false);
    expect(chain.isolatedWorktreePath).toBeUndefined();
    admission.rollback();
    registry.dispose();
    await expectReleasedOnce();
    expect(onEvict).toHaveBeenCalledTimes(1);
  });

  it('undoes a lock if its chain was evicted while locking', async () => {
    const registry = new ContinuationRegistry(undefined, 1);
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: isoInputs });
    registry.recordTerminal(chain.chainId, terminal);
    execFileAsync.mockImplementationOnce(async () => {
      registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: isoInputs });
      return { stdout: '', stderr: '' };
    });
    const kept = await keepWorktreeForChain({ ...td, chainId: chain.chainId, registry });
    expect(registry.get(chain.chainId)).toBeUndefined();
    expect(kept).toBe(false);
    expect(execFileAsync).toHaveBeenLastCalledWith('git', ['-C', '/repo', 'worktree', 'unlock', ISO.path]);
    if (!kept) await teardownIsolatedWorktree(td);
    expect(teardownIsolatedWorktree).toHaveBeenCalledWith(td);
  });

  it('a teardown hook that runs after dispose (cancelled link) tears down instead of keeping', async () => {
    const registry = new ContinuationRegistry();
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: isoInputs });
    const hook = buildIsolationTeardownHook(td, chain, registry, isContinuableChain)!;
    registry.dispose();
    expect(await hook(td)).toBe(false);
    expect(lockCalls()).toHaveLength(0);
    expect(chain.isolatedWorktreePath).toBeUndefined();
  });

  it('a lock that completes after dispose is undone', async () => {
    const registry = new ContinuationRegistry();
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: isoInputs });
    execFileAsync.mockImplementationOnce(async () => { registry.dispose(); return { stdout: '', stderr: '' }; });
    expect(await keepWorktreeForChain({ ...td, chainId: chain.chainId, registry })).toBe(false);
    expect(chain.isolatedWorktreePath).toBeUndefined();
    const unlock = execFileAsync.mock.calls.find((c) => (c[1] as string[]).includes('unlock'));
    expect(unlock?.[1]).toContain(ISO.path);
  });

  it('chains minted after a reset dispose still keep their worktree', async () => {
    const registry = new ContinuationRegistry();
    registry.dispose(); // REPL reset: the same registry stays in use
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: isoInputs });
    const hook = buildIsolationTeardownHook(td, chain, registry, isContinuableChain)!;
    expect(await hook(td)).toBe(true);
    expect(chain.isolatedWorktreePath).toBe(ISO.path);
  });
});
