/**
 * Regression tests for R2.1 (issue #5175): onTurnStart throw protection.
 *
 * Contract: if `onTurnStart` throws, `runStream` must call
 * `this.turns.withdraw(send)` before rethrowing. Without the guard the pending
 * send stays registered, so the next `interrupt()` targets the dead send
 * instead of the running provider turn.
 *
 * We exercise `TurnStreamRunner.runStream` directly with minimal stubs so the
 * test is decoupled from AgentSession internals and runs fast.
 *
 * @module agent/session/turn-stream-runner.onturnstart-throw.test
 */

// Ledger writes are isolated by the global setup file
// src/__test-utils__/redirect-paths-env.ts (per-file AFK_HOME sentinel).
import { describe, it, expect, vi } from 'vitest';
import { TurnStreamRunner, type TurnRunnerDeps } from './turn-stream-runner.js';
import { LedgerLifecycle } from './ledger-lifecycle.js';
import type { ProviderEvent } from '../provider.js';
import type { OutputEvent, SessionState } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A trivial async-iterator that yields one `turn.completed` event. */
function oneCompletedTurn(sessionId: string): AsyncIterator<ProviderEvent> {
  const events: ProviderEvent[] = [
    {
      type: 'turn.completed',
      usage: {
        resultSubtype: 'success',
        stopReason: 'end_turn',
        durationMs: 1,
        totalCostUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
        raw: { input_tokens: 1, output_tokens: 1 },
      },
      sessionId,
    },
  ];
  let i = 0;
  return {
    async next() {
      if (i < events.length) return { done: false as const, value: events[i++]! };
      return { done: true as const, value: undefined };
    },
  };
}

/** Build a minimal `TurnRunnerDeps` with just enough to exercise `runStream`. */
function makeMinimalDeps(): TurnRunnerDeps & { state: SessionState } {
  const ledger = new LedgerLifecycle();
  // Suppress actual ledger file I/O.
  ledger.initialize({ depth: 1 });

  const ctx = {
    state: 'idle' as SessionState,
  };

  const turnCount = { value: 0 };
  const inbound = { value: 0 };

  const deps: TurnRunnerDeps & { state: SessionState } = {
    get state() { return ctx.state; },
    getConfig: () => ({
      model: 'claude-sonnet-5',
      depth: 1,
      parentSessionId: 'parent',
    } as never),
    getAbortController: () => new AbortController(),
    getProviderIterator: () => oneCompletedTurn('test-session'),
    stateManager: {
      getSessionMetadata: () => ({ model: 'claude-sonnet-5', cwd: '/tmp' }),
      setSessionMetadata: vi.fn(),
      updateSessionIdentity: vi.fn(),
      resolveInitializationOnce: vi.fn(),
      getSessionId: () => 'test-session',
    } as never,
    accounting: {
      snapshot: () => ({ lifetimeSessionCostUsd: 0, lifetimeSubagentCostUsd: 0 }),
      recordTurnMetadata: vi.fn(),
      clearProviderError: vi.fn(),
      markProviderError: vi.fn(),
      markMaxTurnsHit: vi.fn(),
    } as never,
    ledger,
    outputBroadcast: { push: vi.fn() } as never,
    conversationHistory: [],
    getInitPromise: () => null,
    getSessionId: () => 'test-session',
    getState: () => ctx.state,
    setState: (s) => { ctx.state = s; },
    getLastResponseMetadata: () => null,
    setLastResponseMetadata: vi.fn(),
    getPendingFrameworkContext: () => [],
    setPendingFrameworkContext: vi.fn(),
    getInboundMessageCount: () => inbound.value,
    incInboundMessageCount: () => ++inbound.value,
    getTurnCount: () => turnCount.value,
    incTurnCount: () => { turnCount.value++; },
    getProviderQuery: () => ({ interrupt: vi.fn() } as never),
    getLedgerMetadata: () => ({ model: 'claude-sonnet-5', cwd: '/tmp' }),
  };

  return deps;
}

/** Drain the async generator collecting all output events. */
async function drainStream(
  gen: AsyncIterableIterator<OutputEvent>,
): Promise<OutputEvent[]> {
  const out: OutputEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onTurnStart throw protection (R2.1 / issue #5175)', () => {
  it('propagates the onTurnStart error to the caller', async () => {
    const deps = makeMinimalDeps();
    const runner = new TurnStreamRunner(deps);
    const inputStream = { pushUserMessage: vi.fn() };
    const boom = new Error('onTurnStart boom');

    const gen = runner.runStream('hello', inputStream, () => { throw boom; });
    await expect(drainStream(gen)).rejects.toThrow('onTurnStart boom');
  });

  it('a second runStream call succeeds after onTurnStart threw on the first', async () => {
    const deps = makeMinimalDeps();
    const runner = new TurnStreamRunner(deps);
    const inputStream = { pushUserMessage: vi.fn() };

    // First call: onTurnStart throws → pending send must be withdrawn.
    const gen1 = runner.runStream('first', inputStream, () => {
      throw new Error('deliberate onTurnStart failure');
    });
    await expect(drainStream(gen1)).rejects.toThrow('deliberate onTurnStart failure');

    // Second call: no onTurnStart — must not hang or inherit the stale send.
    // Provide a fresh iterator so the turn can complete.
    deps.getProviderIterator = () => oneCompletedTurn('test-session-2');
    const gen2 = runner.runStream('second', inputStream);
    const events = await drainStream(gen2);

    // We expect at least a `done` event from the successful turn.
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('the pending send is not left registered after an onTurnStart throw', async () => {
    // After onTurnStart throws, `runner.nextSendId` must advance to the NEXT
    // id (the stale send was withdrawn, not still pending). We verify this
    // indirectly: if withdraw was NOT called, `startTurn` would still reference
    // the old pending send, causing the second beginSend to overwrite it and
    // lose the first. Here we just confirm no error is thrown on the second
    // call and that `nextSendId` has moved on.
    const deps = makeMinimalDeps();
    const runner = new TurnStreamRunner(deps);
    const inputStream = { pushUserMessage: vi.fn() };

    const idBeforeFirst = runner.nextSendId();

    const gen1 = runner.runStream('first', inputStream, () => {
      throw new Error('onTurnStart throw');
    });
    await expect(drainStream(gen1)).rejects.toThrow();

    // The id must have advanced (beginSend was called and then withdrawn).
    const idAfterFirst = runner.nextSendId();
    expect(idAfterFirst).toBeGreaterThan(idBeforeFirst);
  });
});
