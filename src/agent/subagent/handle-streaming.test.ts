/**
 * Wave 2 Lane 2A: roundtrip equivalence and streaming-sink tests for SubagentHandle.
 * Tests that the sendMessageStream-based run() produces the same final Message
 * as the current sendMessage implementation, plus streaming progress sink behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgentSession, Message, OutputEvent } from '../types.js';
import { SubagentHandleImpl } from './handle.js';
import { STREAM_INCOMPLETE } from './result.js';
import { AbortGraph } from '../abort-graph.js';
import { TimeoutError } from '../../utils/errors.js';
import { runWithSink, getCurrentSink } from '../_lib/skill-sink-channel.js';

/**
 * Factory to create a deterministic mock session that yields a sequence of OutputEvents
 * from sendMessageStream, and returns a reconstructed Message from sendMessage.
 */
function createDeterministicMockSession(
  events: OutputEvent[],
  finalMessage: Message,
): IAgentSession {
  const sendMessageStream = async function* () {
    for (const event of events) {
      yield event;
    }
  };

  return {
    sessionId: 'mock-session',
    state: 'idle',
    abortSignal: new AbortController().signal,
    async sendMessage() {
      return finalMessage;
    },
    sendMessageStream,
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
    getQuery: () => {
      throw new Error('not implemented');
    },
    getLastResponseMetadata: () => null,
    getOutputStream: async function* () {},
    getInputStreamRef: () => ({
      pushUserMessage: vi.fn(),
    }),
    supportedCommands: async () => [],
    supportedModels: async () => [],
    supportedAgents: async () => [],
    getContextUsage: async () => ({
      contextLimitTokens: 0,
      contextUsedTokens: 0,
    }),
    mcpServerStatus: async () => [],
    accountInfo: async () => ({
      name: 'test',
      email: 'test@example.com',
    }),
  } as unknown as IAgentSession;
}

describe('SubagentHandle streaming', () => {
  const abortGraph = new AbortGraph();
  const controller = new AbortController();

  beforeEach(() => {
    abortGraph.register('root', controller);
  });

  describe('ROUNDTRIP EQUIVALENCE: sendMessageStream path produces same final Message as sendMessage', () => {
    it('reconstructs identical Message from stream terminal event', async () => {
      const finalMessage: Message = {
        role: 'assistant',
        content: 'test response',
        timestamp: new Date(),
        metadata: {
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: 'end_turn',
        },
      };

      const events: OutputEvent[] = [
        {
          type: 'chunk',
          chunk: { type: 'content', content: 'test' },
        },
        {
          type: 'chunk',
          chunk: { type: 'content', content: ' response' },
        },
        {
          type: 'message',
          message: finalMessage,
        },
        {
          type: 'done',
          metadata: {
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'end_turn',
          },
        },
      ];

      const session = createDeterministicMockSession(events, finalMessage);
      const handle = new SubagentHandleImpl(
        'subagent-equiv-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const msg = await handle.run('test prompt');

      expect(msg).toEqual(finalMessage);
      expect(msg.content).toBe('test response');
      expect(msg.metadata?.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
      });
      expect(msg.metadata?.stopReason).toBe('end_turn');
      expect(handle.status).toBe('succeeded');
    });

    it('returns final Message via "message" event', async () => {
      const finalMessage: Message = {
        role: 'assistant',
        content: 'another response',
        timestamp: new Date(),
        metadata: {
          usage: { inputTokens: 5, outputTokens: 3 },
          stopReason: 'end_turn',
        },
      };

      const events: OutputEvent[] = [
        { type: 'message', message: finalMessage },
        { type: 'done' },
      ];

      const session = createDeterministicMockSession(events, finalMessage);
      const handle = new SubagentHandleImpl(
        'subagent-equiv-test-2',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const msg = await handle.run('another prompt');
      expect(msg).toEqual(finalMessage);
      expect(msg.content).toBe('another response');
      expect(handle.status).toBe('succeeded');
    });
  });

  describe('Streamed-content fallback when no message event is emitted', () => {
    it('reconstructs Message from chunk content when stream ends without a message event', async () => {
      // Models hitting the tool-use iteration cap (or ending an empty-text turn)
      // emit only `turn.completed` -> `done`, never `assistant.message`. The
      // streamed `delta.text` chunks must be the fallback rather than throwing.
      const events: OutputEvent[] = [
        { type: 'chunk', chunk: { type: 'content', content: 'partial ' } },
        { type: 'chunk', chunk: { type: 'content', content: 'reply' } },
        { type: 'done' },
      ];

      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl(
        'subagent-fallback-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const msg = await handle.run('p');
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('partial reply');
      expect(handle.status).toBe('succeeded');
    });

    it('returns a stream-incomplete partial (not a throw) when the stream ends with neither message nor streamed content', async () => {
      // Degradation contract: an empty cut-off stream (no terminal message, no
      // buffered text, no error, and NOT the tool-use cap) must NOT throw an
      // opaque "produced no terminal message". It returns a STREAM_INCOMPLETE
      // partial (status 'succeeded') carrying a cut-off marker, so the parent
      // gets an actionable incomplete result — annotateIfIncomplete flags it at
      // the consumption boundary — instead of a bare delegation failure.
      const events: OutputEvent[] = [{ type: 'done' }];
      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl(
        'subagent-empty-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const result = await handle.runToResult('p');
      expect(result.status).toBe('succeeded');
      expect(result.stopReason).toBe(STREAM_INCOMPLETE);
      expect(result.message?.content).toMatch(/without producing a final message/);
    });

    it('overwrites a clean terminal stopReason with STREAM_INCOMPLETE on an empty cut-off run', async () => {
      // Codex PR #597 P2 regression guard. An empty-text turn that ends with a
      // CLEAN terminal reason (end_turn / max_tokens) is dropped by the stream
      // consumer before a `message` event is emitted (`assistant.message`:
      // `if (event.text)`), so the empty-fallback branch is reached with
      // lastStopReason already set to that clean reason. It MUST be overwritten
      // to STREAM_INCOMPLETE (assignment, not `??=`): the returned content is a
      // synthetic "no findings" placeholder, and preserving `end_turn` would let
      // annotateIfIncomplete report that placeholder as a clean completion with
      // no partial marker — the exact silent-success this branch exists to kill.
      const events: OutputEvent[] = [{ type: 'done', metadata: { stopReason: 'end_turn' } }];
      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl(
        'subagent-empty-cleanreason-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const result = await handle.runToResult('p');
      expect(result.status).toBe('succeeded');
      expect(result.stopReason).toBe(STREAM_INCOMPLETE);
      expect(result.stopReason).not.toBe('end_turn');
      expect(result.message?.content).toMatch(/without producing a final message/);
    });

    it('returns a capped partial result (not a throw) when the tool-use cap fires with no message', async () => {
      // Anti-hang contract: a forked child that hits its tool-use-iteration cap
      // ends the turn with a `tool_use_loop_capped` done and no assistant
      // message. A pure tool-only runaway also streams no text, so the child
      // must NOT be reported as a failed subagent — it returns a capped partial
      // result (status 'succeeded') carrying a cap marker. Regression guard for
      // the #394 Codex P2 finding.
      const events: OutputEvent[] = [
        { type: 'done', metadata: { stopReason: 'tool_use_loop_capped' } },
      ];
      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl(
        'subagent-capped-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const msg = await handle.run('p');
      expect(msg.role).toBe('assistant');
      expect(String(msg.content)).toMatch(/capped/i);
      expect(handle.status).toBe('succeeded');
    });

    it('surfaces stopReason=tool_use_loop_capped on the SubagentResult for a capped run', async () => {
      // Callers of runToResult must be able to distinguish a capped partial
      // (synthetic marker message) from a genuine answer without substring-
      // matching the message content — SubagentResult.stopReason carries the
      // provider's terminal stop reason for exactly this purpose.
      const events: OutputEvent[] = [
        { type: 'done', metadata: { stopReason: 'tool_use_loop_capped' } },
      ];
      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl(
        'subagent-capped-result-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const result = await handle.runToResult('p');
      expect(result.status).toBe('succeeded');
      expect(result.stopReason).toBe('tool_use_loop_capped');
      expect(String(result.message?.content)).toMatch(/capped/i);
    });

    it('surfaces a normal stopReason (end_turn) on the SubagentResult', async () => {
      const events: OutputEvent[] = [
        { type: 'chunk', chunk: { type: 'content', content: 'real answer' } },
        {
          type: 'message',
          message: { role: 'assistant', content: 'real answer', timestamp: new Date() },
        },
        { type: 'done', metadata: { stopReason: 'end_turn' } },
      ];
      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'real answer',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl(
        'subagent-stop-reason-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const result = await handle.runToResult('p');
      expect(result.status).toBe('succeeded');
      expect(result.stopReason).toBe('end_turn');
    });

    it('throws error event even when partial streamed content exists', async () => {
      const streamError = new Error('upstream stream failure');
      const events: OutputEvent[] = [
        { type: 'chunk', chunk: { type: 'content', content: 'partial ' } },
        { type: 'error', error: streamError },
      ];

      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl(
        'subagent-error-with-content-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      await expect(handle.run('p')).rejects.toThrow(/upstream stream failure/);
      expect(handle.status).toBe('failed');
    });
  });

  describe('Sink invocation and event ordering', () => {
    it('calls progressSink for each event in order with correct metadata', async () => {
      const sinkFn = vi.fn();
      // handle.run() returns the `message` event's payload (handle.ts: finalMessage
      // = event.message), so the expectation must compare against that exact object.
      // Constructing a second message with its own `new Date()` raced the millisecond
      // boundary and made `expect(msg).toEqual(finalMessage)` flaky on slower CI
      // runners. Share one Message reference across the event and the expectation.
      const finalMessage: Message = {
        role: 'assistant',
        content: 'hello',
        timestamp: new Date(),
      };
      const events: OutputEvent[] = [
        { type: 'progress', progress: { taskId: 'task-1', description: 'starting', totalTokens: 0, toolUses: 0, durationMs: 10 } },
        { type: 'message', message: finalMessage },
        { type: 'done' },
      ];

      const session = createDeterministicMockSession(events, finalMessage);
      const handle = new SubagentHandleImpl(
        'subagent-sink-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
        undefined,
        undefined,
        'skill',
        sinkFn,
      );

      const msg = await handle.run('test');

      expect(sinkFn).toHaveBeenCalledTimes(3);

      // Check first call (progress event)
      const firstCall = sinkFn.mock.calls[0];
      expect(firstCall[0]).toEqual(events[0]);
      expect(firstCall[1]).toEqual({
        subagentId: 'subagent-sink-test',
        agentType: 'skill',
      });

      // Check second call (message event)
      const secondCall = sinkFn.mock.calls[1];
      expect(secondCall[0]).toEqual(events[1]);

      // Check third call (done event)
      const thirdCall = sinkFn.mock.calls[2];
      expect(thirdCall[0]).toEqual(events[2]);

      expect(msg).toEqual(finalMessage);
    });

    it('includes parentId in metadata when available', async () => {
      const sinkFn = vi.fn();
      const events: OutputEvent[] = [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: 'response',
            timestamp: new Date(),
          },
        },
        { type: 'done' },
      ];
      const finalMessage: Message = {
        role: 'assistant',
        content: 'response',
        timestamp: new Date(),
      };

      const session = createDeterministicMockSession(events, finalMessage);
      const handle = new SubagentHandleImpl(
        'child-agent',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
        { pushUserMessage: vi.fn() },
        new AbortController().signal,
        'tool',
        sinkFn,
        'parent-agent-123',
      );

      await handle.run('prompt');

      expect(sinkFn).toHaveBeenCalledWith(events[1], {
        subagentId: 'child-agent',
        parentId: 'parent-agent-123',
        agentType: 'tool',
      });
    });
  });

  describe('No-sink path returns same Message', () => {
    it('succeeds with no sink, status becomes succeeded', async () => {
      const finalMessage: Message = {
        role: 'assistant',
        content: 'no-sink response',
        timestamp: new Date(),
        metadata: {
          usage: { inputTokens: 2, outputTokens: 1 },
          stopReason: 'end_turn',
        },
      };

      const events: OutputEvent[] = [
        { type: 'message', message: finalMessage },
        { type: 'done' },
      ];

      const session = createDeterministicMockSession(events, finalMessage);
      const onTerminal = vi.fn();
      const handle = new SubagentHandleImpl(
        'no-sink-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        onTerminal,
      );

      const msg = await handle.run('test');

      expect(msg).toEqual(finalMessage);
      expect(handle.status).toBe('succeeded');
      expect(onTerminal).toHaveBeenCalledTimes(1);
    });
  });

  describe('Abort mid-stream', () => {
    it('cancels handle during streaming, stops sink calls', async () => {
      const sinkFn = vi.fn();
      let holdResolve: () => void = () => {};

      const events: OutputEvent[] = [
        { type: 'progress', progress: { taskId: 'task-1', description: 'step 1', totalTokens: 0, toolUses: 0, durationMs: 5 } },
      ];

      // Create a custom session with a controllable stream
      const session: IAgentSession = {
        sessionId: 'mock-session',
        state: 'idle',
        abortSignal: new AbortController().signal,
        async sendMessage() {
          return {
            role: 'assistant',
            content: '',
            timestamp: new Date(),
          };
        },
        async *sendMessageStream() {
          yield events[0];
          // Hold here until test resolves or aborted
          await new Promise<void>((resolve) => {
            holdResolve = resolve;
          });
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
        getQuery: () => {
          throw new Error('not implemented');
        },
        getLastResponseMetadata: () => null,
        getOutputStream: async function* () {},
        getInputStreamRef: () => ({
          pushUserMessage: vi.fn(),
        }),
        supportedCommands: async () => [],
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => ({
          contextLimitTokens: 0,
          contextUsedTokens: 0,
        }),
        mcpServerStatus: async () => [],
        accountInfo: async () => ({
          name: 'test',
          email: 'test@example.com',
        }),
      } as unknown as IAgentSession;

      const onTerminal = vi.fn();
      const handle = new SubagentHandleImpl(
        'abort-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        onTerminal,
        undefined,
        undefined,
        undefined,
        sinkFn,
      );

      // Start the run in background
      const runPromise = handle.run('test');

      // Give it a tick to yield the first event
      await new Promise((r) => setImmediate(r));

      // Now cancel
      await handle.cancel();

      expect(handle.status).toBe('cancelled');
      expect(sinkFn).toHaveBeenCalledTimes(1);
      expect(sinkFn.mock.calls[0][0]).toEqual(events[0]);

      // Resolve the hold so the promise completes
      holdResolve();

      // The run should reject with abort error or similar
      await expect(runPromise).rejects.toThrow();
    });

    it('classifies cascade-driven aborts as cancelled (not failed)', async () => {
      // Phase 1.5 regression guard: when an ancestor's abort cascades down,
      // the child's controller.abort() is called directly by AbortGraph
      // (bypassing handle.cancel()), so currentStatus stays 'running' until
      // the catch block fires. Before the fix, the catch block emitted a
      // 'cancelled' trace event but unconditionally set currentStatus to
      // 'failed' — causing SubagentResult.status to misclassify the
      // termination. This test guards the corrected behavior.
      let holdResolve: () => void = () => {};
      const session: IAgentSession = {
        sessionId: 'mock-session',
        state: 'idle',
        abortSignal: new AbortController().signal,
        async sendMessage() {
          return { role: 'assistant', content: '', timestamp: new Date() };
        },
        async *sendMessageStream() {
          // Hang until the test cascades the abort. The stream's `next()`
          // call surfaces the abort via the controller; once aborted, throw.
          await new Promise<void>((resolve) => { holdResolve = resolve; });
          if (childController.signal.aborted) {
            throw childController.signal.reason ?? new Error('aborted');
          }
        },
        async interrupt() {},
        async close() {},
        async reset() {},
        async setModel() {},
        async setPermissionMode() {},
        waitForInitialization: async () => ({ sessionId: 'mock-session', model: 'test-model', persistSession: true }),
        getSessionIdentity: () => ({ persistSession: true }),
        getSessionMetadata: () => ({ sessionId: 'mock-session', model: 'test-model', persistSession: true }),
        getQuery: () => { throw new Error('not implemented'); },
        getLastResponseMetadata: () => null,
        getOutputStream: async function* () {},
        getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
        supportedCommands: async () => [],
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => ({ contextLimitTokens: 0, contextUsedTokens: 0 }),
        mcpServerStatus: async () => [],
        accountInfo: async () => ({ name: 'test', email: 'test@example.com' }),
      } as unknown as IAgentSession;

      // Distinct controller for this child — simulates AbortGraph cascade
      // by calling .abort() directly on it from outside, bypassing
      // handle.cancel() so currentStatus never transitions to 'cancelled'
      // before the catch block runs.
      const childController = new AbortController();
      const onTerminal = vi.fn();
      const handle = new SubagentHandleImpl(
        'cascade-test',
        session,
        childController,
        abortGraph,
        undefined,
        5000,
        undefined,
        onTerminal,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      const resultPromise = handle.runToResult('test');

      // Let the stream begin its hung await.
      await new Promise((r) => setImmediate(r));

      // Cascade: abort the child's controller directly. This is what
      // AbortGraph.abort() does for descendants (see abort-graph.ts:195).
      // handle.cancel() is NOT called.
      childController.abort(new Error('parent cascade'));

      // Release the hung promise so the stream can throw.
      holdResolve();

      const result = await resultPromise;
      expect(result.status).toBe('cancelled');
      expect(handle.status).toBe('cancelled');
    });

    it('classifies a cascaded TimeoutError abort as cancelled (inherited budget, not own)', async () => {
      // Regression guard for the isCascading origin-check (PR #596, #465
      // follow-up). An ANCESTOR's wall-clock timeout cascades down THROUGH the
      // AbortGraph: the child's node gets cascading=true and its controller is
      // aborted with the ancestor's TimeoutError reason (reused, unwrapped).
      // Even though the abort reason is a TimeoutError, this handle did not
      // blow its OWN budget — it was torn down externally — so it must
      // classify 'cancelled', not 'failed'. Without the isCascading guard the
      // TimeoutError reason alone would wrongly take the 'failed' branch.
      // NOTE: unlike the sibling direct-abort test above, this cascades via
      // localGraph.abort() so `cascading` is actually set — a bare
      // childController.abort(new TimeoutError(...)) would leave it false and
      // the fork WOULD be its own budget expiry.
      let holdResolve: () => void = () => {};
      const localGraph = new AbortGraph();
      const parentController = new AbortController();
      const childController = new AbortController();
      localGraph.register('cascade-timeout-parent', parentController);
      localGraph.register('cascade-timeout-child', childController);
      localGraph.linkChild('cascade-timeout-parent', 'cascade-timeout-child');

      const session: IAgentSession = {
        sessionId: 'mock-session',
        state: 'idle',
        abortSignal: childController.signal,
        async sendMessage() {
          return { role: 'assistant', content: '', timestamp: new Date() };
        },
        async *sendMessageStream() {
          // Hang until the test cascades the abort, then surface the abort
          // reason the same way a cut HTTP stream throws mid-iteration.
          await new Promise<void>((resolve) => {
            holdResolve = resolve;
          });
          if (childController.signal.aborted) {
            throw childController.signal.reason ?? new Error('aborted');
          }
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
        getQuery: () => {
          throw new Error('not implemented');
        },
        getLastResponseMetadata: () => null,
        getOutputStream: async function* () {},
        getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
        supportedCommands: async () => [],
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => ({ contextLimitTokens: 0, contextUsedTokens: 0 }),
        mcpServerStatus: async () => [],
        accountInfo: async () => ({ name: 'test', email: 'test@example.com' }),
      } as unknown as IAgentSession;

      const onTerminal = vi.fn();
      const handle = new SubagentHandleImpl(
        'cascade-timeout-child',
        session,
        childController,
        localGraph,
        undefined,
        // Large budget so withTimeout's own timer never fires during the test;
        // the abort arrives via the cascade below, not this handle's timer.
        5000,
        undefined,
        onTerminal,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      const resultPromise = handle.runToResult('test');

      // Let the stream begin its hung await.
      await new Promise((r) => setImmediate(r));

      // Cascade an ANCESTOR wall-clock timeout through the graph: the BFS in
      // abort() marks the child cascading=true and aborts childController with
      // this exact TimeoutError reason (see abort-graph.ts).
      localGraph.abort(
        'cascade-timeout-parent',
        new TimeoutError('parent budget', 1000),
        'timeout',
      );

      // Release the hung promise so the stream observes the abort and throws.
      holdResolve();

      const result = await resultPromise;
      expect(result.status).toBe('cancelled');
      expect(handle.status).toBe('cancelled');
    });

    // Canonical-timeout guard (PR: env-configurable timeout + observability).
    // Two invariants the trace consumers depend on:
    //   1. OWN wall-clock budget expiry → transition:'failed' + failureClass:
    //      'timeout' (a legible guillotined-by-budget signal, still 'failed' so
    //      the notifier injects the error).
    //   2. CASCADED ancestor-timeout → transition:'cancelled' + timeout:true
    //      (torn down externally; NOT reclassified to 'failed').
    // The classification (failed vs cancelled) is asserted elsewhere; here we
    // pin the ADDED annotations on the emitted lifecycle payloads.

    it("emits failed + failureClass:'timeout' when the handle blows its OWN budget", async () => {
      vi.useFakeTimers();
      try {
        const localGraph = new AbortGraph();
        const controller = new AbortController();
        localGraph.register('own-budget-child', controller);

        // Session that hangs forever — only the handle's own withTimeout timer
        // aborts it. No cascade (no ancestor in the graph aborts it).
        const session = {
          sessionId: 'mock-session',
          state: 'idle',
          abortSignal: controller.signal,
          async sendMessage() {
            return { role: 'assistant', content: '', timestamp: new Date() };
          },
          async *sendMessageStream() {
            await new Promise<void>((resolve, reject) => {
              controller.signal.addEventListener(
                'abort',
                () => reject(controller.signal.reason ?? new Error('aborted')),
                { once: true },
              );
              // never resolves on its own
              void resolve;
            });
          },
          async interrupt() {},
          async close() {},
          async reset() {},
          async setModel() {},
          async setPermissionMode() {},
          waitForInitialization: async () => ({ sessionId: 'mock-session', model: 'm', persistSession: true }),
          getSessionIdentity: () => ({ persistSession: true }),
          getSessionMetadata: () => ({ sessionId: 'mock-session', model: 'm', persistSession: true }),
          getQuery: () => { throw new Error('not implemented'); },
          getLastResponseMetadata: () => null,
          getOutputStream: async function* () {},
          getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
          supportedCommands: async () => [],
          supportedModels: async () => [],
          supportedAgents: async () => [],
          getContextUsage: async () => ({ contextLimitTokens: 0, contextUsedTokens: 0 }),
          mcpServerStatus: async () => [],
          accountInfo: async () => ({ name: 'test', email: 'test@example.com' }),
        } as unknown as IAgentSession;

        const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
        const traceWriter = {
          write: vi.fn(async (e: { kind: string; payload: Record<string, unknown> }) => {
            events.push(e);
          }),
          getTracePath: () => 'in-memory://trace',
        } as unknown as import('../trace/writer.js').TraceWriter;

        const handle = new SubagentHandleImpl(
          'own-budget-child',
          session,
          controller,
          localGraph,
          undefined,
          1000, // small OWN budget → withTimeout fires
          undefined,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          traceWriter, // position 14
        );

        const resultPromise = handle.runToResult('test');
        await vi.advanceTimersByTimeAsync(1000);
        const result = await resultPromise;

        expect(result.status).toBe('failed');
        expect(handle.status).toBe('failed');
        const failed = events.find(
          (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'failed',
        );
        expect(failed).toBeDefined();
        expect(failed!.payload.failureClass).toBe('timeout');
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits cancelled + timeout:true when a cascaded ancestor timeout tears it down', async () => {
      let holdResolve: () => void = () => {};
      const localGraph = new AbortGraph();
      const parentController = new AbortController();
      const childController = new AbortController();
      localGraph.register('cascade-to-parent', parentController);
      localGraph.register('cascade-to-child', childController);
      localGraph.linkChild('cascade-to-parent', 'cascade-to-child');

      const session = {
        sessionId: 'mock-session',
        state: 'idle',
        abortSignal: childController.signal,
        async sendMessage() {
          return { role: 'assistant', content: '', timestamp: new Date() };
        },
        async *sendMessageStream() {
          await new Promise<void>((resolve) => {
            holdResolve = resolve;
          });
          if (childController.signal.aborted) {
            throw childController.signal.reason ?? new Error('aborted');
          }
        },
        async interrupt() {},
        async close() {},
        async reset() {},
        async setModel() {},
        async setPermissionMode() {},
        waitForInitialization: async () => ({ sessionId: 'mock-session', model: 'm', persistSession: true }),
        getSessionIdentity: () => ({ persistSession: true }),
        getSessionMetadata: () => ({ sessionId: 'mock-session', model: 'm', persistSession: true }),
        getQuery: () => { throw new Error('not implemented'); },
        getLastResponseMetadata: () => null,
        getOutputStream: async function* () {},
        getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
        supportedCommands: async () => [],
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => ({ contextLimitTokens: 0, contextUsedTokens: 0 }),
        mcpServerStatus: async () => [],
        accountInfo: async () => ({ name: 'test', email: 'test@example.com' }),
      } as unknown as IAgentSession;

      const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
      const traceWriter = {
        write: vi.fn(async (e: { kind: string; payload: Record<string, unknown> }) => {
          events.push(e);
        }),
        getTracePath: () => 'in-memory://trace',
      } as unknown as import('../trace/writer.js').TraceWriter;

      const handle = new SubagentHandleImpl(
        'cascade-to-child',
        session,
        childController,
        localGraph,
        undefined,
        5000, // large OWN budget so only the cascade aborts it
        undefined,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        traceWriter, // position 14
      );

      const resultPromise = handle.runToResult('test');
      await new Promise((r) => setImmediate(r));
      // Cascade an ANCESTOR wall-clock timeout: BFS marks child cascading=true
      // and aborts childController with this TimeoutError reason.
      localGraph.abort('cascade-to-parent', new TimeoutError('parent budget', 1000), 'timeout');
      holdResolve();

      const result = await resultPromise;
      expect(result.status).toBe('cancelled');
      expect(handle.status).toBe('cancelled');
      const cancelled = events.find(
        (e) => e.kind === 'subagent_lifecycle' && e.payload.transition === 'cancelled',
      );
      expect(cancelled).toBeDefined();
      expect(cancelled!.payload.source).toBe('cascade');
      expect(cancelled!.payload.timeout).toBe(true);
    });
  });

  describe('Error event in stream propagates', () => {
    it('throws error event and calls sink before rejection', async () => {
      const sinkFn = vi.fn();
      const testError = new Error('upstream failure');
      const events: OutputEvent[] = [
        { type: 'progress', progress: { taskId: 'task-1', description: 'starting', totalTokens: 0, toolUses: 0, durationMs: 0 } },
        { type: 'error', error: testError },
      ];

      // When we encounter an error in the stream, we can't get a final message
      // The sink should still be called for all events seen before the error
      const session: IAgentSession = {
        sessionId: 'mock-session',
        state: 'idle',
        abortSignal: new AbortController().signal,
        async sendMessage() {
          return {
            role: 'assistant',
            content: '',
            timestamp: new Date(),
          };
        },
        async *sendMessageStream() {
          for (const event of events) {
            yield event;
          }
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
        getQuery: () => {
          throw new Error('not implemented');
        },
        getLastResponseMetadata: () => null,
        getOutputStream: async function* () {},
        getInputStreamRef: () => ({
          pushUserMessage: vi.fn(),
        }),
        supportedCommands: async () => [],
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => ({
          contextLimitTokens: 0,
          contextUsedTokens: 0,
        }),
        mcpServerStatus: async () => [],
        accountInfo: async () => ({
          name: 'test',
          email: 'test@example.com',
        }),
      } as unknown as IAgentSession;

      const handle = new SubagentHandleImpl(
        'error-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        sinkFn,
      );

      await expect(handle.run('test')).rejects.toThrow('upstream failure');

      // Sink should have been called for both events (before and including error)
      expect(sinkFn).toHaveBeenCalledTimes(2);
      expect(sinkFn.mock.calls[0][0]).toEqual(events[0]);
      expect(sinkFn.mock.calls[1][0]).toEqual(events[1]);

      expect(handle.status).toBe('failed');
    });
  });

  describe('AsyncLocalStorage ambient fallback', () => {
    it('uses ambient sink from AsyncLocalStorage when no explicit sink set', async () => {
      const ambientSink = vi.fn();
      const finalMessage: Message = {
        role: 'assistant',
        content: 'ambient test',
        timestamp: new Date(),
      };
      const events: OutputEvent[] = [
        { type: 'message', message: finalMessage },
        { type: 'done' },
      ];

      const session = createDeterministicMockSession(events, finalMessage);

      await runWithSink(ambientSink, async () => {
        const handle = new SubagentHandleImpl(
          'ambient-test',
          session,
          controller,
          abortGraph,
          undefined,
          5000,
          undefined,
          vi.fn(),
          // No explicit progressSink passed; should use ambient
        );

        const msg = await handle.run('test');

        expect(msg).toEqual(finalMessage);
        expect(ambientSink).toHaveBeenCalledTimes(2);
        expect(ambientSink.mock.calls[0][1].subagentId).toBe('ambient-test');
      });
    });

    it('outside runWithSink, no events go to sink', async () => {
      const finalMessage: Message = {
        role: 'assistant',
        content: 'outside context',
        timestamp: new Date(),
      };
      const events: OutputEvent[] = [
        { type: 'message', message: finalMessage },
        { type: 'done' },
      ];

      const session = createDeterministicMockSession(events, finalMessage);
      const handle = new SubagentHandleImpl(
        'outside-test',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      // No explicit progressSink, getCurrentSink() is undefined
      expect(getCurrentSink()).toBeUndefined();

      const msg = await handle.run('test');
      expect(msg).toEqual(finalMessage);

      // Verify no async errors or issues, just normal success
      expect(handle.status).toBe('succeeded');
    });
  });

  describe('Explicit option overrides ambient', () => {
    it('SubagentManager with explicit progressSink bypasses ambient', async () => {
      const ambientSink = vi.fn();
      const explicitSink = vi.fn();

      const finalMessage: Message = {
        role: 'assistant',
        content: 'explicit override',
        timestamp: new Date(),
      };
      const events: OutputEvent[] = [
        { type: 'message', message: finalMessage },
        { type: 'done' },
      ];

      const session = createDeterministicMockSession(events, finalMessage);

      await runWithSink(ambientSink, async () => {
        // Create handle with explicit sink passed to constructor
        const handle = new SubagentHandleImpl(
          'explicit-test',
          session,
          controller,
          abortGraph,
          undefined,
          5000,
          undefined,
          vi.fn(),
          undefined,
          undefined,
          undefined,
          explicitSink,
        );

        const msg = await handle.run('test');
        expect(msg).toEqual(finalMessage);

        // Only explicit sink should be called, not ambient
        expect(explicitSink).toHaveBeenCalled();
        expect(ambientSink).not.toHaveBeenCalled();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Partial-content preservation on the failure path.
  //
  // `run()` still throws on stream errors / aborts (existing contract). The
  // higher-level `runToResult()` is the surface the parent consumes, and it
  // now surfaces any assistant text accumulated before the failure as
  // `partialOutput` so the parent receives findings rather than just an
  // opaque error.
  // ---------------------------------------------------------------------------
  describe('runToResult preserves partial streamed content on failure', () => {
    it('captures streamed text as partialOutput when the stream errors', async () => {
      const streamError = new Error('upstream stream failure');
      const events: OutputEvent[] = [
        { type: 'chunk', chunk: { type: 'content', content: 'I was analyzing ' } },
        { type: 'chunk', chunk: { type: 'content', content: 'the user model' } },
        { type: 'error', error: streamError },
      ];

      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl(
        'partial-on-error',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const result = await handle.runToResult('p');

      expect(result.status).toBe('failed');
      expect(result.error?.message).toMatch(/upstream stream failure/);
      expect(result.partialOutput).toBe('I was analyzing the user model');
    });

    it('partialOutput is absent when no content was streamed before failure', async () => {
      const streamError = new Error('immediate failure');
      const events: OutputEvent[] = [{ type: 'error', error: streamError }];

      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl(
        'no-partial',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const result = await handle.runToResult('p');

      expect(result.status).toBe('failed');
      expect(result.partialOutput).toBeUndefined();
    });

    it('captures streamed text as partialOutput when the run is aborted mid-stream', async () => {
      const localGraph = new AbortGraph();
      const localController = new AbortController();
      // Register under the handle id so cancel() → abortGraph.abort(handle.id)
      // actually finds the node and fires the signal. (A common test mistake
      // is registering under a label like 'root' — abortGraph.abort silently
      // no-ops on unknown ids.)
      localGraph.register('abort-partial', localController);

      // Models the real anthropic-direct shape: when the controller's signal
      // fires, the underlying HTTP stream is cut and the async iterator
      // throws an AbortError mid-loop. The mock listens to the controller's
      // signal directly so the throw reaches handle.streamToFinalMessage,
      // which is the seam under test.
      const session: IAgentSession = {
        sessionId: 'mock-session',
        state: 'idle',
        abortSignal: localController.signal,
        async sendMessage() {
          return { role: 'assistant', content: '', timestamp: new Date() };
        },
        async *sendMessageStream() {
          yield { type: 'chunk', chunk: { type: 'content', content: 'starting work...' } };
          // Block until the signal fires, then throw — matches the SDK's
          // behavior of surfacing AbortError from a cancelled HTTP response.
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => {
              localController.signal.removeEventListener('abort', onAbort);
              reject(new DOMException('Aborted', 'AbortError'));
            };
            localController.signal.addEventListener('abort', onAbort, { once: true });
            // Safety: if the signal is already aborted, reject immediately.
            if (localController.signal.aborted) {
              localController.signal.removeEventListener('abort', onAbort);
              reject(new DOMException('Aborted', 'AbortError'));
            }
            // Also wire a resolve hook so the test can release the hold
            // without aborting if needed (unused here but keeps the shape
            // flexible).
            void resolve;
          });
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
        getQuery: () => {
          throw new Error('not implemented');
        },
        getLastResponseMetadata: () => null,
        getOutputStream: async function* () {},
        getInputStreamRef: () => ({ pushUserMessage: vi.fn() }),
        supportedCommands: async () => [],
        supportedModels: async () => [],
        supportedAgents: async () => [],
        getContextUsage: async () => ({ contextLimitTokens: 0, contextUsedTokens: 0 }),
        mcpServerStatus: async () => [],
        accountInfo: async () => ({ name: 'test', email: 'test@example.com' }),
      } as unknown as IAgentSession;

      const handle = new SubagentHandleImpl(
        'abort-partial',
        session,
        localController,
        localGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const runPromise = handle.runToResult('p');
      // Yield so the first chunk is consumed.
      await new Promise((r) => setImmediate(r));
      // Cancel — this aborts the controller and interrupts the session,
      // causing the iterator to return without a terminal message.
      await handle.cancel();
      const result = await runPromise;

      expect(result.status).toBe('cancelled');
      expect(result.partialOutput).toBe('starting work...');
    });

    it('partialOutput survives the structured-output schema path on failure', async () => {
      // When a schema-typed subagent fails mid-stream, the parent still sees
      // the raw streamed fragment under partialOutput. The fragment is not
      // schema-parsed — it's the best we have when structured output never
      // got a chance to render.
      const events: OutputEvent[] = [
        { type: 'chunk', chunk: { type: 'content', content: '{ "draft": "halfway' } },
        { type: 'error', error: new Error('connection reset') },
      ];

      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const handle = new SubagentHandleImpl<{ draft: string }>(
        'schema-partial',
        session,
        controller,
        abortGraph,
        // Note: schema would normally fail to parse the fragment; we still
        // surface the raw partial so the parent can see what was produced.
        undefined,
        5000,
        undefined,
        vi.fn(),
      );

      const result = await handle.runToResult('p');

      expect(result.status).toBe('failed');
      expect(result.partialOutput).toBe('{ "draft": "halfway');
    });

    it('partialOutput is a runtime string (not silently cast to T) on the failure path', async () => {
      // Regression guard for the TDZ/type-cast fix: on the failure path,
      // `partialOutput` must be a plain `string` — no `as unknown as T` cast.
      // Even when T is a structured type, the partial is raw streamed text.
      const events: OutputEvent[] = [
        { type: 'chunk', chunk: { type: 'content', content: 'partial text' } },
        { type: 'error', error: new Error('stream interrupted') },
      ];
      const session = createDeterministicMockSession(events, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      type MySchema = { value: number };
      const handle = new SubagentHandleImpl<MySchema>(
        'type-check-id',
        session,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );
      const result = await handle.runToResult('p');

      expect(result.status).toBe('failed');
      // At runtime, this must be a string — not a MySchema object.
      expect(typeof result.partialOutput).toBe('string');
      expect(result.partialOutput).toBe('partial text');
    });

    it('lastStreamedContent resets between runs so stale partials do not leak', async () => {
      // Reusing a handle across runs (or after a failed run followed by a
      // successful one in a sibling handle) must never carry state forward.
      // We model this by running once with content + error, then verifying
      // a second handle on the same graph starts fresh.
      const firstEvents: OutputEvent[] = [
        { type: 'chunk', chunk: { type: 'content', content: 'first run content' } },
        { type: 'error', error: new Error('first failure') },
      ];
      const firstSession = createDeterministicMockSession(firstEvents, {
        role: 'assistant',
        content: 'unused',
        timestamp: new Date(),
      });
      const firstHandle = new SubagentHandleImpl(
        'reset-test-1',
        firstSession,
        controller,
        abortGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );
      const firstResult = await firstHandle.runToResult('p');
      expect(firstResult.partialOutput).toBe('first run content');

      // A fresh handle must not inherit the previous handle's partial.
      const secondController = new AbortController();
      const secondGraph = new AbortGraph();
      secondGraph.register('second-root', secondController);
      const finalMessage: Message = {
        role: 'assistant',
        content: 'second run succeeded',
        timestamp: new Date(),
      };
      const secondEvents: OutputEvent[] = [
        { type: 'message', message: finalMessage },
        { type: 'done' },
      ];
      const secondSession = createDeterministicMockSession(secondEvents, finalMessage);
      const secondHandle = new SubagentHandleImpl(
        'reset-test-2',
        secondSession,
        secondController,
        secondGraph,
        undefined,
        5000,
        undefined,
        vi.fn(),
      );
      const secondResult = await secondHandle.runToResult('p');
      expect(secondResult.status).toBe('succeeded');
      expect(secondResult.partialOutput).toBeUndefined();
    });
  });

  describe('onSubagentSucceeded rollup callback (token + cost propagation)', () => {
    // Constructs a handle whose 15th positional arg (onSubagentSucceeded) is a
    // spy, runs it to a successful terminal message, and asserts the rollup
    // callback received the subagent's usage and the cost extracted from
    // `msg.metadata.totalCostUsd`. Guards the wiring behind the two Codex P2
    // findings on PR #637: (1) usage must propagate, (2) cost must propagate
    // instead of a hardcoded `undefined`.
    function buildHandleWithRollup(
      finalMessage: Message,
      onSubagentSucceeded: (usage: unknown, costUsd: number | undefined) => void,
      // The 'done' event carries Anthropic's snake_case usage map, which
      // handle.ts reconstructs into currentTrace.usage. Distinct from the
      // camelCase metadata.usage on the assistant Message.
      doneUsage?: Record<string, number>,
    ): SubagentHandleImpl {
      const cb = new AbortController();
      const graph = new AbortGraph();
      graph.register('rollup-root', cb);
      const events: OutputEvent[] = [
        { type: 'message', message: finalMessage },
        { type: 'done', metadata: { ...finalMessage.metadata, usage: doneUsage } },
      ];
      const session = createDeterministicMockSession(events, finalMessage);
      return new SubagentHandleImpl(
        'rollup-test',
        session,
        cb,
        graph,
        undefined, // outputSchema
        5000, // timeoutMs
        undefined, // hookRegistry
        vi.fn(), // onTerminal
        undefined, // parentInputStreamRef
        undefined, // parentAbortSignal
        undefined, // agentType
        undefined, // progressSink
        undefined, // parentId
        undefined, // traceWriter
        onSubagentSucceeded as ConstructorParameters<typeof SubagentHandleImpl>[14],
      );
    }

    it('forwards usage and cost from msg.metadata.totalCostUsd on success', async () => {
      const onSucceeded = vi.fn();
      const finalMessage: Message = {
        role: 'assistant',
        content: 'rollup response',
        timestamp: new Date(),
        metadata: {
          usage: { inputTokens: 120, outputTokens: 30 },
          totalCostUsd: 0.0042,
          stopReason: 'end_turn',
        },
      };

      const handle = buildHandleWithRollup(finalMessage, onSucceeded, {
        input_tokens: 120,
        output_tokens: 30,
      });
      await handle.run('p');

      expect(onSucceeded).toHaveBeenCalledTimes(1);
      const [usageArg, costArg] = onSucceeded.mock.calls[0]!;
      // currentTrace.usage is reconstructed from the 'done' event's usage map.
      expect(usageArg).toMatchObject({ inputTokens: 120, outputTokens: 30 });
      // Cost is extracted from the returned message's metadata, NOT hardcoded undefined.
      expect(costArg).toBeCloseTo(0.0042, 10);
    });

    it('forwards undefined cost when the provider reports no totalCostUsd', async () => {
      const onSucceeded = vi.fn();
      const finalMessage: Message = {
        role: 'assistant',
        content: 'no-cost response',
        timestamp: new Date(),
        metadata: {
          usage: { inputTokens: 50, outputTokens: 10 },
          stopReason: 'end_turn',
          // totalCostUsd intentionally absent (e.g. backend without pricing data)
        },
      };

      const handle = buildHandleWithRollup(finalMessage, onSucceeded);
      await handle.run('p');

      expect(onSucceeded).toHaveBeenCalledTimes(1);
      const costArg = onSucceeded.mock.calls[0]![1];
      expect(costArg).toBeUndefined();
    });

    it('does not invoke the rollup callback on a failed run', async () => {
      const onSucceeded = vi.fn();
      const cb = new AbortController();
      const graph = new AbortGraph();
      graph.register('rollup-fail-root', cb);
      const failSession = createDeterministicMockSession(
        [{ type: 'error', error: new Error('boom') }],
        { role: 'assistant', content: '', timestamp: new Date() },
      );
      const handle = new SubagentHandleImpl(
        'rollup-fail',
        failSession,
        cb,
        graph,
        undefined,
        5000,
        undefined,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onSucceeded as ConstructorParameters<typeof SubagentHandleImpl>[14],
      );

      await expect(handle.run('p')).rejects.toThrow();
      expect(onSucceeded).not.toHaveBeenCalled();
    });
  });
});
