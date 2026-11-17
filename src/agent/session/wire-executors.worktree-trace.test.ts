import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const teardownIsolatedWorktree = vi.hoisted(() => vi.fn().mockResolvedValue({ removed: false, preserved: true, reason: 'dirty' }));
vi.mock('../tools/handlers/worktree-managed.js', () => ({ teardownIsolatedWorktree }));
vi.mock('../../utils/exec-file.js', () => ({ execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }) }));

import { wireExecutors } from './wire-executors.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import { managerShutdownConfig } from './manager-shutdown-config.js';
import type { SubagentExecutorContext } from '../tools/subagent-executor.js';

function makeOpts(traceWriter: InMemoryTraceWriter): Parameters<typeof wireExecutors>[0] {
  return {
    surface: 'cli',
    parentSession: { sessionId: 'root', getInputStreamRef: () => undefined, abortSignal: new AbortController().signal } as unknown as SubagentExecutorContext['parentSession'],
    apiKey: 'test-key', resolveApiKeyForModel: () => 'test-key',
    model: 'sonnet', managerParentModel: 'sonnet', defaultSubagentModel: 'sonnet',
    cwd: tmpdir(), agentRegistryWarn: () => {}, traceWriter,
  };
}

describe('root registry worktree release trace wiring (#4958)', () => {
  it.each(['dispose', 'eviction'] as const)('forwards the session trace to release on %s', async (mode) => {
    const traceWriter = new InMemoryTraceWriter();
    const { continuationRegistry: registry } = wireExecutors(makeOpts(traceWriter));
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false, isolation: 'worktree' } });
    registry.recordTerminal(chain.chainId, { childId: 'c', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: 'capped' });
    const worktreePath = join(tmpdir(), 'trace-repo', '.afk-worktrees', 'kept');
    registry.setIsolatedWorktreePath(chain.chainId, worktreePath);
    if (mode === 'dispose') registry.dispose();
    else {
      for (let i = 0; i < 256; i++) {
        registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false } });
      }
    }
    await vi.waitFor(() => {
      expect(traceWriter.events).toContainEqual(expect.objectContaining({
        kind: 'session_phase',
        payload: { phase: 'continuation_worktree', metadata: { chainId: chain.chainId, worktreePath, operation: 'release', outcome: 'preserved', reason: 'dirty', waitOutcome: 'not_needed', waitMs: 0 } },
      }));
    });
    expect(teardownIsolatedWorktree).toHaveBeenCalledWith({ repoRoot: join(tmpdir(), 'trace-repo'), worktreePath });
  });

  it('B1 repro: release row lands even when traceWriter is sealed before the release async work completes', async () => {
    // Regression test for the fire-and-forget bug: dispose() fired releaseChainWorktree
    // as void; the session then sealed the trace writer; the release row arrived at a
    // sealed writer and was dropped. Fix: registerReleaseWrite() lets
    // managerShutdownConfig merge the promise into getPendingChildTerminalWrites so
    // seal()'s awaitPendingWritesBounded covers it.
    const traceWriter = new InMemoryTraceWriter();
    const { rootManager, continuationRegistry: registry, composeExecutor } = wireExecutors(makeOpts(traceWriter));
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false, isolation: 'worktree' } });
    registry.recordTerminal(chain.chainId, { childId: 'c', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: 'capped' });
    const worktreePath = join(tmpdir(), 'seal-race-repo', '.afk-worktrees', 'kept');
    registry.setIsolatedWorktreePath(chain.chainId, worktreePath);

    // Fire dispose (starts async release promise, registered in releaseWrites).
    registry.dispose();

    // Collect pending release writes (as seal() would) and seal immediately —
    // before the release async work resolves.
    const pendingReleaseWrites = registry.getPendingReleaseWrites();
    expect(pendingReleaseWrites.length).toBeGreaterThan(0);

    const shutdownCfg = managerShutdownConfig(rootManager, composeExecutor, undefined, registry);
    const pendingWrites = shutdownCfg.getPendingChildTerminalWrites();
    expect(pendingWrites.length).toBeGreaterThan(0);

    await traceWriter.seal(
      { status: 'succeeded', finalCostUsd: 0, finalTurnCount: 0, closedAt: new Date().toISOString() },
      pendingWrites,
    );

    // The release row must be present even though we sealed before it was written.
    expect(traceWriter.events).toContainEqual(expect.objectContaining({
      kind: 'session_phase',
      payload: expect.objectContaining({
        phase: 'continuation_worktree',
        metadata: expect.objectContaining({ chainId: chain.chainId, operation: 'release' }),
      }),
    }));
  });
});
