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
