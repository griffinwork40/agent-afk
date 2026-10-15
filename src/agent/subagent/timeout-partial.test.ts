/**
 * Regression test: a child killed by its OWN hard budget while a model request
 * is still pending must return an accurate, recoverable incomplete result.
 *
 * History: 2026-09-28, a compose child spent 45 min gathering evidence (48 tool
 * results, no assistant text — every block was tool_use) and was hard-killed
 * with a model request in flight. The parent received only
 * "Operation timed out after 2700000ms" with `partialOutput` absent, because
 * the empty-buffer partial synthesis only ran for StreamIncompleteError. The
 * parent could not tell "timed out after gathering 48 results" from "timed out
 * doing nothing". See turn-budget-replay.test.ts for why the soft deadline had
 * not fired first.
 *
 * The hard deadline itself must stay enforced: the result resolves at the
 * budget, not later.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IAgentSession, OutputEvent } from '../types.js';
import { SubagentHandleImpl } from './handle.js';
import { AbortGraph } from '../abort-graph.js';

function hangingAfter(events: OutputEvent[], signal: AbortSignal): IAgentSession {
  return {
    sessionId: 'mock-session',
    state: 'idle',
    abortSignal: signal,
    async sendMessage() {
      return { role: 'assistant', content: '', timestamp: new Date() };
    },
    async *sendMessageStream() {
      for (const e of events) yield e;
      // The next model request never returns a first byte.
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
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
}

function toolRound(id: string, name: string, sizeBytes: number): OutputEvent[] {
  return [
    { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: id, toolName: name, toolInput: '{"secret":"x"}' } },
    { type: 'chunk', chunk: { type: 'tool_result', toolUseId: id, isError: false, truncated: false, sizeBytes, content: 'r' } },
  ] as unknown as OutputEvent[];
}

describe('subagent hard-budget timeout with a request in flight', () => {
  it('enforces the hard deadline and returns an accurate timeout partial naming the gathered evidence', async () => {
    vi.useFakeTimers();
    try {
      const graph = new AbortGraph();
      const controller = new AbortController();
      graph.register('slow-child', controller);
      const events = [
        ...toolRound('t1', 'bash', 1_000),
        ...toolRound('t2', 'bash', 2_000),
        ...toolRound('t3', 'read_file', 500),
      ];
      const handle = new SubagentHandleImpl(
        'slow-child',
        hangingAfter(events, controller.signal),
        controller,
        graph,
        undefined,
        1000, // own hard budget
        undefined,
        vi.fn(),
      );

      let settled = false;
      const p = handle.runToResult('investigate').then((r) => { settled = true; return r; });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false); // not before the budget
      await vi.advanceTimersByTimeAsync(1);
      const result = await p;

      expect(result.status).toBe('failed');
      expect(result.error?.name).toBe('TimeoutError');
      expect(typeof result.partialOutput).toBe('string');
      const partial = result.partialOutput as string;
      expect(partial).toMatch(/hard (time|wall-clock) budget|timed out/i);
      expect(partial).toContain('3 tool result');
      expect(partial).toMatch(/no final answer/i);
      expect(partial).toContain('bash ×2');
      expect(partial).toContain('read_file ×1');
      // Privacy: tool inputs are never echoed.
      expect(partial).not.toContain('secret');
      // Evidence stays on the result for programmatic recovery.
      expect(result.trace.toolResults).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a timeout with no gathered evidence says so and carries no fabricated partial', async () => {
    vi.useFakeTimers();
    try {
      const graph = new AbortGraph();
      const controller = new AbortController();
      graph.register('empty-child', controller);
      const handle = new SubagentHandleImpl(
        'empty-child', hangingAfter([], controller.signal), controller, graph, undefined, 1000, undefined, vi.fn(),
      );
      const p = handle.runToResult('x');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await p;
      expect(result.status).toBe('failed');
      expect(result.error?.name).toBe('TimeoutError');
      expect(result.partialOutput).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
