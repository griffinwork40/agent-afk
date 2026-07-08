/**
 * Regression test for M1 — "lost terminal trace event".
 *
 * Symptom: a `subagent_lifecycle` `started` event with no matching terminal
 * event (`succeeded`/`failed`/`cancelled`) — an "orphan" record. Measured at
 * ~320/1166 subagents, mostly short-lived skill sessions. The subagents ran
 * fine; only the witness audit record was lost.
 *
 * Root cause: the terminal lifecycle emit in `SubagentHandleImpl.run()` was
 * fire-and-forget (`void emitSubagentLifecycle(...)`). `emitSubagentLifecycle`
 * internally `await writer.write(...)`, but because the emit itself was not
 * awaited, `run()` proceeded to `onTerminal()` (which can trigger the owning
 * session's immediate `writer.seal()`) before the terminal `write()` reached
 * the writer. `NdjsonTraceWriter.seal()` flips `sealed = true` synchronously
 * and a subsequent `write()` throws `'trace is sealed; write() rejected'`,
 * which `emitSubagentLifecycle` swallows — the terminal event is silently lost.
 *
 * Fix: `await` the terminal emit in `run()` (success and catch paths) so the
 * event is enqueued+persisted on the writer's FIFO queue BEFORE `onTerminal()`
 * can seal.
 *
 * Invariant locked here: `handle.runToResult(...)` (equivalently `run()`) does
 * NOT resolve until the terminal `subagent_lifecycle` event has been durably
 * written. Concretely — if the owning session seals its trace the instant
 * `runToResult` resolves, the terminal event still survives ahead of the seal.
 *
 * Determinism note: with the REAL writer, `void emit`'s `writer.write()` call
 * runs synchronously and enqueues the append onto the FIFO queue before the
 * caller can seal, so a naive "await runToResult → await seal → assert present"
 * test is GREEN on both the buggy and fixed code — it does not lock the fix.
 * The production race only manifests when the terminal write reaches the writer
 * *late* (real async scheduling delays it past the moment `seal()` flips
 * `sealed`). We reproduce that gap DETERMINISTICALLY with a thin proxy writer
 * (`DeferringTraceWriter`) whose `write()` yields to a macrotask before
 * delegating to a real `NdjsonTraceWriter.write()`. `emitSubagentLifecycle`,
 * `writer.seal()`, and `writer.write()` themselves are UNMODIFIED — only the
 * *arrival time* of the write at the writer is delayed, exactly as it is in
 * production. Under this proxy:
 *   - buggy `void` code: run() returns before the deferred write lands; the
 *     owning session seals; the late write() throws → swallowed → event LOST.
 *   - fixed `await` code: run() awaits the emit → the deferred write completes
 *     and persists BEFORE run() returns; the seal comes after → event PRESENT.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IAgentSession, Message, OutputEvent } from '../types.js';
import { SubagentHandleImpl } from '../subagent/handle.js';
import { AbortGraph } from '../abort-graph.js';
import { NdjsonTraceWriter } from './writer.js';
import type { TraceWriter } from './index.js';
import type { SessionSealedPayload, TraceEventInput } from './types.js';

/**
 * Wraps a real {@link NdjsonTraceWriter} but defers each `write()` to a
 * macrotask before delegating. This models the production timing gap where the
 * terminal lifecycle write reaches the writer AFTER the owning session has
 * begun sealing — the exact window the M1 bug lived in. `seal()`/`close()` are
 * NOT deferred (a real teardown seals promptly), so a `write()` that was fired
 * fire-and-forget lands after `sealed` has flipped and is rejected — precisely
 * the lost-event path. Delegates to the unmodified real writer for all durable
 * behavior; only arrival timing is altered.
 */
class DeferringTraceWriter implements TraceWriter {
  constructor(private readonly inner: NdjsonTraceWriter) {}

  async write(event: TraceEventInput): Promise<void> {
    // Yield to a macrotask so the caller's synchronous continuation (and, in
    // the buggy fire-and-forget path, the owning session's immediate seal) runs
    // before the real write is even attempted.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return this.inner.write(event);
  }

  getTracePath(): string {
    return this.inner.getTracePath();
  }

  async seal(payload: SessionSealedPayload): Promise<void> {
    return this.inner.seal(payload);
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}

function mockSucceedingSession(finalMessage: Message): IAgentSession {
  const events: OutputEvent[] = [
    { type: 'message', message: finalMessage },
    { type: 'done', metadata: { stopReason: 'end_turn' } },
  ];
  return {
    sessionId: 'mock-session',
    state: 'idle',
    abortSignal: new AbortController().signal,
    async sendMessage() {
      return finalMessage;
    },
    async *sendMessageStream() {
      for (const e of events) yield e;
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
}

describe('M1 — terminal subagent_lifecycle survives an immediate seal', () => {
  it('persists the succeeded event before the owning session seals (deferred-write race)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afk-trace-seal-race-'));
    try {
      const inner = new NdjsonTraceWriter({ traceDir: dir });
      // Deferring proxy reproduces the production timing gap deterministically.
      const writer = new DeferringTraceWriter(inner);

      const graph = new AbortGraph();
      const controller = new AbortController();
      graph.register('root', controller);

      const finalMessage: Message = {
        role: 'assistant',
        content: 'subagent result',
        timestamp: new Date(),
      };
      const session = mockSucceedingSession(finalMessage);

      const handle = new SubagentHandleImpl(
        'sa-seal-race',
        session,
        controller,
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
        writer, // traceWriter
      );

      const result = await handle.runToResult('go');
      expect(result.status).toBe('succeeded');

      // Owning session seals the instant runToResult resolves — the exact race
      // window. With the buggy `void` emit the terminal write is still in-flight
      // (deferred) and lands after `sealed` flips, so it is rejected+swallowed.
      // With the awaited fix it has already been persisted.
      await writer.seal({
        status: 'succeeded',
        finalCostUsd: 0,
        finalTurnCount: 1,
        closedAt: new Date().toISOString(),
      });

      const content = await readFile(join(dir, 'trace.jsonl'), 'utf8');
      const lines = content
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> });

      const succeeded = lines.find(
        (l) => l.kind === 'subagent_lifecycle' && l.payload['transition'] === 'succeeded',
      );

      expect(
        succeeded,
        'terminal subagent_lifecycle.succeeded must be persisted before the seal (M1 regression)',
      ).toBeDefined();
      expect(succeeded?.payload['subagentId']).toBe('sa-seal-race');

      // And it must precede the terminal session_sealed record on disk.
      const succeededIdx = lines.findIndex(
        (l) => l.kind === 'subagent_lifecycle' && l.payload['transition'] === 'succeeded',
      );
      const sealedIdx = lines.findIndex((l) => l.kind === 'session_sealed');
      expect(succeededIdx).toBeGreaterThanOrEqual(0);
      expect(sealedIdx).toBeGreaterThan(succeededIdx);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
