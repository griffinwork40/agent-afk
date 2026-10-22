/**
 * Continuation admission reservation (docs/subagent-continuation.md, D4/D5):
 * the reservation is taken synchronously before any await, so a concurrent
 * loser is refused at once and never runs checkpoint git.
 */
import { describe, expect, it, vi } from 'vitest';

const gitCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  return {
    ...real,
    execFile: ((...a: Parameters<typeof real.execFile>) => { if (a[0] === 'git') gitCalls.n++; return (real.execFile as (...x: unknown[]) => unknown)(...a); }) as typeof real.execFile,
  };
});

import { ContinuationRegistry } from '../../subagent/continuation-registry.js';
import { parseAgentInput } from './input-parse.js';
import { admitContinuationCall, SETTLING_WAIT_MS } from './continuation-run.js';
import { CHECKPOINT_CAPTURE_DEADLINE_MS, CHECKPOINT_UNAVAILABLE_REASON } from '../../subagent/continuation-guards.js';

function settlingChain() {
  const registry = new ContinuationRegistry();
  const chain = registry.createChain({ owner: registry.rootActor, rootSessionId: 'root', roundCap: 5, inputs: { writeCapable: true } });
  let settle!: () => void;
  const settling = new Promise<void>((res) => { settle = res; }).then(() => {
    registry.recordTerminal(chain.chainId, { childId: 'child-1', journalUsable: true, roundsUsed: 5, checkpoint: { cwd: '/nonexistent-afk-repo', git: true, branch: 'main', head: 'abc', dirtyFingerprint: 'x' }, endReason: 'tool_use_loop_capped' });
  });
  registry.setSettling(chain.chainId, settling);
  const ctx = { depth: 0, continuationRegistry: registry, parentSession: { sessionId: 'root' } };
  return { registry, chain, ctx, settle };
}

const input = (id: string) => parseAgentInput({ prompt: 'go', continuation_chain_id: id });

describe('continuation admission reservation', () => {
  it('a concurrent loser is refused immediately and does no git I/O', async () => {
    const { chain, ctx, settle } = settlingChain();
    gitCalls.n = 0;
    const winner = admitContinuationCall(input(chain.chainId), ctx); // holds the reservation, awaiting settling
    const loser = await admitContinuationCall(input(chain.chainId), ctx);
    expect('error' in loser && loser.error.content).toMatch(/still in flight \(another continuation is already being admitted\)/);
    expect(gitCalls.n).toBe(0);
    settle();
    const w = await winner;
    // The winner ran the drift recapture (git) after settling; the fake cwd fails it closed.
    expect('error' in w && w.error.content).toMatch(/workspace (drifted|checkpoint unavailable)/);
    expect(gitCalls.n).toBeGreaterThan(0);
    expect(chain.admitting).toBe(false); // reservation released
    expect(chain.inFlight).toBe(false);
  });

  it('refuses with a retry reason when bookkeeping is still not settled after the bound', async () => {
    vi.useFakeTimers();
    try {
      const { chain, ctx } = settlingChain();
      const pending = admitContinuationCall(input(chain.chainId), ctx);
      await vi.advanceTimersByTimeAsync(SETTLING_WAIT_MS + 1);
      const r = await pending;
      expect('error' in r && r.error.content).toMatch(/still finishing its bookkeeping.*retry/);
      expect(chain.admitting).toBe(false);
      expect(chain.continuations).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a drift recapture that never resolves (hung git) refuses as unavailable and releases the reservation', async () => {
    vi.useFakeTimers();
    try {
      const registry = new ContinuationRegistry();
      const chain = registry.createChain({ owner: registry.rootActor, rootSessionId: 'root', roundCap: 5, inputs: { writeCapable: true } });
      registry.recordTerminal(chain.chainId, { childId: 'child-1', journalUsable: true, roundsUsed: 5, checkpoint: { cwd: '/repo', git: true, branch: 'main', head: 'abc', dirtyFingerprint: 'x' }, endReason: 'tool_use_loop_capped' });
      const recaptureCheckpoint = vi.fn(() => new Promise<never>(() => {}));
      const ctx = { depth: 0, continuationRegistry: registry, parentSession: { sessionId: 'root' }, recaptureCheckpoint };
      const pending = admitContinuationCall(input(chain.chainId), ctx);
      await vi.advanceTimersByTimeAsync(0);
      expect(chain.admitting).toBe(true); // reservation held while the recapture hangs
      await vi.advanceTimersByTimeAsync(CHECKPOINT_CAPTURE_DEADLINE_MS + 1);
      const r = await pending;
      expect(recaptureCheckpoint).toHaveBeenCalledWith('/repo');
      expect('error' in r && r.error.content).toContain(CHECKPOINT_UNAVAILABLE_REASON);
      expect(chain.admitting).toBe(false);
      expect(chain.inFlight).toBe(false);
      expect(chain.continuations).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
