/**
 * R1 — runInBackground rejection handling.
 *
 * Verifies that a promise rejection inside `runToResult` does NOT produce an
 * unhandled-rejection event. The error must be observable via onResult (which
 * receives a failed SubagentResult) rather than silently disappearing.
 *
 * Before the fix, `void this.runToResult(...).then(onResult)` has no `.catch()`,
 * so any rejection that escapes `runToResult`'s own internal try/catch becomes
 * an unhandled rejection — invisible to callers and process-crash territory in
 * Node strict-mode (--unhandled-rejections=throw).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IAgentSession, Message, OutputEvent } from '../types.js';
import { SubagentHandleImpl } from './handle.js';
import { AbortGraph } from '../abort-graph.js';

// ---------------------------------------------------------------------------
// Minimal mock session that satisfies IAgentSession
// ---------------------------------------------------------------------------

function makeMinimalSession(overrides: Partial<IAgentSession> = {}): IAgentSession {
  return {
    sessionId: 'mock-session',
    state: 'idle',
    abortSignal: new AbortController().signal,
    async sendMessage(): Promise<Message> {
      return {
        role: 'assistant',
        content: 'ok',
        timestamp: new Date(),
        metadata: { usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' },
      };
    },
    async *sendMessageStream(): AsyncIterable<OutputEvent> {
      // empty stream — results in no message event, which causes runToResult to fail
    },
    async interrupt() {},
    async close() {},
    async reset() {},
    async setModel() {},
    async setPermissionMode() {},
    waitForInitialization: async () => ({
      sessionId: 'mock-session',
      model: 'test-model',
      persistSession: true,
    }),
    getSessionIdentity: () => ({ persistSession: true }),
    getSessionMetadata: () => ({
      sessionId: 'mock-session',
      model: 'test-model',
      persistSession: true,
    }),
    getQuery: () => { throw new Error('not implemented'); },
    getLastResponseMetadata: () => null,
    getOutputStream: async function* () {},
    getInputStreamRef: () => ({
      pushUserMessage: vi.fn(),
    }),
    supportedCommands: async () => [],
    supportedModels: async () => [],
    supportedAgents: async () => [],
    getContextUsage: async () => ({ contextLimitTokens: 0, contextUsedTokens: 0 }),
    mcpServerStatus: async () => [],
    accountInfo: async () => ({ name: 'test', email: 'test@example.com' }),
    cwd: '/tmp',
    setCwd: vi.fn(),
    getHistory: () => [],
    getTurnCount: () => 0,
    ...overrides,
  } as unknown as IAgentSession;
}

// ---------------------------------------------------------------------------
// R1 tests
// ---------------------------------------------------------------------------

describe('R1 — runInBackground unhandled-rejection safety', () => {
  let abortGraph: AbortGraph;
  let controller: AbortController;
  let unhandledErrors: Error[];
  let unhandledRejectionHandler: (reason: unknown) => void;

  beforeEach(() => {
    abortGraph = new AbortGraph();
    controller = new AbortController();
    abortGraph.register('root', controller);
    unhandledErrors = [];
    unhandledRejectionHandler = (reason: unknown) => {
      unhandledErrors.push(reason instanceof Error ? reason : new Error(String(reason)));
    };
    process.on('unhandledRejection', unhandledRejectionHandler);
  });

  afterEach(() => {
    process.off('unhandledRejection', unhandledRejectionHandler);
    vi.restoreAllMocks();
  });

  function makeHandle(session: IAgentSession): SubagentHandleImpl<unknown> {
    return new SubagentHandleImpl(
      'test-handle',
      session,
      controller,
      abortGraph,
      undefined,   // outputSchema
      5000,        // timeoutMs
      undefined,   // hookRegistry
      vi.fn(),     // onTerminal
    );
  }

  it('forwards multimodal content blocks unchanged to sendMessageStream', async () => {
    const seen: unknown[] = [];
    const session = makeMinimalSession({
      async *sendMessageStream(content): AsyncIterable<OutputEvent> {
        seen.push(content);
        yield {
          type: 'message',
          message: { role: 'assistant', content: 'ok', timestamp: new Date() },
        };
      },
    });
    const handle = makeHandle(session);
    const blocks = [
      { type: 'text' as const, text: 'inspect' },
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png' as const,
          data: 'aW1n',
        },
      },
    ];
    const result = await handle.runToResult(blocks);
    expect(result.status).toBe('succeeded');
    expect(seen).toEqual([blocks]);
  });

  it('(R1-1) no unhandled rejection when sendMessageStream throws', async () => {
    // Build a session whose sendMessageStream throws — representative of any
    // error that bubbles out of the session layer before a message event lands.
    const boom = new Error('stream exploded');
    const badSession = makeMinimalSession({
      async *sendMessageStream(): AsyncIterable<OutputEvent> {
        throw boom;
      },
    });

    const handle = makeHandle(badSession);

    // Fire-and-forget — do NOT await
    handle.runInBackground('prompt');

    // Drain microtask queue so the rejection would propagate if unhandled
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Without the fix, unhandledErrors would have one entry.
    expect(unhandledErrors).toHaveLength(0);
  });

  it('(R1-2) onResult called with failed SubagentResult when stream throws', async () => {
    // Verify the error is observable via onResult rather than silently dropped.
    const boom = new Error('internal agent error');
    const badSession = makeMinimalSession({
      async *sendMessageStream(): AsyncIterable<OutputEvent> {
        throw boom;
      },
    });

    const handle = makeHandle(badSession);

    const results: unknown[] = [];
    handle.runInBackground('prompt', (result) => {
      results.push(result);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // onResult must be called exactly once with a failed result
    expect(results).toHaveLength(1);
    const result = results[0] as { status: string };
    expect(result.status).toBe('failed');
  });

  it('(R1-3) no unhandled rejection when onResult callback throws', async () => {
    // A `.catch()` appended after `.then(onResult)` must also cover the case
    // where the callback itself throws — the entire chain must be swallowed.
    const goodSession = makeMinimalSession({
      async sendMessage(): Promise<Message> {
        return {
          role: 'assistant',
          content: 'hello',
          timestamp: new Date(),
          metadata: { usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' },
        };
      },
      async *sendMessageStream(): AsyncIterable<OutputEvent> {
        yield {
          type: 'message',
          message: {
            role: 'assistant',
            content: 'hello',
            timestamp: new Date(),
            metadata: { usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' },
          },
        };
        yield {
          type: 'done',
          metadata: { usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' },
        };
      },
    });

    const handle = makeHandle(goodSession);

    handle.runInBackground('prompt', () => {
      throw new Error('callback explodes');
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(unhandledErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pause-aware wall-clock ceiling — end-to-end wiring through the handle.
//
// The unit behaviour of the extension policy lives in `pause-ceiling.test.ts`.
// These tests prove the policy is actually WIRED: that the handle feeds streamed
// pause events to the ceiling attached to its own `withTimeout` call, so a fork
// parked by the provider is no longer guaranteed to die at its wall-clock
// budget. Regression target: a `/forge` fork lost 1h49m of work this way.
// ---------------------------------------------------------------------------

describe('pause-aware wall-clock ceiling (handle wiring)', () => {
  let abortGraph: AbortGraph;
  let controller: AbortController;

  beforeEach(() => {
    vi.useFakeTimers();
    abortGraph = new AbortGraph();
    controller = new AbortController();
    abortGraph.register('root', controller);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A session that emits `events`, then stalls forever (never completes). */
  function makeStallingSession(events: OutputEvent[]): IAgentSession {
    return makeMinimalSession({
      async *sendMessageStream(): AsyncIterable<OutputEvent> {
        for (const event of events) yield event;
        // Park indefinitely: only a timeout can end this turn.
        await new Promise<never>(() => {});
      },
    });
  }

  function makeHandle(session: IAgentSession, timeoutMs: number): SubagentHandleImpl<unknown> {
    return new SubagentHandleImpl(
      'forge-rework-2',
      session,
      controller,
      abortGraph,
      undefined, // outputSchema
      timeoutMs,
      undefined, // hookRegistry
      vi.fn(), // onTerminal
    );
  }

  it('still fires at the wall-clock budget when no pause event arrives', async () => {
    const BUDGET = 60_000;
    const handle = makeHandle(makeStallingSession([]), BUDGET);

    const settled = handle.run('prompt').then(
      () => 'resolved',
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(BUDGET - 1);
    // Nothing has fired yet: the budget is intact.
    await vi.advanceTimersByTimeAsync(1);

    const outcome = await settled;
    expect(outcome).toBeInstanceOf(Error);
    // Unchanged message shape for the no-pause path.
    expect((outcome as Error).message).toBe(
      'Operation timed out after 60000ms (forge-rework-2)',
    );
  });

  it('extends past the budget when the child streams a provider `paused` event', async () => {
    const BUDGET = 60_000;
    const parkMs = 10 * 60_000; // park far longer than the budget
    const handle = makeHandle(
      makeStallingSession([
        {
          type: 'paused',
          reason: 'usage-limit',
          resetsAt: new Date(Date.now() + parkMs),
        },
      ]),
      BUDGET,
    );

    let settled = false;
    const outcome = handle.run('prompt').then(
      () => 'resolved',
      (err: unknown) => {
        settled = true;
        return err;
      },
    );

    // Pre-fix the turn died exactly here. Post-fix the parked time is credited.
    await vi.advanceTimersByTimeAsync(BUDGET + 1);
    expect(settled).toBe(false);

    // Finite: it still dies once the credited park is consumed.
    await vi.advanceTimersByTimeAsync(parkMs + 60_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    // And the failure now names the pause context instead of a bare timeout.
    expect((err as Error).message).toContain('pause-aware ceiling');
    expect((err as Error).message).toContain('last provider pause: paused (usage-limit');
  });

  it('does NOT extend when the child only streams ordinary content', async () => {
    const BUDGET = 60_000;
    const handle = makeHandle(
      makeStallingSession([
        { type: 'chunk', chunk: { type: 'content', content: 'working hard' } },
        { type: 'chunk', chunk: { type: 'thinking', thinking: 'still working' } },
      ]),
      BUDGET,
    );

    const settled = handle.run('prompt').then(
      () => 'resolved',
      (err: unknown) => err,
    );

    await vi.advanceTimersByTimeAsync(BUDGET + 1);

    const outcome = await settled;
    expect(outcome).toBeInstanceOf(Error);
    // Anti-gaming: child output buys no extension, so the message is the plain one.
    expect((outcome as Error).message).toBe(
      'Operation timed out after 60000ms (forge-rework-2)',
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #724 — empty-buffer stream cut with prior tool results (#724)
//
// When a stream ends with no terminal message AND an empty text buffer, the
// run classifies `failed` (StreamIncompleteError). If tool-call cycles
// completed before the cut, partialOutput must carry a summary and
// toolResultsGathered must be set on the error — so the parent can
// distinguish "died with N gathered results" from "died with nothing".
// ---------------------------------------------------------------------------

describe('#724 — empty-buffer stream cut with prior tool results', () => {
  let abortGraph: AbortGraph;
  let controller: AbortController;

  beforeEach(() => {
    abortGraph = new AbortGraph();
    controller = new AbortController();
    abortGraph.register('root', controller);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeHandle(session: IAgentSession): SubagentHandleImpl<unknown> {
    return new SubagentHandleImpl(
      'sub-724',
      session,
      controller,
      abortGraph,
      undefined,  // outputSchema
      5000,       // timeoutMs
      undefined,  // hookRegistry
      vi.fn(),    // onTerminal
    );
  }

  /** Session that emits N tool_result chunks then ends abruptly (no message/done). */
  function makeStreamCutSession(toolResultCount: number): IAgentSession {
    return makeMinimalSession({
      async *sendMessageStream(): AsyncIterable<OutputEvent> {
        for (let i = 0; i < toolResultCount; i++) {
          yield {
            type: 'chunk',
            chunk: {
              type: 'tool_result',
              toolUseId: `tu-${i}`,
              content: 'some file content',
              isError: false,
              sizeBytes: 1000 + i * 500,
            },
          };
        }
        // No 'message' or 'done' event — stream ends abruptly.
      },
    });
  }

  it('classifies as failed when stream cuts with empty buffer and no tool results', async () => {
    const handle = makeHandle(makeStreamCutSession(0));
    const result = await handle.runToResult('go');
    expect(result.status).toBe('failed');
    expect(result.partialOutput).toBeUndefined();
  });

  it('classifies as failed AND populates partialOutput when stream cuts after 5 tool results', async () => {
    const handle = makeHandle(makeStreamCutSession(5));
    const result = await handle.runToResult('go');
    expect(result.status).toBe('failed');
    expect(result.partialOutput).toBeTypeOf('string');
    expect(result.partialOutput as string).toContain('5 tool result(s)');
    expect(result.partialOutput as string).toContain('sub-724');
  });

  it('sets toolResultsGathered on the error when tool results exist', async () => {
    const handle = makeHandle(makeStreamCutSession(3));
    const result = await handle.runToResult('go');
    expect(result.status).toBe('failed');
    // The error must carry toolResultsGathered for the retry-dispatch layer.
    const { StreamIncompleteError: SIE } = await import('../../utils/errors.js');
    expect(result.error).toBeInstanceOf(SIE);
    expect((result.error as InstanceType<typeof SIE>).toolResultsGathered).toBe(3);
  });

  it('does NOT set toolResultsGathered when no tool results were gathered', async () => {
    const handle = makeHandle(makeStreamCutSession(0));
    const result = await handle.runToResult('go');
    const { StreamIncompleteError: SIE } = await import('../../utils/errors.js');
    expect(result.error).toBeInstanceOf(SIE);
    expect((result.error as InstanceType<typeof SIE>).toolResultsGathered).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// steer() — ring buffer, guards, and teardown clearing
// ---------------------------------------------------------------------------

describe('SubagentHandleImpl.steer()', () => {
  function makeSteerHandle(status?: 'succeeded' | 'failed' | 'cancelled'): SubagentHandleImpl<unknown> {
    const controller = new AbortController();
    const graph = new AbortGraph(controller, 'steer-test');
    const session: IAgentSession = {
      sessionId: 'steer-session',
      state: 'idle',
      abortSignal: controller.signal,
      async sendMessage() { return { role: 'assistant', content: '', timestamp: new Date() }; },
      async *sendMessageStream() {},
      async interrupt() {},
      async close() {},
      async reset() {},
      async setModel() {},
      async setPermissionMode() {},
      waitForInitialization: async () => ({ sessionId: 'steer-session', model: 'm', persistSession: false }),
      getSessionIdentity: () => ({ persistSession: false }),
      getSessionMetadata: () => ({ sessionId: 'steer-session', model: 'm', persistSession: false }),
      getQuery: () => { throw new Error('na'); },
      getLastResponseMetadata: () => null,
      getOutputStream: async function* () {},
      getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
      supportedCommands: async () => [],
      supportedModels: async () => [],
      supportedAgents: async () => [],
      getContextUsage: async () => ({ contextLimitTokens: 0, contextUsedTokens: 0 }),
      mcpServerStatus: async () => [],
      accountInfo: async () => ({ name: 't', email: 't@t.com' }),
      cwd: '/tmp',
      setCwd: vi.fn(),
      getHistory: () => [],
      getTurnCount: () => 0,
    } as unknown as IAgentSession;

    const handle = new SubagentHandleImpl('steer-handle', session, controller, graph, undefined, 5000, undefined, vi.fn());
    if (status) {
      // Force the status by accessing internal field directly (test-only).
      (handle as unknown as { _currentStatus: string })._currentStatus = status;
    }
    return handle;
  }

  it('queues a message into _steeringMessages during active run', () => {
    const handle = makeSteerHandle();
    handle.steer('focus on auth');
    expect(handle._steeringMessages).toHaveLength(1);
    expect(handle._steeringMessages[0]).toBe('focus on auth');
  });

  it('silently drops whitespace-only messages', () => {
    const handle = makeSteerHandle();
    handle.steer('   ');
    handle.steer('\t\n');
    expect(handle._steeringMessages).toHaveLength(0);
  });

  it('silently drops messages when status is succeeded', () => {
    const handle = makeSteerHandle('succeeded');
    handle.steer('too late');
    expect(handle._steeringMessages).toHaveLength(0);
  });

  it('silently drops messages when status is failed', () => {
    const handle = makeSteerHandle('failed');
    handle.steer('too late');
    expect(handle._steeringMessages).toHaveLength(0);
  });

  it('silently drops messages when status is cancelled', () => {
    const handle = makeSteerHandle('cancelled');
    handle.steer('too late');
    expect(handle._steeringMessages).toHaveLength(0);
  });

  it('silently drops messages when the controller is aborted', () => {
    const controller = new AbortController();
    const graph = new AbortGraph(controller, 'steer-aborted');
    const session = {
      sessionId: 's', state: 'idle', abortSignal: controller.signal,
      async sendMessage() { return { role: 'assistant' as const, content: '', timestamp: new Date() }; },
      async *sendMessageStream() {},
      async interrupt() {}, async close() {}, async reset() {}, async setModel() {}, async setPermissionMode() {},
      waitForInitialization: async () => ({ sessionId: 's', model: 'm', persistSession: false }),
      getSessionIdentity: () => ({ persistSession: false }),
      getSessionMetadata: () => ({ sessionId: 's', model: 'm', persistSession: false }),
      getQuery: () => { throw new Error('na'); },
      getLastResponseMetadata: () => null,
      getOutputStream: async function* () {},
      getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
      supportedCommands: async () => [], supportedModels: async () => [],
      supportedAgents: async () => [],
      getContextUsage: async () => ({ contextLimitTokens: 0, contextUsedTokens: 0 }),
      mcpServerStatus: async () => [], accountInfo: async () => ({ name: 't', email: 't@t.com' }),
      cwd: '/tmp', setCwd: vi.fn(), getHistory: () => [], getTurnCount: () => 0,
    } as unknown as IAgentSession;
    const handle = new SubagentHandleImpl('steer-ab', session, controller, graph, undefined, 5000, undefined, vi.fn());
    controller.abort('test abort');
    handle.steer('after abort');
    expect(handle._steeringMessages).toHaveLength(0);
  });

  it('ring buffer evicts oldest when capacity (3) is exceeded', () => {
    const handle = makeSteerHandle();
    handle.steer('msg-1');
    handle.steer('msg-2');
    handle.steer('msg-3');
    handle.steer('msg-4'); // evicts msg-1
    expect(handle._steeringMessages).toHaveLength(3);
    expect(handle._steeringMessages[0]).toBe('msg-2');
    expect(handle._steeringMessages[1]).toBe('msg-3');
    expect(handle._steeringMessages[2]).toBe('msg-4');
  });

  it('_beforeNextRound getter returns a closure that shifts from _steeringMessages', () => {
    const handle = makeSteerHandle();
    handle.steer('first');
    handle.steer('second');
    const cb = handle._beforeNextRound;
    expect(cb()).toBe('first');
    expect(cb()).toBe('second');
    expect(cb()).toBeUndefined();
  });
});
