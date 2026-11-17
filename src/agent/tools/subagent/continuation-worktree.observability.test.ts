import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = vi.hoisted(() => vi.fn());
const teardownIsolatedWorktree = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/exec-file.js', () => ({ execFileAsync }));
vi.mock('../handlers/worktree-managed.js', () => ({ teardownIsolatedWorktree }));

import { ContinuationRegistry } from '../../subagent/continuation-registry.js';
import { SUBAGENT_DRAIN_TIMEOUT_MS } from '../../subagent/constants.js';
import { InMemoryTraceWriter } from '../../trace/writer.js';
import { buildIsolationTeardownHook, keepWorktreeForChain, releaseChainWorktree } from './continuation-worktree.js';
import { recordChainTerminal } from './continuation-dispatch.js';

function setup() {
  const registry = new ContinuationRegistry({ maxRounds: 150, maxContinuations: 0 });
  const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false, isolation: 'worktree' } });
  const traceWriter = new InMemoryTraceWriter();
  const repoRoot = join(tmpdir(), 'continuation-observability');
  const worktreePath = join(repoRoot, '.afk-worktrees', 'kept');
  return { registry, chain, traceWriter, args: { repoRoot, worktreePath, chainId: chain.chainId, registry, traceWriter } };
}

function rows(writer: InMemoryTraceWriter) {
  return writer.events.filter((e) => e.kind === 'session_phase' && e.payload.phase === 'continuation_worktree')
    .map((e) => e.payload as { metadata: Record<string, string | number | boolean> });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
  teardownIsolatedWorktree.mockResolvedValue({ removed: true, preserved: false });
});
afterEach(() => { vi.useRealTimers(); });

describe('kept continuation worktree deadlines and witness outcomes (#4958)', () => {
  it('releases an exhausted chain after the drain deadline even with an earlier hung link', async () => {
    const { registry, chain, traceWriter, args } = setup();
    registry.setIsolatedWorktreePath(chain.chainId, args.worktreePath);
    let finishEarlierLink!: () => void;
    registry.trackLinkTeardown(chain.chainId, new Promise<void>((resolve) => { finishEarlierLink = resolve; }));
    // A later, already-settled link must not defeat the release deadline.
    registry.trackLinkTeardown(chain.chainId, Promise.resolve());
    await recordChainTerminal({ registry, chain, traceWriter, cwd: undefined, childId: 'c', roundsUsed: 5, journalUsable: true, endReason: 'capped' });
    await vi.advanceTimersByTimeAsync(SUBAGENT_DRAIN_TIMEOUT_MS - 1);
    expect(execFileAsync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execFileAsync).toHaveBeenCalledWith('git', ['-C', args.repoRoot, 'worktree', 'unlock', args.worktreePath]);
    expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1);
    expect(rows(traceWriter).map((e) => e.metadata)).toEqual([
      { chainId: chain.chainId, worktreePath: args.worktreePath, operation: 'release_wait', outcome: 'timed_out', waitOutcome: 'timed_out', waitMs: SUBAGENT_DRAIN_TIMEOUT_MS },
      { chainId: chain.chainId, worktreePath: args.worktreePath, operation: 'release', outcome: 'removed', waitOutcome: 'timed_out', waitMs: SUBAGENT_DRAIN_TIMEOUT_MS },
    ]);
    expect(vi.getTimerCount()).toBe(0);
    finishEarlierLink();
    await vi.advanceTimersByTimeAsync(SUBAGENT_DRAIN_TIMEOUT_MS);
    expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1);
    expect(rows(traceWriter)).toHaveLength(2);
  });

  it('records elapsed wait and cancels the deadline when teardown settles early', async () => {
    const { registry, chain, traceWriter, args } = setup();
    let finish!: () => void;
    registry.trackLinkTeardown(chain.chainId, new Promise<void>((resolve) => { finish = resolve; }));
    const release = releaseChainWorktree(args);
    await vi.advanceTimersByTimeAsync(123);
    expect(teardownIsolatedWorktree).not.toHaveBeenCalled();
    finish();
    await release;
    expect(rows(traceWriter).at(-1)?.metadata).toMatchObject({ operation: 'release', outcome: 'removed', waitMs: 123, waitOutcome: 'settled' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SUBAGENT_DRAIN_TIMEOUT_MS);
    expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ removed: false, preserved: true, reason: 'dirty' }, 'preserved'],
    [{ removed: false, preserved: true, reason: 'commits-ahead' }, 'preserved'],
    [{ removed: false, preserved: false }, 'failed'],
  ] as const)('traces release result %j', async (result, outcome) => {
    const { traceWriter, args } = setup();
    teardownIsolatedWorktree.mockResolvedValue(result);
    await releaseChainWorktree(args);
    expect(rows(traceWriter).at(-1)?.metadata).toMatchObject({ operation: 'release', outcome, waitMs: 0, waitOutcome: 'not_needed', ...('reason' in result ? { reason: result.reason } : {}) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('emits timeout evidence before git teardown completes', async () => {
    const { registry, chain, traceWriter, args } = setup();
    registry.trackLinkTeardown(chain.chainId, new Promise<void>(() => {}));
    let unlock!: () => void;
    execFileAsync.mockImplementationOnce(() => new Promise<void>((resolve) => { unlock = resolve; }));
    const release = releaseChainWorktree(args);
    await vi.advanceTimersByTimeAsync(SUBAGENT_DRAIN_TIMEOUT_MS);
    expect(rows(traceWriter)).toHaveLength(1);
    expect(rows(traceWriter)[0]?.metadata).toMatchObject({ operation: 'release_wait', outcome: 'timed_out' });
    unlock();
    await release;
  });

  it('traces a kept tree through the foreground hook', async () => {
    const { registry, chain, traceWriter, args } = setup();
    const hook = buildIsolationTeardownHook(args, chain, registry, () => true, traceWriter)!;
    expect(await hook(args)).toBe(true);
    expect(rows(traceWriter).at(-1)?.metadata).toEqual({ chainId: chain.chainId, worktreePath: args.worktreePath, operation: 'keep', outcome: 'kept' });
  });

  it('traces failed locking without throwing or storing the path', async () => {
    const { chain, traceWriter, args } = setup();
    execFileAsync.mockRejectedValueOnce(new Error('lock failed'));
    expect(await keepWorktreeForChain(args)).toBe(false);
    expect(chain.isolatedWorktreePath).toBeUndefined();
    expect(rows(traceWriter).at(-1)?.metadata).toMatchObject({ operation: 'keep', outcome: 'lock_failed' });
  });

  it('traces a keep cancelled by disposal during the lock', async () => {
    const { registry, traceWriter, args } = setup();
    execFileAsync.mockImplementationOnce(async () => { registry.dispose(); });
    expect(await keepWorktreeForChain(args)).toBe(false);
    expect(rows(traceWriter).at(-1)?.metadata).toMatchObject({ operation: 'keep', outcome: 'cancelled' });
  });

  it('tracing failures never prevent keep or release', async () => {
    const { args } = setup();
    const traceWriter = { write: vi.fn().mockRejectedValue(new Error('trace unavailable')), getTracePath: () => 'in-memory://broken-trace' };
    expect(await keepWorktreeForChain({ ...args, traceWriter })).toBe(true);
    await expect(releaseChainWorktree({ ...args, traceWriter })).resolves.toBeUndefined();
    expect(teardownIsolatedWorktree).toHaveBeenCalledTimes(1);
  });
});
