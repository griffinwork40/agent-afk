/**
 * Tests for performResumeSwap — the 12-step mid-session swap sequence.
 *
 * All tests drive the real exported function via stub deps (vi.fn()), rather
 * than replicating the body inline. This means a change to the swap sequence
 * in resume-swap.ts is immediately visible here without manual harness sync.
 *
 * Covered:
 *   1. In-flight refusal — returns { ok: false } when isInFlight() is true
 *   2. Happy-path stats reseed from StoredSession
 *   3. SessionRef pointer flip — session.current is the new session
 *   4. Background jobs cancelled before session close
 *   5. Old session closed on successful swap
 *   6. ContextSampler.attach called with new session (only after successful init)
 *   7. No stored data — stats reset to zero
 *   8. buildSession throws → sessionRef unchanged + old session NOT closed + { ok: false }
 *   9. stats.turnCosts/turnTokens cleared on successful swap
 *  10. slashCtx.requestResume wiring: bootstrapSession wires requestResume into slashCtx
 *  11. waitForInitialization rejects → old session stays current, new session closed,
 *      no sampler bind, { ok: false } returned
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { performResumeSwap, type ResumeSwapDeps } from './resume-swap.js';
import { ContextSampler } from '../../context-sampler.js';
import type { ResolvedResumeTarget } from '../../resume-session.js';
import type { SessionRef } from '../../../agent/session-ref.js';
import type { SessionStats } from '../../slash/types.js';
import type { ResumeSwapResult } from './shared.js';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    planMode: false,
    ...overrides,
  };
}

function makeFakeSession(id = 'old-session') {
  return {
    sessionId: id,
    close: vi.fn().mockResolvedValue(undefined),
    waitForInitialization: vi.fn().mockResolvedValue({}),
    getContextUsage: vi.fn().mockResolvedValue({ isAutoCompactEnabled: false }),
    abortSignal: new AbortController().signal,
    getInputStreamRef: vi.fn().mockReturnValue({ pushUserMessage: () => {} }),
    interrupt: vi.fn().mockResolvedValue(undefined),
  };
}

function makeStoredSession(overrides: Partial<import('../../session-store.js').StoredSession> = {}): import('../../session-store.js').StoredSession {
  return {
    model: 'haiku',
    totalTurns: 10,
    totalCostUsd: 2.5,
    totalTokens: 50000,
    totalDurationMs: 120000,
    turns: [],
    sessionId: 'stored-sdk-id',
    savedAt: Date.now(),
    ...overrides,
  };
}

function makeTarget(id = 'abc123', stored?: ReturnType<typeof makeStoredSession>): ResolvedResumeTarget {
  return {
    id,
    resumeId: stored?.sessionId ?? id,
    stored,
  };
}

// ---------------------------------------------------------------------------
// Harness builder: returns real deps with stubs injected
// ---------------------------------------------------------------------------

function buildDeps(options: {
  inFlight?: boolean;
  initialSessionId?: string;
} = {}): {
  deps: ResumeSwapDeps;
  sessionRef: SessionRef;
  stats: SessionStats;
  onSwappedSpy: ReturnType<typeof vi.fn>;
  buildSessionSpy: ReturnType<typeof vi.fn>;
  repaintSpy: ReturnType<typeof vi.fn>;
  completionLines: string[];
  cancelAllSpy: ReturnType<typeof vi.fn>;
} {
  const oldSession = makeFakeSession(options.initialSessionId ?? 'old-session');
  const newSession = makeFakeSession('new-session-id');

  const sessionRef: SessionRef = {
    current: oldSession as unknown as import('../../../agent/session.js').AgentSession,
  };
  const stats = makeStats({ model: 'sonnet', totalTurns: 5, totalCostUsd: 1.5 });

  const cancelAllSpy = vi.fn().mockResolvedValue(undefined);
  const backgroundRegistry = { cancelAll: cancelAllSpy } as unknown as import('../../../agent/background-registry.js').BackgroundAgentRegistry;

  const repaintSpy = vi.fn();
  const statusLine = { repaint: repaintSpy } as unknown as import('../../status-line.js').StatusLine;

  const completionLines: string[] = [];
  const completionWriter = { fn: (line: string) => { completionLines.push(line); } };

  // Real ContextSampler so attach() actually runs — it mutates `source` and
  // calls reset() (clearing cached ratio/detail), so exercising the real method
  // confirms the call happens correctly and without error.
  const contextSampler = new ContextSampler(
    oldSession as unknown as import('../../../agent/session.js').AgentSession,
  );
  vi.spyOn(contextSampler, 'attach');

  const onSwappedSpy = vi.fn();
  const buildSessionSpy = vi.fn().mockReturnValue(
    newSession as unknown as import('../../../agent/session.js').AgentSession,
  );

  const deps: ResumeSwapDeps = {
    sessionRef,
    stats,
    contextSampler,
    statusLine,
    backgroundRegistry,
    completionWriter,
    isInFlight: () => options.inFlight ?? false,
    onSwapped: onSwappedSpy,
    buildSession: buildSessionSpy,
  };

  return { deps, sessionRef, stats, onSwappedSpy, buildSessionSpy, repaintSpy, completionLines, cancelAllSpy };
}

// ---------------------------------------------------------------------------
// Tests — in-flight refusal
// ---------------------------------------------------------------------------

describe('performResumeSwap — in-flight refusal', () => {
  it('returns ok: false when a turn is in flight', async () => {
    const { deps } = buildDeps({ inFlight: true });
    const result = await performResumeSwap(makeTarget('xyz'), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/turn is in flight/i);
    }
  });

  it('does not close the session when refused', async () => {
    const { deps, sessionRef } = buildDeps({ inFlight: true });
    const closeSpy = vi.spyOn(
      sessionRef.current as unknown as { close: () => Promise<void> },
      'close',
    );
    await performResumeSwap(makeTarget('xyz'), deps);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('does not cancel background jobs when refused', async () => {
    const { deps, cancelAllSpy } = buildDeps({ inFlight: true });
    await performResumeSwap(makeTarget('xyz'), deps);
    expect(cancelAllSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — happy path with stored session
// ---------------------------------------------------------------------------

describe('performResumeSwap — happy path with stored session', () => {
  let deps: ResumeSwapDeps;
  let stats: SessionStats;
  let stored: ReturnType<typeof makeStoredSession>;
  let target: ResolvedResumeTarget;
  let result: ResumeSwapResult;

  beforeEach(async () => {
    stored = makeStoredSession({
      model: 'haiku',
      totalTurns: 7,
      totalCostUsd: 3.0,
      totalTokens: 30000,
      totalDurationMs: 90000,
      sessionId: 'stored-sdk-id',
    });
    target = makeTarget('session-42', stored);
    ({ deps, stats } = buildDeps({ inFlight: false }));
    result = await performResumeSwap(target, deps);
  });

  it('returns ok: true', () => {
    expect(result.ok).toBe(true);
  });

  it('reseeds totalTurns from stored session', () => {
    expect(stats.totalTurns).toBe(7);
  });

  it('reseeds totalCostUsd from stored session', () => {
    expect(stats.totalCostUsd).toBe(3.0);
  });

  it('reseeds totalTokens from stored session', () => {
    expect(stats.totalTokens).toBe(30000);
  });

  it('reseeds sessionId from stored.sessionId', () => {
    expect(stats.sessionId).toBe('stored-sdk-id');
  });

  it('reseeds model from stored session', () => {
    expect(stats.model).toBe('haiku');
  });
});

// ---------------------------------------------------------------------------
// Tests — pointer flip
// ---------------------------------------------------------------------------

describe('performResumeSwap — pointer flip', () => {
  it('mutates sessionRef.current to the new session', async () => {
    const { deps, sessionRef } = buildDeps();
    const oldSession = sessionRef.current;
    await performResumeSwap(makeTarget('t1', makeStoredSession()), deps);
    expect(sessionRef.current).not.toBe(oldSession);
  });

  it('new session has different sessionId than old', async () => {
    const { deps, sessionRef } = buildDeps({ initialSessionId: 'old-id' });
    await performResumeSwap(makeTarget('t2', makeStoredSession()), deps);
    expect(
      (sessionRef.current as unknown as { sessionId: string }).sessionId,
    ).toBe('new-session-id');
  });
});

// ---------------------------------------------------------------------------
// Tests — cancellation order
// ---------------------------------------------------------------------------

describe('performResumeSwap — background registry cancelled before close', () => {
  it('calls cancelAll before session close', async () => {
    const { deps, sessionRef, cancelAllSpy } = buildDeps();
    const callOrder: string[] = [];
    cancelAllSpy.mockImplementation(async () => { callOrder.push('cancelAll'); });
    vi.spyOn(
      sessionRef.current as unknown as { close: () => Promise<void> },
      'close',
    ).mockImplementation(async () => { callOrder.push('close'); });
    await performResumeSwap(makeTarget('t3', makeStoredSession()), deps);
    expect(callOrder[0]).toBe('cancelAll');
    expect(callOrder[1]).toBe('close');
  });
});

// ---------------------------------------------------------------------------
// Tests — old session closed
// ---------------------------------------------------------------------------

describe('performResumeSwap — old session closed', () => {
  it('calls close() on the outgoing session', async () => {
    const { deps, sessionRef } = buildDeps();
    const closeSpy = vi.spyOn(
      sessionRef.current as unknown as { close: () => Promise<void> },
      'close',
    );
    await performResumeSwap(makeTarget('t4', makeStoredSession()), deps);
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Tests — ContextSampler.attach called
// ---------------------------------------------------------------------------

describe('performResumeSwap — ContextSampler rebind', () => {
  it('calls contextSampler.attach with the new session', async () => {
    const { deps } = buildDeps();
    const target = makeTarget('t5', makeStoredSession());
    await performResumeSwap(target, deps);
    expect(deps.contextSampler.attach).toHaveBeenCalledOnce();
    const attached = (deps.contextSampler.attach as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { sessionId: string };
    expect(attached?.sessionId).toBe('new-session-id');
  });
});

// ---------------------------------------------------------------------------
// Tests — no stored data
// ---------------------------------------------------------------------------

describe('performResumeSwap — no stored data', () => {
  it('resets stats to zero when no stored session', async () => {
    const { deps, stats } = buildDeps();
    stats.totalTurns = 5;
    stats.totalCostUsd = 9.99;
    await performResumeSwap(makeTarget('bare-id'), deps);
    expect(stats.totalTurns).toBe(0);
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.sessionId).toBe('bare-id');
  });
});

// ---------------------------------------------------------------------------
// Tests — buildSession throws → safe early-return before pointer flip (H1 fix)
// ---------------------------------------------------------------------------

describe('performResumeSwap — buildSession throws', () => {
  it('returns { ok: false } containing the error message when buildSession throws', async () => {
    const { deps } = buildDeps();
    deps.buildSession = vi.fn().mockImplementation(() => {
      throw new Error('constructor kaboom');
    });
    const result = await performResumeSwap(makeTarget('fail-target', makeStoredSession()), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/buildSession failed/i);
      expect(result.reason).toMatch(/constructor kaboom/i);
    }
  });

  it('leaves sessionRef.current pointing at the original session when buildSession throws', async () => {
    const { deps, sessionRef } = buildDeps();
    const originalSession = sessionRef.current;
    deps.buildSession = vi.fn().mockImplementation(() => {
      throw new Error('constructor kaboom');
    });
    await performResumeSwap(makeTarget('fail-target', makeStoredSession()), deps);
    // The pointer flip must NOT have occurred — old session is still alive.
    expect(sessionRef.current).toBe(originalSession);
  });

  it('does NOT close the old session when buildSession throws (H1)', async () => {
    // Invariant: build new session before closing old. If buildSession throws,
    // the old session must remain open — sessionRef.current must point at a
    // live session, not a closed one.
    const { deps, sessionRef } = buildDeps();
    const closeSpy = vi.spyOn(
      sessionRef.current as unknown as { close: () => Promise<void> },
      'close',
    );
    deps.buildSession = vi.fn().mockImplementation(() => {
      throw new Error('constructor kaboom');
    });
    await performResumeSwap(makeTarget('fail-target', makeStoredSession()), deps);
    expect(closeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — turnCosts/turnTokens cleared on successful swap (M-3b)
// ---------------------------------------------------------------------------

describe('performResumeSwap — turnCosts/turnTokens cleared', () => {
  it('clears turnCosts and turnTokens on successful swap with stored session', async () => {
    const { deps, stats } = buildDeps();
    stats.turnCosts = [1.0, 0.5];
    stats.turnTokens = [
      { input: 100, output: 50, cache: 0 },
      { input: 200, output: 80, cache: 10 },
    ];
    await performResumeSwap(makeTarget('t-stored', makeStoredSession()), deps);
    expect(stats.turnCosts).toEqual([]);
    expect(stats.turnTokens).toEqual([]);
  });

  it('clears turnCosts and turnTokens on successful swap with no stored session', async () => {
    const { deps, stats } = buildDeps();
    stats.turnCosts = [2.5];
    stats.turnTokens = [{ input: 300, output: 120, cache: 5 }];
    await performResumeSwap(makeTarget('bare-id'), deps);
    expect(stats.turnCosts).toEqual([]);
    expect(stats.turnTokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — slashCtx.requestResume wiring (M-3c)
// Smoke-test: bootstrapSession wires requestResume into slashCtx.
// We verify this at the module level — importing bootstrap confirms the
// wiring code loads, and checking that buildAgentSession is exported confirms
// the dep used inside the requestResume closure is resolvable.
// ---------------------------------------------------------------------------

describe('slashCtx.requestResume wiring — bootstrap.ts smoke test', () => {
  it('bootstrap exports buildAgentSession (the function used in requestResume closure)', async () => {
    const mod = await import('./bootstrap.js');
    expect(typeof mod.buildAgentSession).toBe('function');
  });

  it('performResumeSwap is exported from resume-swap.ts (the function called by requestResume)', async () => {
    const mod = await import('./resume-swap.js');
    expect(typeof mod.performResumeSwap).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Tests — waitForInitialization rejection (H2 fix)
// Invariant: pointer flip and sampler bind must not happen until init succeeds.
// On rejection: old session stays current and open; new session is closed.
// ---------------------------------------------------------------------------

describe('performResumeSwap — waitForInitialization rejection', () => {
  it('returns { ok: false } when waitForInitialization rejects', async () => {
    const { deps } = buildDeps();
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(new Error('init exploded'));
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    const result = await performResumeSwap(makeTarget('t-init-fail', makeStoredSession()), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/initialization failed/i);
      expect(result.reason).toMatch(/init exploded/i);
    }
  });

  it('emits a warning via completionWriter when waitForInitialization rejects', async () => {
    const { deps, completionLines } = buildDeps();
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(new Error('init exploded'));
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    await performResumeSwap(makeTarget('t-init-fail', makeStoredSession()), deps);
    expect(completionLines.some((l) => /initialization failed/i.test(l))).toBe(true);
  });

  it('does NOT emit the "Resuming…" success banner when waitForInitialization rejects', async () => {
    const { deps, completionLines } = buildDeps();
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(new Error('init exploded'));
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    await performResumeSwap(makeTarget('t-init-fail', makeStoredSession()), deps);
    expect(completionLines.some((l) => /↪ Resumed/i.test(l))).toBe(false);
  });

  it('leaves sessionRef.current pointing at the old session when waitForInitialization rejects (H2)', async () => {
    // Invariant: pointer flip must not occur before successful init.
    const { deps, sessionRef } = buildDeps();
    const originalSession = sessionRef.current;
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(new Error('init exploded'));
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    await performResumeSwap(makeTarget('t-init-fail', makeStoredSession()), deps);
    expect(sessionRef.current).toBe(originalSession);
  });

  it('closes the new (failed) session when waitForInitialization rejects (H2)', async () => {
    // The new session failed to init — its resources must be released.
    const { deps } = buildDeps();
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(new Error('init exploded'));
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    await performResumeSwap(makeTarget('t-init-fail', makeStoredSession()), deps);
    expect(newSession.close).toHaveBeenCalledOnce();
  });

  it('does NOT call contextSampler.attach when waitForInitialization rejects (H2)', async () => {
    // Sampler bind must be gated on successful init — attaching to a degraded
    // session would produce stale or invalid context samples.
    const { deps } = buildDeps();
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(new Error('init exploded'));
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    await performResumeSwap(makeTarget('t-init-fail', makeStoredSession()), deps);
    expect(deps.contextSampler.attach).not.toHaveBeenCalled();
  });

  it('does NOT close the old session when waitForInitialization rejects (H2)', async () => {
    // Old session must stay live so the user can keep working in it.
    const { deps, sessionRef } = buildDeps();
    const oldCloseSpy = vi.spyOn(
      sessionRef.current as unknown as { close: () => Promise<void> },
      'close',
    );
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(new Error('init exploded'));
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    await performResumeSwap(makeTarget('t-init-fail', makeStoredSession()), deps);
    expect(oldCloseSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — stats.planMode reset on swap (LOW-12b)
// ---------------------------------------------------------------------------

describe('performResumeSwap — stats.planMode and pendingPlanExit reset', () => {
  it('resets stats.planMode to false on successful swap with stored session', async () => {
    const { deps, stats } = buildDeps();
    stats.planMode = true;
    await performResumeSwap(makeTarget('t-plan', makeStoredSession()), deps);
    expect(stats.planMode).toBe(false);
  });

  it('resets stats.planMode to false on successful swap with no stored session', async () => {
    const { deps, stats } = buildDeps();
    stats.planMode = true;
    await performResumeSwap(makeTarget('bare-id'), deps);
    expect(stats.planMode).toBe(false);
  });

  it('clears pendingPlanExit on successful swap', async () => {
    const { deps, stats } = buildDeps();
    stats.pendingPlanExit = true;
    await performResumeSwap(makeTarget('t-plan', makeStoredSession()), deps);
    expect(stats.pendingPlanExit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — sessionRef unchanged detection on buildSession throw (LOW-11 improvement)
// ---------------------------------------------------------------------------

describe('performResumeSwap — buildSession throw: dead-session pointer prevention', () => {
  it('sessionRef.current identity is exactly the original session after buildSession throws', async () => {
    const { deps, sessionRef } = buildDeps({ initialSessionId: 'original-id' });
    const originalRef = sessionRef.current;
    // Verify identity — not just string equality — to catch any proxy/wrap
    expect(originalRef).toBeTruthy();
    deps.buildSession = vi.fn().mockImplementation(() => {
      throw new Error('constructor boom');
    });
    await performResumeSwap(makeTarget('fail-target', makeStoredSession()), deps);
    // sessionRef.current must be the exact same object reference
    expect(sessionRef.current).toBe(originalRef);
    // And it must have the original session's id (not a new one)
    expect(
      (sessionRef.current as unknown as { sessionId: string }).sessionId,
    ).toBe('original-id');
  });
});

// ---------------------------------------------------------------------------
// Tests — reseedStatsFromStored export wiring (LOW-13 improvement on smoke tests)
// ---------------------------------------------------------------------------

describe('reseedStatsFromStored wiring — shared helper', () => {
  it('reseedStatsFromStored is exported from shared.ts', async () => {
    const mod = await import('./shared.js');
    expect(typeof mod.reseedStatsFromStored).toBe('function');
  });

  it('reseedStatsFromStored correctly hydrates stats from a stored session', async () => {
    const { default: _unused, ...shared } = await import('./shared.js') as Record<string, unknown>;
    const reseed = (shared as { reseedStatsFromStored: typeof import('./shared.js').reseedStatsFromStored }).reseedStatsFromStored;
    const stats = {
      totalTurns: 0, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0,
      sessionStartTime: 0, turnCosts: [], turnTokens: [], turns: [],
      model: 'sonnet' as const, planMode: false,
    } as import('../../slash/types.js').SessionStats;
    const stored: import('../../session-store.js').StoredSession = {
      model: 'opus', totalTurns: 5, totalCostUsd: 1.5, totalTokens: 30000,
      totalDurationMs: 60000, turns: [], sessionId: 'sdk-xyz', startedAt: 12345, savedAt: 12346,
    };
    reseed(stats, stored, 'fallback-id');
    expect(stats.totalTurns).toBe(5);
    expect(stats.model).toBe('opus');
    expect(stats.sessionId).toBe('sdk-xyz');
    expect(stats.sessionStartTime).toBe(12345);
  });
});

// ---------------------------------------------------------------------------
// Tests — credential redaction in failure reasons (PR #355 H-1/H-2 follow-up)
// External constraint: the `reason` string is printed verbatim to the
// terminal by src/cli/slash/commands/resume.ts (via ctx.out.warn) AND is
// what `performResumeSwap` returns to its caller. Any credential-shaped
// substring (Bearer tokens, sk-ant-* keys, Authorization headers) must be
// scrubbed before it leaves this function — at both the buildSession-throw
// path and the waitForInitialization-reject path.
// ---------------------------------------------------------------------------

describe('performResumeSwap — credential redaction in error reasons', () => {
  it('redacts sk-ant-* keys in buildSession failure reason (H-1)', async () => {
    const { deps } = buildDeps();
    deps.buildSession = vi.fn().mockImplementation(() => {
      throw new Error('401: invalid key sk-ant-api03-DEADBEEFCAFEBABE1234567890abcdef');
    });
    const result = await performResumeSwap(makeTarget('t', makeStoredSession()), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('sk-ant-[REDACTED]');
      expect(result.reason).not.toMatch(/sk-ant-api03-[A-Z]/);
    }
  });

  it('redacts Bearer tokens in buildSession failure reason (H-1)', async () => {
    const { deps } = buildDeps();
    // Use a non-sk-ant Bearer payload so the Bearer regex (not the sk-ant
    // regex) is what fires; verifies the Bearer rule is wired.
    deps.buildSession = vi.fn().mockImplementation(() => {
      throw new Error('Got 401 from header Bearer abcdef0123456789TOKEN');
    });
    const result = await performResumeSwap(makeTarget('t', makeStoredSession()), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Bearer [REDACTED]');
      expect(result.reason).not.toMatch(/Bearer\s+abcdef0123/);
    }
  });

  it('redacts sk-ant-* keys in initialization failure reason (H-2)', async () => {
    const { deps, completionLines } = buildDeps();
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(
      new Error('SDK init: 401 with key sk-ant-api03-LEAKEDLEAKEDLEAKED1234567890'),
    );
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    const result = await performResumeSwap(makeTarget('t', makeStoredSession()), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('sk-ant-[REDACTED]');
      expect(result.reason).not.toMatch(/sk-ant-api03-[A-Z]/);
    }
    // Same redaction must apply to the warning printed to the terminal.
    const warningLine = completionLines.find((l) => /initialization failed/i.test(l));
    expect(warningLine).toBeDefined();
    expect(warningLine).not.toMatch(/sk-ant-api03-[A-Z]/);
  });

  it('redacts Authorization headers in initialization failure reason (H-2)', async () => {
    const { deps, completionLines } = buildDeps();
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(
      new Error('init: server replied 403, Authorization: sk-secret-xyz123'),
    );
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    const result = await performResumeSwap(makeTarget('t', makeStoredSession()), deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('Authorization: [REDACTED]');
      expect(result.reason).not.toMatch(/Authorization:\s+sk-secret/);
    }
    const warningLine = completionLines.find((l) => /initialization failed/i.test(l));
    expect(warningLine).not.toMatch(/Authorization:\s+sk-secret/);
  });
});

// ---------------------------------------------------------------------------
// Tests — startedAt fallback for legacy stored sessions (PR #355 L-6 follow-up)
// External constraint: StoredSession.startedAt is typed `number` but older
// session files on disk lack the field; they deserialize with `undefined`.
// reseedStatsFromStored must fall back so sessionStartTime is always a
// valid timestamp (status-line duration must not be NaN).
// ---------------------------------------------------------------------------

describe('reseedStatsFromStored — startedAt fallback', () => {
  it('falls back to Date.now() when stored.startedAt is undefined (legacy file)', async () => {
    const { reseedStatsFromStored } = await import('./shared.js');
    const stats = makeStats({ sessionStartTime: 0 });
    // Construct a "legacy" stored payload — bypass the type by casting,
    // since the type says `startedAt: number` but real disk data may lack it.
    const legacyStored = {
      model: 'sonnet',
      totalTurns: 1,
      totalCostUsd: 0.1,
      totalTokens: 100,
      totalDurationMs: 1000,
      turns: [],
      sessionId: 'legacy-sdk',
      savedAt: 99999,
      // NOTE: no startedAt field
    } as unknown as import('../../session-store.js').StoredSession;
    const before = Date.now();
    reseedStatsFromStored(stats, legacyStored, 'fallback-id');
    const after = Date.now();
    expect(stats.sessionStartTime).toBeGreaterThanOrEqual(before);
    expect(stats.sessionStartTime).toBeLessThanOrEqual(after);
    expect(Number.isNaN(stats.sessionStartTime)).toBe(false);
  });

  it('preserves stored.startedAt when present', async () => {
    const { reseedStatsFromStored } = await import('./shared.js');
    const stats = makeStats({ sessionStartTime: 0 });
    const stored = makeStoredSession({ startedAt: 555555 });
    reseedStatsFromStored(stats, stored, 'id');
    expect(stats.sessionStartTime).toBe(555555);
  });
});

// ---------------------------------------------------------------------------
// Tests — onSwapped invocation (PR #355 L-7 follow-up wiring check)
// The verdictLedger clear is owned by repl-loop's closure and surfaced via
// ctx.clearVerdictLedger, which the resume-swap callsite invokes inside
// onSwapped. Here we just confirm onSwapped fires exactly once on success
// and does not fire on failure paths — the actual ledger clear is covered
// at the repl-loop integration level (verdict-card.test.ts touches the
// ledger, repl-loop owns the wiring).
// ---------------------------------------------------------------------------

describe('performResumeSwap — onSwapped invocation', () => {
  it('invokes onSwapped exactly once on successful swap', async () => {
    const { deps, onSwappedSpy } = buildDeps();
    await performResumeSwap(makeTarget('t', makeStoredSession()), deps);
    expect(onSwappedSpy).toHaveBeenCalledOnce();
  });

  it('does NOT invoke onSwapped when buildSession throws', async () => {
    const { deps, onSwappedSpy } = buildDeps();
    deps.buildSession = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    await performResumeSwap(makeTarget('t', makeStoredSession()), deps);
    expect(onSwappedSpy).not.toHaveBeenCalled();
  });

  it('does NOT invoke onSwapped when waitForInitialization rejects', async () => {
    const { deps, onSwappedSpy } = buildDeps();
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(new Error('init boom'));
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    await performResumeSwap(makeTarget('t', makeStoredSession()), deps);
    expect(onSwappedSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — C1: background jobs preserved on rollback (PR #355 follow-up)
// External constraint: cancelAll() is unrecoverable. If the swap rolls back
// (buildSession throws or waitForInitialization rejects), the outgoing
// session's background jobs MUST still be running — the user remains on the
// old session and any cancelled jobs would be silently lost.
// ---------------------------------------------------------------------------

describe('performResumeSwap — C1: background jobs preserved on rollback', () => {
  it('does NOT cancel background jobs when buildSession throws', async () => {
    const { deps, cancelAllSpy } = buildDeps();
    deps.buildSession = vi.fn().mockImplementation(() => {
      throw new Error('constructor kaboom');
    });
    await performResumeSwap(makeTarget('fail-target', makeStoredSession()), deps);
    expect(cancelAllSpy).not.toHaveBeenCalled();
  });

  it('does NOT cancel background jobs when waitForInitialization rejects', async () => {
    const { deps, cancelAllSpy } = buildDeps();
    const newSession = makeFakeSession('failing-session');
    newSession.waitForInitialization = vi.fn().mockRejectedValue(new Error('init exploded'));
    deps.buildSession = vi.fn().mockReturnValue(
      newSession as unknown as import('../../../agent/session.js').AgentSession,
    );
    await performResumeSwap(makeTarget('t-init-fail', makeStoredSession()), deps);
    expect(cancelAllSpy).not.toHaveBeenCalled();
  });

  it('cancels background jobs only after init succeeds (after buildSession resolves)', async () => {
    // Order check: buildSession must run AND newSession.waitForInitialization
    // must resolve before cancelAll is invoked. We observe the order by
    // recording calls.
    const { deps, cancelAllSpy } = buildDeps();
    const order: string[] = [];
    cancelAllSpy.mockImplementation(async () => { order.push('cancelAll'); });
    const newSession = makeFakeSession('new-session-id');
    newSession.waitForInitialization = vi.fn().mockImplementation(async () => {
      order.push('init');
      return {};
    });
    deps.buildSession = vi.fn().mockImplementation(() => {
      order.push('build');
      return newSession as unknown as import('../../../agent/session.js').AgentSession;
    });
    await performResumeSwap(makeTarget('t-order', makeStoredSession()), deps);
    expect(order).toEqual(['build', 'init', 'cancelAll']);
  });
});
