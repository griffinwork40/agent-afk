import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IAgentSession, Message, OutputEvent } from '../types.js';
import { SubagentHandleImpl } from './handle.js';
import { AbortGraph } from '../abort-graph.js';

function createMockSession(events: OutputEvent[]): IAgentSession {
  return {
    sessionId: 'mock-session',
    state: 'idle',
    abortSignal: new AbortController().signal,
    async sendMessage() {
      return { role: 'assistant', content: '', timestamp: new Date() };
    },
    async *sendMessageStream() {
      for (const event of events) yield event;
    },
    async interrupt() {},
    async close() {},
    async reset() {},
    async setModel() {},
    async setPermissionMode() {},
    waitForInitialization: async () => ({ sessionId: 'mock-session', model: 'test', persistSession: true }),
    getSessionIdentity: () => ({ persistSession: true }),
    getSessionMetadata: () => ({ sessionId: 'mock-session', model: 'test', persistSession: true }),
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

describe('SubagentTrace collection', () => {
  const abortGraph = new AbortGraph();
  const controller = new AbortController();

  beforeEach(() => {
    abortGraph.register('root', controller);
  });

  it('collects tool_use_detail chunks into trace.toolCalls', async () => {
    const finalMessage: Message = { role: 'assistant', content: 'done', timestamp: new Date() };
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'tu_1', toolName: 'Read', toolInput: '{"file": "foo.ts"}' } },
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'tu_2', toolName: 'Bash', toolInput: '{"command": "ls"}' } },
      { type: 'message', message: finalMessage },
      { type: 'done' },
    ];

    const session = createMockSession(events);
    const handle = new SubagentHandleImpl('trace-tool-test', session, controller, abortGraph, undefined, 5000, undefined, vi.fn());

    const result = await handle.runToResult('test');

    expect(result.trace).toBeDefined();
    expect(result.trace!.toolCalls).toHaveLength(2);
    expect(result.trace!.toolCalls[0]).toEqual({ id: 'tu_1', name: 'Read', inputBytes: 18 });
    expect(result.trace!.toolCalls[1]).toEqual({ id: 'tu_2', name: 'Bash', inputBytes: 17 });
  });

  it('collects tool_result chunks into trace.toolResults', async () => {
    const finalMessage: Message = { role: 'assistant', content: 'done', timestamp: new Date() };
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'tu_1', toolName: 'Read', toolInput: '{}' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'tu_1', content: 'file contents', sizeBytes: 1024 } },
      { type: 'message', message: finalMessage },
      { type: 'done' },
    ];

    const session = createMockSession(events);
    const handle = new SubagentHandleImpl('trace-result-test', session, controller, abortGraph, undefined, 5000, undefined, vi.fn());

    const result = await handle.runToResult('test');

    expect(result.trace!.toolResults).toHaveLength(1);
    expect(result.trace!.toolResults[0]).toEqual({
      toolUseId: 'tu_1',
      isError: undefined,
      truncated: undefined,
      sizeBytes: 1024,
    });
  });

  it('detects thinking presence', async () => {
    const finalMessage: Message = { role: 'assistant', content: 'thought about it', timestamp: new Date() };
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'thinking', content: 'Let me think...' } },
      { type: 'chunk', chunk: { type: 'content', content: 'thought about it' } },
      { type: 'message', message: finalMessage },
      { type: 'done' },
    ];

    const session = createMockSession(events);
    const handle = new SubagentHandleImpl('trace-thinking-test', session, controller, abortGraph, undefined, 5000, undefined, vi.fn());

    const result = await handle.runToResult('test');

    expect(result.trace!.thinkingPresent).toBe(true);
  });

  it('sets thinkingPresent=false when no thinking chunks', async () => {
    const finalMessage: Message = { role: 'assistant', content: 'quick reply', timestamp: new Date() };
    const events: OutputEvent[] = [
      { type: 'message', message: finalMessage },
      { type: 'done' },
    ];

    const session = createMockSession(events);
    const handle = new SubagentHandleImpl('trace-no-thinking-test', session, controller, abortGraph, undefined, 5000, undefined, vi.fn());

    const result = await handle.runToResult('test');

    expect(result.trace!.thinkingPresent).toBe(false);
  });

  it('captures usage from done event metadata', async () => {
    const finalMessage: Message = { role: 'assistant', content: 'done', timestamp: new Date() };
    const events: OutputEvent[] = [
      { type: 'message', message: finalMessage },
      {
        type: 'done',
        metadata: {
          usage: {
            input_tokens: 1500,
            output_tokens: 300,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
          },
        },
      },
    ];

    const session = createMockSession(events);
    const handle = new SubagentHandleImpl('trace-usage-test', session, controller, abortGraph, undefined, 5000, undefined, vi.fn());

    const result = await handle.runToResult('test');

    expect(result.trace!.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 300,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
    });
  });

  it('leaves trace.usage undefined when done event carries a malformed usage payload', async () => {
    const finalMessage: Message = { role: 'assistant', content: 'done', timestamp: new Date() };
    const events: OutputEvent[] = [
      { type: 'message', message: finalMessage },
      {
        type: 'done',
        metadata: {
          // Non-object usage values must not produce an all-undefined usage object.
          usage: 42 as unknown as Record<string, unknown>,
        },
      },
    ];

    const session = createMockSession(events);
    const handle = new SubagentHandleImpl('trace-bad-usage-test', session, controller, abortGraph, undefined, 5000, undefined, vi.fn());

    const result = await handle.runToResult('test');

    // Guard (M1): malformed usage must be skipped entirely — trace.usage stays absent.
    expect(result.trace!.usage).toBeUndefined();
  });

  it('sets turnCount to 1 for a single-turn subagent', async () => {
    const finalMessage: Message = { role: 'assistant', content: 'done', timestamp: new Date() };
    const events: OutputEvent[] = [
      { type: 'message', message: finalMessage },
      { type: 'done' },
    ];

    const session = createMockSession(events);
    const handle = new SubagentHandleImpl('trace-turn-test', session, controller, abortGraph, undefined, 5000, undefined, vi.fn());

    const result = await handle.runToResult('test');

    expect(result.trace!.turnCount).toBe(1);
  });

  it('preserves trace on error path', async () => {
    const finalMessage: Message = { role: 'assistant', content: 'partial', timestamp: new Date() };
    const streamError = new Error('stream died');
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'tu_1', toolName: 'Bash', toolInput: '{}' } },
      // A message event fires before the error so that the turn is counted.
      { type: 'message', message: finalMessage },
      { type: 'error', error: streamError },
    ];

    const session = createMockSession(events);
    const handle = new SubagentHandleImpl('trace-error-test', session, controller, abortGraph, undefined, 5000, undefined, vi.fn());

    const result = await handle.runToResult('test');

    expect(result.status).toBe('failed');
    expect(result.trace).toBeDefined();
    expect(result.trace!.toolCalls).toHaveLength(1);
    expect(result.trace!.toolCalls[0]!.name).toBe('Bash');
    // turnCount reflects the completed turn even on the error path (H1 fix).
    expect(result.trace!.turnCount).toBe(1);
  });

  it('marks tool_result isError when present', async () => {
    const finalMessage: Message = { role: 'assistant', content: 'error handled', timestamp: new Date() };
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'tu_1', toolName: 'Bash', toolInput: '{}' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'tu_1', content: 'command failed', isError: true } },
      { type: 'message', message: finalMessage },
      { type: 'done' },
    ];

    const session = createMockSession(events);
    const handle = new SubagentHandleImpl('trace-error-result-test', session, controller, abortGraph, undefined, 5000, undefined, vi.fn());

    const result = await handle.runToResult('test');

    expect(result.trace!.toolResults[0]!.isError).toBe(true);
  });
});
