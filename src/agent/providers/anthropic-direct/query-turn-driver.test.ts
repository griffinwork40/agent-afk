// Unit tests for `driveTurns` — the multi-turn outer loop in
// query-turn-driver.ts.
//
// Coverage target (P2 Codex review):
//   When the overload-pause tier yields a `turn.completed` terminal while
//   the session is being closed (`ctx.state.closed = true`), the driver MUST
//   yield the event BEFORE returning so `stream-consumer.ts`'s
//   `setLastResponseMetadata` fires and `AgentSession.lastStopReason` is
//   populated correctly.
//
//   Pre-fix: the driver set `ctx.state.lastUsage` (provider-internal) then
//   hit `if (ctx.state.closed) return` BEFORE `yield event`, so the
//   `turn.completed` event never reached the session consumer — the session
//   sealed `succeeded` with `lastStopReason` unset instead of `failed` with
//   `OVERLOAD_EXHAUSTED`.

import { describe, it, expect, vi } from 'vitest';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { TurnDriverContext } from './query-turn-driver.js';
import { driveTurns } from './query-turn-driver.js';
import { OVERLOAD_EXHAUSTED } from './overload-pause.js';
import type { ProviderUsage } from '../../provider.js';

// ---------------------------------------------------------------------------
// Minimal stub helpers
// ---------------------------------------------------------------------------

/** AbortController that is always idle (never pre-aborted). */
function makeStubAbort(closedPromise: Promise<'__closed__'>) {
  const controller = new AbortController();
  return {
    begin: () => controller,
    clear: vi.fn(),
    isIdle: () => true,
    closedPromise,
  };
}

/** Minimal SessionState with mutable `closed` flag. */
function makeStubState() {
  return {
    messages: [] as import('@anthropic-ai/sdk/resources').MessageParam[],
    currentModel: 'claude-test',
    requestedModel: 'claude-test',
    currentPermissionMode: 'default',
    userSystem: null as string | null,
    toolDispatcher: {} as unknown,
    lastUsage: null as ProviderUsage | null,
    closed: false,
    autoCompactThreshold: undefined,
  };
}

/**
 * A prompt stream that yields exactly ONE user turn and then closes, so the
 * driver's outer `while (!ctx.state.closed)` exits naturally after the turn
 * completes without parking on a subsequent `promptIterator.next()`.
 *
 * Note: even if the driver loops back for a second prompt pull, the
 * `promptIterator.return()` call in the outer `finally` will resolve it.
 * But yielding `done: true` immediately after the first turn is cleaner.
 */
function makeSingleTurnThenDonePrompt(): AsyncIterable<ProviderUserTurn> {
  return {
    [Symbol.asyncIterator]() {
      let yielded = false;
      return {
        async next() {
          if (!yielded) {
            yielded = true;
            return { value: { content: 'hi' } as ProviderUserTurn, done: false };
          }
          return { value: undefined as unknown as ProviderUserTurn, done: true };
        },
        async return() {
          return { value: undefined as unknown as ProviderUserTurn, done: true };
        },
      };
    },
  };
}

/**
 * Build a minimal context whose `retry.turnWithRetries` yields the supplied
 * events and then returns.
 */
function makeCtx(
  state: ReturnType<typeof makeStubState>,
  abort: ReturnType<typeof makeStubAbort>,
  turnEvents: ProviderEvent[],
): TurnDriverContext {
  return {
    initSessionId: 'test-session',
    promptStream: makeSingleTurnThenDonePrompt(),
    state: state as unknown as TurnDriverContext['state'],
    abort: abort as unknown as TurnDriverContext['abort'],
    retry: {
      authMode: 'api-key',
      client: {} as unknown as TurnDriverContext['retry']['client'],
      turnWithRetries: async function* () {
        for (const ev of turnEvents) yield ev;
      },
    } as unknown as TurnDriverContext['retry'],
    maxTokens: 1024,
    tools: null,
    thinking: undefined,
    effort: undefined,
    baseUrl: undefined,
    maxToolUseIterations: undefined,
    softDeadlineMs: undefined,
    traceWriter: undefined,
    subagentId: undefined,
    mcpManager: undefined,
    hookRegistry: undefined,
    throttleQueue: undefined,
    fastModeController: undefined,
    composeSystem: () => null,
    makeInterruptedTurnEvent: () => ({
      type: 'turn.completed' as const,
      usage: { stopReason: 'interrupted' },
    }),
    compact: async () => ({ kind: 'history-too-short' as const }),
  };
}

// ---------------------------------------------------------------------------
// Drain helper — skips `session.init` (always first) to focus on turn events.
// ---------------------------------------------------------------------------

async function drainAfterInit(
  gen: AsyncGenerator<ProviderEvent, void, void>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  // Consume session.init
  const first = await gen.next();
  if (first.value?.type !== 'session.init') {
    throw new Error(`expected session.init, got ${String(first.value?.type)}`);
  }
  // Collect remaining events
  for await (const ev of gen) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('driveTurns — P2: turn.completed forwarded before closed-return', () => {
  // Core regression guard. The scenario:
  //
  //   1. The overload-pause tier yields OVERLOAD_EXHAUSTED terminal.
  //   2. close() fires: `state.closed` becomes `true` while the driver is
  //      processing the event.
  //   3. Pre-fix: `if (ctx.state.closed) return` fired before `yield event`.
  //      The terminal never reached the consumer → `lastStopReason` unset.
  //   4. Post-fix: `yield event` fires first, THEN the closed-return.
  it('yields OVERLOAD_EXHAUSTED terminal even when close fires concurrently', async () => {
    const state = makeStubState();
    let closedResolve!: () => void;
    const closedPromise = new Promise<'__closed__'>((r) => {
      closedResolve = () => r('__closed__');
    });
    const abort = makeStubAbort(closedPromise);

    const exhaustedTerminal: ProviderEvent = {
      type: 'turn.completed',
      usage: { stopReason: OVERLOAD_EXHAUSTED, outputTokens: 5 },
      sessionId: 'test-session',
    };

    const ctx = makeCtx(state, abort, []);
    // Override turnWithRetries: yield the terminal, then set closed (simulating
    // close() landing immediately after the tier delivers its event).
    (ctx.retry as unknown as Record<string, unknown>).turnWithRetries =
      async function* () {
        yield exhaustedTerminal;
        state.closed = true;
        closedResolve();
      };

    const events = await drainAfterInit(driveTurns(ctx));

    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe(OVERLOAD_EXHAUSTED);
    }
  });

  // Complementary: close fires BEFORE the tier yields the terminal. The driver
  // receives the event while `state.closed` is already true. Must still yield it.
  it('yields OVERLOAD_EXHAUSTED terminal when closed is already true before the event', async () => {
    const state = makeStubState();
    let closedResolve!: () => void;
    const closedPromise = new Promise<'__closed__'>((r) => {
      closedResolve = () => r('__closed__');
    });
    const abort = makeStubAbort(closedPromise);

    const exhaustedTerminal: ProviderEvent = {
      type: 'turn.completed',
      usage: { stopReason: OVERLOAD_EXHAUSTED, outputTokens: 3 },
      sessionId: 'test-session',
    };

    const ctx = makeCtx(state, abort, []);
    (ctx.retry as unknown as Record<string, unknown>).turnWithRetries =
      async function* () {
        // close() fires BEFORE the event is processed
        state.closed = true;
        closedResolve();
        yield exhaustedTerminal;
      };

    const events = await drainAfterInit(driveTurns(ctx));

    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe(OVERLOAD_EXHAUSTED);
    }
  });

  // Verify ctx.state.lastUsage (provider-internal) is also set on the close path.
  // This was already true before the fix; ensure the fix didn't regress it.
  it('sets ctx.state.lastUsage even when closed fires concurrently', async () => {
    const state = makeStubState();
    let closedResolve!: () => void;
    const closedPromise = new Promise<'__closed__'>((r) => {
      closedResolve = () => r('__closed__');
    });
    const abort = makeStubAbort(closedPromise);

    const exhaustedUsage: ProviderUsage = {
      stopReason: OVERLOAD_EXHAUSTED,
      outputTokens: 7,
    };
    const exhaustedTerminal: ProviderEvent = {
      type: 'turn.completed',
      usage: exhaustedUsage,
      sessionId: 'test-session',
    };

    const ctx = makeCtx(state, abort, []);
    (ctx.retry as unknown as Record<string, unknown>).turnWithRetries =
      async function* () {
        yield exhaustedTerminal;
        state.closed = true;
        closedResolve();
      };

    await drainAfterInit(driveTurns(ctx));

    // Provider-internal state must be updated — was already set before the fix.
    expect(state.lastUsage).not.toBeNull();
    expect(state.lastUsage?.stopReason).toBe(OVERLOAD_EXHAUSTED);
  });

  // Normal path guard: a clean turn still produces the turn.completed event
  // and does not terminate the session prematurely.
  it('yields a clean turn.completed normally (no closed, normal path unaffected)', async () => {
    const state = makeStubState();
    // closedPromise that never resolves — we rely on the prompt stream
    // returning `done:true` after one turn to unblock the generator naturally.
    const closedPromise = new Promise<'__closed__'>(() => undefined);
    const abort = makeStubAbort(closedPromise);

    const cleanTerminal: ProviderEvent = {
      type: 'turn.completed',
      usage: { stopReason: 'end_turn', outputTokens: 10 },
      sessionId: 'test-session',
    };

    const ctx = makeCtx(state, abort, [cleanTerminal]);

    const events = await drainAfterInit(driveTurns(ctx));

    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('end_turn');
    }
    // state.lastUsage must also be set on the normal path.
    expect(state.lastUsage?.stopReason).toBe('end_turn');
  });
});
