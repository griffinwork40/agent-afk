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

// Mock foreground-promotion so integration tests can drive teardown via the
// same path as production without a real model call (#4957).
const runForegroundWithPromotion = vi.hoisted(() => vi.fn());
vi.mock('./foreground-promotion.js', () => ({ runForegroundWithPromotion }));

import type { SubagentResult } from '../../subagent.js';
import { ContinuationRegistry } from '../../subagent/continuation-registry.js';
import { instrumentHandleForChain, markChainPromoted, wireDispatchChain } from './continuation-dispatch.js';
import { releaseChainWorktree } from './continuation-worktree.js';
import { buildContinuationRegistry } from '../../session/wire-executors.js';

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
  // Use the production factory so this test stays in sync with
  // wire-executors.ts without maintaining a hand-rolled onEvict copy (#4957).
  const registry = buildContinuationRegistry(undefined, { maxRounds: 150, maxContinuations });
  const realOnEvict = registry.onEvict!;
  const onEvict = vi.fn((chain: Parameters<typeof realOnEvict>[0]) => realOnEvict(chain));
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

/**
 * Integration: each run mode reaches the wrapped teardown that guards worktree
 * release (#4957). These tests wire via wireDispatchChain (the production path)
 * rather than instrumentHandleForChain directly, so a future change to the
 * wrapping logic is immediately caught.
 */
describe('run-mode integration: wrapped teardown is reached by each run mode', () => {
  /** Build a link handle + chain wired through wireDispatchChain. */
  function setupLink(events: string[]) {
    const registry = buildContinuationRegistry(undefined, { maxRounds: 150, maxContinuations: 1 });
    const ctx = { depth: 0, continuationRegistry: registry, parentSession: { sessionId: 'root-1' } };
    const nested = deferred();
    const childManager = {
      teardownAll: vi.fn(async () => {
        events.push('nested-start');
        await nested.promise;
        events.push('nested-done');
      }),
    };
    const handle = {
      id: 'child-1',
      runToResult: vi.fn(async () => capped()),
      runInBackground: vi.fn((_p: unknown, cb?: (r: SubagentResult) => void) => { cb?.(capped()); }),
      teardown: vi.fn(async () => { events.push('handle-teardown'); }),
      session: { messageJournal: { length: 0, flush: vi.fn().mockResolvedValue(undefined) } },
    };
    const chain = wireDispatchChain({
      ctx, parsed: { prompt: 'go', isolation: 'worktree' } as never,
      handle, childConfig: { cwd: TREE }, currentCwd: TREE,
      writeCapable: true, isolated: true, childManager,
    })!;
    registry.setIsolatedWorktreePath(chain.chainId, TREE);
    return { registry, chain, handle, nested };
  }

  beforeEach(() => {
    runForegroundWithPromotion.mockImplementation(
      async (a: { handle: { runToResult: (p: never) => Promise<SubagentResult>; teardown: () => Promise<void> }; prompt: string }) => {
        try {
          await a.handle.runToResult(a.prompt as never);
          return { content: 'done', isError: false };
        } finally {
          await a.handle.teardown();
        }
      },
    );
  });

  it('foreground (runForegroundWithPromotion): release waits for nested teardown', async () => {
    const events: string[] = [];
    execFileAsync.mockImplementation(async () => { events.push('unlock'); return { stdout: '', stderr: '' }; });
    const { registry, chain, handle, nested } = setupLink(events);
    // Drive via runForegroundWithPromotion, which calls handle.teardown() in its finally block.
    const fgDone = runForegroundWithPromotion({ handle, prompt: 'go' } as never);
    await chain.settling;
    await flushMicrotasks();
    // Dispose signals worktree release; teardown is still pending inside runForegroundWithPromotion.
    registry.dispose();
    expect(unlocks()).toHaveLength(0);
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
    nested.resolve();
    await fgDone;
    await vi.waitFor(() => expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['nested-start', 'nested-done', 'handle-teardown', 'unlock']);
  });

  it('promoted (markChainPromoted + background delivery): release waits for nested teardown', async () => {
    const events: string[] = [];
    execFileAsync.mockImplementation(async () => { events.push('unlock'); return { stdout: '', stderr: '' }; });
    const { registry, chain, handle, nested } = setupLink(events);
    markChainPromoted(handle);
    // Promoted: background callback delivers the result, teardown fires externally.
    handle.runInBackground(undefined as never);
    await chain.settling;
    await flushMicrotasks();
    registry.dispose();
    expect(unlocks()).toHaveLength(0);
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
    nested.resolve();
    await handle.teardown();
    await vi.waitFor(() => expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1));
    expect(events).toContain('nested-done');
    expect(events).toContain('handle-teardown');
    expect(events.indexOf('nested-done')).toBeLessThan(events.indexOf('handle-teardown'));
  });

  it('background (runInBackground): release waits for nested teardown', async () => {
    const events: string[] = [];
    execFileAsync.mockImplementation(async () => { events.push('unlock'); return { stdout: '', stderr: '' }; });
    const { registry, chain, handle, nested } = setupLink(events);
    handle.runInBackground(undefined as never);
    await chain.settling;
    await flushMicrotasks();
    registry.dispose();
    expect(unlocks()).toHaveLength(0);
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
    nested.resolve();
    await handle.teardown();
    await vi.waitFor(() => expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['nested-start', 'nested-done', 'handle-teardown', 'unlock']);
  });
});
