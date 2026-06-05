/**
 * Tests for the `closure` trace event emitted from
 * {@link AgentSession#dispatchSessionEndOnce}.
 *
 * The closure event is the session's terminal classification record —
 * it names WHY the session ended and carries the final cost / token
 * tuple plus the last model stopReason. Sits adjacent to
 * `session_sealed` in the trace: closure first (what happened), then
 * seal (the trace's terminal record).
 *
 * Scope: PR #2 commit 6. Exercises the four reasons we can derive
 * today from the dispatch reason + abort signal state:
 *   - model_end_turn   (clean close, no abort)
 *   - abort            (external abort with no richer context)
 *   - budget_exceeded  (BudgetExceededError signal reason)
 *   - timeout          (TimeoutError signal reason)
 *
 * The other ClosureReason values (iteration_cap, hook_blocked,
 * max_turns_exceeded) require explicit signaling from their origin
 * sites and are deferred to follow-up work.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig, OutputEvent } from '../types.js';
import { createMockProvider, type MockProviderHandle } from '../__fixtures__/mock-provider.js';
import { InMemoryTraceWriter } from './writer.js';
import { BudgetExceededError, TimeoutError } from '../../utils/errors.js';

vi.mock('../../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

import { AgentSession } from '../session.js';

describe('AgentSession + closure trace event', () => {
  let provider: MockProviderHandle;
  let writer: InMemoryTraceWriter;
  let config: AgentConfig;

  beforeEach(() => {
    provider = createMockProvider();
    writer = new InMemoryTraceWriter();
    config = {
      model: 'sonnet',
      apiKey: 'test-key',
      provider,
      traceWriter: writer,
    };
  });

  it('emits closure with reason=model_end_turn on normal close', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    await session.close();

    const closures = writer.events.filter((e) => e.kind === 'closure');
    expect(closures).toHaveLength(1);
    const ev = closures[0];
    if (ev?.kind !== 'closure') throw new Error('unreachable');
    expect(ev.payload.reason).toBe('model_end_turn');
    expect(ev.payload.finalTurnCount).toBe(0);
    expect(ev.payload.finalCostUsd).toBe(0);
    expect(ev.payload.finalTokens).toEqual({});
  });

  it('closure precedes session_sealed in trace order', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    await session.close();

    const kinds = writer.events.map((e) => e.kind);
    const closureIdx = kinds.indexOf('closure');
    const sealIdx = kinds.indexOf('session_sealed');
    expect(closureIdx).toBeGreaterThanOrEqual(0);
    expect(sealIdx).toBeGreaterThan(closureIdx);
  });

  it('reason=abort on external abort with a generic reason', async () => {
    const externalAbort = new AbortController();
    const cancelConfig = { ...config, abortSignal: externalAbort.signal };
    const session = new AgentSession(cancelConfig);
    await session.waitForInitialization();
    externalAbort.abort('user-cancelled');
    await new Promise((r) => setTimeout(r, 0));
    await session.close();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    expect(ev.payload.reason).toBe('abort');
  });

  it('reason=budget_exceeded when signal carries a BudgetExceededError', async () => {
    const externalAbort = new AbortController();
    const cancelConfig = { ...config, abortSignal: externalAbort.signal };
    const session = new AgentSession(cancelConfig);
    await session.waitForInitialization();
    externalAbort.abort(new BudgetExceededError(0.10, 0.05));
    await new Promise((r) => setTimeout(r, 0));
    await session.close();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    expect(ev.payload.reason).toBe('budget_exceeded');
  });

  it('reason=budget_exceeded when signal carries the stringified budget message', async () => {
    // Mirrors the production path: stream-consumer passes err.message
    // (a string) to abortBudget, which calls controller.abort(reason).
    const externalAbort = new AbortController();
    const cancelConfig = { ...config, abortSignal: externalAbort.signal };
    const session = new AgentSession(cancelConfig);
    await session.waitForInitialization();
    externalAbort.abort('Budget ceiling reached: $0.1000 cumulative >= $0.0500 limit');
    await new Promise((r) => setTimeout(r, 0));
    await session.close();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    expect(ev.payload.reason).toBe('budget_exceeded');
  });

  it('reason=timeout when signal carries a TimeoutError', async () => {
    const externalAbort = new AbortController();
    const cancelConfig = { ...config, abortSignal: externalAbort.signal };
    const session = new AgentSession(cancelConfig);
    await session.waitForInitialization();
    externalAbort.abort(new TimeoutError('Operation timed out after 5000ms', 5000));
    await new Promise((r) => setTimeout(r, 0));
    await session.close();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    expect(ev.payload.reason).toBe('timeout');
  });

  it('finalTokens reflects accumulated turn usage', async () => {
    // The mock provider emits fixed usage per turn: inputTokens=10,
    // outputTokens=2, totalCostUsd=0.001, stopReason='end_turn'.
    // Two turns should produce input=20, output=4, cost=0.002.
    const session = new AgentSession(config);
    await session.waitForInitialization();

    const collect = async (gen: AsyncIterable<OutputEvent>): Promise<void> => {
      for await (const _ of gen) {
        void _;
      }
    };
    await collect(session.sendMessageStream('hi'));
    await collect(session.sendMessageStream('again'));

    await session.close();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    expect(ev.payload.finalTurnCount).toBe(2);
    expect(ev.payload.finalCostUsd).toBeCloseTo(0.002, 5);
    expect(ev.payload.finalTokens.input).toBe(20);
    expect(ev.payload.finalTokens.output).toBe(4);
    // Mock provider does not emit cache counters — cacheRead/cacheCreation
    // stay 0 and the closure helper omits zero-valued tokens.
    expect(ev.payload.finalTokens.cacheRead).toBeUndefined();
    expect(ev.payload.finalTokens.cacheCreation).toBeUndefined();
    expect(ev.payload.lastStopReason).toBe('end_turn');
  });

  it('is idempotent — repeated close() calls do not write multiple closure records', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    await session.close();
    await session.close();

    const closures = writer.events.filter((e) => e.kind === 'closure');
    expect(closures).toHaveLength(1);
  });

  it('runs even when no trace writer is configured (graceful no-op)', async () => {
    const noWriterConfig: AgentConfig = { ...config };
    delete noWriterConfig.traceWriter;
    const session = new AgentSession(noWriterConfig);
    await session.waitForInitialization();
    await expect(session.close()).resolves.not.toThrow();
    // No closure on the standalone writer (it was never wired into this session).
    expect(writer.events.filter((e) => e.kind === 'closure')).toHaveLength(0);
  });

  it('writer.write throws on closure do not propagate', async () => {
    const angry: InMemoryTraceWriter & { failOnWrite?: boolean } = new InMemoryTraceWriter();
    const origWrite = angry.write.bind(angry);
    angry.write = async (event) => {
      if (event.kind === 'closure') throw new Error('disk full');
      return origWrite(event);
    };
    const angryConfig = { ...config, traceWriter: angry };
    const session = new AgentSession(angryConfig);
    await session.waitForInitialization();
    await expect(session.close()).resolves.not.toThrow();
    // The seal event still lands despite the closure write failing.
    expect(angry.events.filter((e) => e.kind === 'session_sealed')).toHaveLength(1);
  });

  // Regression: signal handlers (SIGINT/SIGTERM/SIGHUP) must pre-abort the
  // session with a non-'closed' reason before calling rl.close(). Without
  // this, close() aborts with reason 'closed', which deriveClosureReason
  // treats as 'model_end_turn' — masking user interrupts as clean exits.
  // Covered by: interactive.ts handleSigint (2nd press), handleSigterm,
  // handleSighup each calling session.abort('sigint'|'sigterm'|'sighup').

  it('reason=abort when session.abort("sigint") is called before close()', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.abort('sigint');
    await session.close();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    expect(ev.payload.reason).toBe('abort');
  });

  it('reason=abort when session.abort("sigterm") is called before close()', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.abort('sigterm');
    await session.close();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    expect(ev.payload.reason).toBe('abort');
  });

  it('reason=abort when session.abort("sighup") is called before close()', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.abort('sighup');
    await session.close();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    expect(ev.payload.reason).toBe('abort');
  });

  it('session.abort() is idempotent — second call after already-aborted signal is a no-op', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    session.abort('sigint');
    session.abort('sigterm'); // second call must not throw or overwrite
    await session.close();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    expect(ev.payload.reason).toBe('abort');
  });

  // Contract enforcement: the JSDoc on AgentSession.abort reserves three
  // reason patterns ('closed', 'Budget '-prefix, 'timed out'-substring)
  // because deriveClosureReason interprets them as other branches. Without
  // a runtime guard, a caller passing one of these would silently produce
  // the very misclassification the method was added to prevent. The guard
  // is fail-loud (throws) — surfacing the contract violation at the call
  // site rather than at the trace-reading site.

  it('session.abort("closed") throws — reserved for the internal close() path', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    expect(() => session.abort('closed')).toThrow(/reserved reason "closed"/);
    // Signal not aborted — caller must use a different reason.
    expect(session.abortSignal.aborted).toBe(false);
    await session.close();
  });

  it('session.abort("Budget exceeded: 100k tokens") throws — reserved Budget prefix', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    expect(() => session.abort('Budget exceeded: 100k tokens')).toThrow(/reserved reason "Budget exceeded/);
    expect(session.abortSignal.aborted).toBe(false);
    await session.close();
  });

  it('session.abort("operation timed out after 30s") throws — reserved "timed out" substring', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    expect(() => session.abort('operation timed out after 30s')).toThrow(/timed out/);
    expect(session.abortSignal.aborted).toBe(false);
    await session.close();
  });

  // Race-window coverage: the idempotence test (above) calls abort() twice
  // before close(). The reverse race — close() completes its own internal
  // abort('closed') FIRST, then a delayed signal handler fires abort('sigterm')
  // afterward — is the real-world ordering when a signal arrives mid-teardown.
  // The idempotency guard correctly no-ops; the resulting reason is whatever
  // close() set, NOT the late signal reason. This test documents that
  // first-writer-wins is the intended behavior.

  it('reason=model_end_turn when abort("sigterm") is called AFTER close() has already aborted', async () => {
    const session = new AgentSession(config);
    await session.waitForInitialization();
    // close() runs first and internally calls abort('closed').
    await session.close();
    // Late signal handler fires after close() — the guard makes this a no-op.
    expect(() => session.abort('sigterm')).not.toThrow();

    const ev = writer.events.find((e) => e.kind === 'closure');
    if (ev?.kind !== 'closure') throw new Error('expected closure');
    // First writer (close → 'closed') won; deriveClosureReason returned
    // 'model_end_turn' because signal.reason === 'closed'.
    expect(ev.payload.reason).toBe('model_end_turn');
  });
});
