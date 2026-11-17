import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const teardownIsolatedWorktree = vi.hoisted(() => vi.fn().mockResolvedValue({ removed: false, preserved: true, reason: 'dirty' }));
vi.mock('../tools/handlers/worktree-managed.js', () => ({ teardownIsolatedWorktree }));
vi.mock('../../utils/exec-file.js', () => ({ execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }) }));

import { wireExecutors } from './wire-executors.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import type { SubagentExecutorContext } from '../tools/subagent-executor.js';

describe('root registry worktree release trace wiring (#4958)', () => {
  it.each(['dispose', 'eviction'] as const)('forwards the session trace to release on %s', async (mode) => {
    const traceWriter = new InMemoryTraceWriter();
    const { continuationRegistry: registry } = wireExecutors({
      surface: 'cli',
      parentSession: { sessionId: 'root', getInputStreamRef: () => undefined, abortSignal: new AbortController().signal } as unknown as SubagentExecutorContext['parentSession'],
      apiKey: 'test-key', resolveApiKeyForModel: () => 'test-key',
      model: 'sonnet', managerParentModel: 'sonnet', defaultSubagentModel: 'sonnet',
      cwd: tmpdir(), agentRegistryWarn: () => {}, traceWriter,
    });
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
});
