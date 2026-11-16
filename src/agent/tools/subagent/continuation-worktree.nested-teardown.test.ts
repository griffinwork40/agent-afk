/**
 * A kept chain worktree is never released (unlocked or removed) before the
 * link that just ran has torn down its nested subagents (#4285 review).
 * Covers exhaustion (recordChainTerminal), dispose(), and eviction, for
 * foreground-style (runToResult) and background (runInBackground) runs.
 * Ordering is driven by controllable promises; no timers.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

const teardownIsolatedWorktree = vi.hoisted(() => vi.fn());
vi.mock('../handlers/worktree-managed.js', () => ({ teardownIsolatedWorktree, createIsolatedWorktree: vi.fn() }));
const execFileAsync = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/exec-file.js', () => ({ execFileAsync }));

import type { SubagentResult } from '../../subagent.js';
import { ContinuationRegistry, type ChainRecord } from '../../subagent/continuation-registry.js';
import { instrumentHandleForChain } from './continuation-dispatch.js';
import { releaseChainWorktree, repoRootFromWorktreePath } from './continuation-worktree.js';

const REPO = path.join(os.tmpdir(), 'nested-teardown-repo');
const TREE = path.join(REPO, '.afk-worktrees', 'iso-agent-tool-1');
const terminal = { childId: 'child-0', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: 'capped' };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function capped(): SubagentResult {
  return {
    id: 'child-1', status: 'succeeded',
    message: { role: 'assistant', content: 'partial', timestamp: new Date() },
    incomplete: true, incompleteReason: 'tool_use_loop_capped', roundsUsed: 5,
  } as unknown as SubagentResult;
}

interface LinkHandle {
  id: string;
  runToResult: (prompt: never) => Promise<SubagentResult>;
  runInBackground: (prompt: never, cb?: (r: SubagentResult) => void) => void;
  teardown: () => Promise<void>;
}

/** An admitted link 2 on a chain whose worktree is kept, with a controllable nested manager. */
function admittedLink(maxContinuations: number, events: string[]) {
  const registry = new ContinuationRegistry({ maxRounds: 150, maxContinuations });
  const onEvict = vi.fn((chain: ChainRecord) => {
    if (chain.isolatedWorktreePath === undefined) return;
    const repoRoot = repoRootFromWorktreePath(chain.isolatedWorktreePath);
    if (repoRoot === undefined) return;
    void releaseChainWorktree({ repoRoot, worktreePath: chain.isolatedWorktreePath, chainId: chain.chainId, registry }).catch(() => undefined);
  });
  registry.onEvict = onEvict;
  const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false, isolation: 'worktree' } });
  registry.recordTerminal(chain.chainId, terminal);
  registry.setIsolatedWorktreePath(chain.chainId, TREE);
  const admission = registry.admitContinuation(chain.chainId, 'o', 5, 5);
  if (!admission.ok) throw new Error(admission.reason);
  const nested = deferred();
  const childManager = { teardownAll: vi.fn(async () => { events.push('nested-start'); await nested.promise; events.push('nested-done'); }) };
  const handle: LinkHandle = {
    id: 'child-1',
    runToResult: vi.fn(async () => capped()),
    runInBackground: vi.fn((_p: never, cb?: (r: SubagentResult) => void) => { cb?.(capped()); }),
    teardown: vi.fn(async () => { events.push('handle-teardown'); }),
  };
  instrumentHandleForChain(handle, {
    registry, chain, cwd: undefined, journalUsable: () => true, childManager,
    rollbackIfNotStarted: admission.rollback, alwaysLine: true,
  });
  return { registry, chain, handle, nested, childManager, onEvict };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const unlocks = () => execFileAsync.mock.calls.filter((c) => (c[1] as string[]).includes('unlock'));

beforeEach(() => {
  vi.clearAllMocks();
  execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
  teardownIsolatedWorktree.mockResolvedValue({ removed: true, preserved: false });
});

describe('kept worktree release waits for the link nested teardown', () => {
  it.each(['foreground', 'background'] as const)('link 2 exhaustion (%s): release waits until nested teardown resolves', async (mode) => {
    const events: string[] = [];
    execFileAsync.mockImplementation(async () => { events.push('unlock'); return { stdout: '', stderr: '' }; });
    const { chain, handle, nested } = admittedLink(1, events);
    if (mode === 'foreground') await handle.runToResult(undefined as never);
    else handle.runInBackground(undefined as never);
    await chain.settling;
    await flushMicrotasks();
    expect(chain.inFlight).toBe(false);
    expect(chain.isolatedWorktreePath).toBeUndefined();
    expect(unlocks()).toHaveLength(0);
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
    const teardown = handle.teardown();
    await flushMicrotasks();
    expect(unlocks()).toHaveLength(0);
    nested.resolve();
    await teardown;
    await vi.waitFor(() => expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1));
    expect(teardownIsolatedWorktree).toHaveBeenCalledWith({ repoRoot: REPO, worktreePath: TREE });
    expect(events).toEqual(['nested-start', 'nested-done', 'handle-teardown', 'unlock']);
  });

  it('dispose after link 2 settled with nested teardown pending: release deferred, then runs once', async () => {
    const events: string[] = [];
    const { registry, chain, handle, nested, onEvict } = admittedLink(3, events);
    await handle.runToResult(undefined as never);
    expect(chain.settling).toBeDefined();
    registry.dispose();
    expect(onEvict).toHaveBeenCalledTimes(1);
    await chain.settling;
    await flushMicrotasks();
    expect(unlocks()).toHaveLength(0);
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
    const teardown = handle.teardown();
    nested.resolve();
    await teardown;
    registry.dispose();
    await vi.waitFor(() => expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1));
    expect(unlocks()).toHaveLength(1);
    expect(onEvict).toHaveBeenCalledTimes(1);
  });

  it('eviction of a settled link with nested teardown pending waits for it', async () => {
    const events: string[] = [];
    const { registry, chain, handle, nested } = admittedLink(3, events);
    await handle.runToResult(undefined as never);
    await chain.settling;
    // Shrink the cap through a fresh insert: evictForInsert drops the settled chain.
    (registry as unknown as { maxChains: number }).maxChains = 1;
    registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false } });
    expect(registry.get(chain.chainId)).toBeUndefined();
    await flushMicrotasks();
    expect(unlocks()).toHaveLength(0);
    const teardown = handle.teardown();
    nested.resolve();
    await teardown;
    await vi.waitFor(() => expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1));
  });

  it('fast case: nested teardown already finished, dispose releases at once', async () => {
    const events: string[] = [];
    const { registry, handle, nested } = admittedLink(3, events);
    await handle.runToResult(undefined as never);
    nested.resolve();
    await handle.teardown();
    registry.dispose();
    await vi.waitFor(() => expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1));
    expect(unlocks()).toHaveLength(1);
    expect(events).toEqual(['nested-start', 'nested-done', 'handle-teardown']);
  });

  it('fast case: a chain with no tracked link teardown releases without waiting', async () => {
    const registry = new ContinuationRegistry();
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false, isolation: 'worktree' } });
    expect(registry.pendingLinkTeardown(chain.chainId)).toBeUndefined();
    await releaseChainWorktree({ repoRoot: REPO, worktreePath: TREE, chainId: chain.chainId, registry });
    expect(unlocks()).toHaveLength(1);
    expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1);
  });
});
