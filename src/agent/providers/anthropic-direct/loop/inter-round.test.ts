/**
 * Unit tests for applyBeforeNextRound (inter-round steering injection).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunTurnInput } from '../request-types.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources';

// Mock the trace emitter so tests don't need a real TraceSink.
vi.mock('../../../trace/emit.js', () => ({
  emitQueuedUserMessage: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks are established.
const { applyBeforeNextRound } = await import('./inter-round.js');
const { emitQueuedUserMessage } = await import('../../../trace/emit.js');

function makeInput(lastMessage: MessageParam): RunTurnInput {
  return {
    client: {} as RunTurnInput['client'],
    messages: [lastMessage],
    system: null,
    tools: null,
    toolDispatcher: {} as RunTurnInput['toolDispatcher'],
    model: 'claude-3-5-sonnet-20241022',
    maxTokens: 1024,
    headers: {},
    signal: new AbortController().signal,
    ctx: {} as RunTurnInput['ctx'],
    subagentId: 'sub-test-123',
  };
}

describe('applyBeforeNextRound', () => {
  beforeEach(() => {
    vi.mocked(emitQueuedUserMessage).mockClear();
  });

  it('appends a text block to the last message when steeringText is non-empty', () => {
    const lastMsg: MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
    };
    const input = makeInput(lastMsg);
    applyBeforeNextRound(input, 'focus on auth module');

    expect(Array.isArray(lastMsg.content)).toBe(true);
    const content = lastMsg.content as Array<{ type: string; text?: string }>;
    expect(content.at(-1)).toEqual({ type: 'text', text: 'focus on auth module' });
    expect(content).toHaveLength(2);
  });

  it('is a no-op when steeringText is undefined', () => {
    const lastMsg: MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'ok' }],
    };
    const input = makeInput(lastMsg);
    applyBeforeNextRound(input, undefined);

    const content = lastMsg.content as unknown[];
    expect(content).toHaveLength(1);
    expect(emitQueuedUserMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when steeringText is an empty string', () => {
    const lastMsg: MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-3', content: 'ok' }],
    };
    const input = makeInput(lastMsg);
    applyBeforeNextRound(input, '');

    const content = lastMsg.content as unknown[];
    expect(content).toHaveLength(1);
    expect(emitQueuedUserMessage).not.toHaveBeenCalled();
  });

  it('fires emitQueuedUserMessage with correct byteLength when text is non-empty', () => {
    const text = 'redirect to security audit';
    const lastMsg: MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-4', content: 'ok' }],
    };
    const input = makeInput(lastMsg);
    applyBeforeNextRound(input, text);

    expect(emitQueuedUserMessage).toHaveBeenCalledOnce();
    const [, payload] = vi.mocked(emitQueuedUserMessage).mock.calls[0]!;
    expect(payload.byteLength).toBe(Buffer.byteLength(text, 'utf8'));
    expect(payload.subagentId).toBe('sub-test-123');
  });

  it('does NOT fire emitQueuedUserMessage when steeringText is empty/undefined', () => {
    const lastMsg: MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-5', content: 'ok' }],
    };
    applyBeforeNextRound(makeInput(lastMsg), undefined);
    applyBeforeNextRound(makeInput(lastMsg), '');
    expect(emitQueuedUserMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when messages array is empty', () => {
    const input = makeInput({ role: 'user', content: [] });
    input.messages = [];
    // Should not throw.
    expect(() => applyBeforeNextRound(input, 'hello')).not.toThrow();
    expect(emitQueuedUserMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when the last message is from the assistant (not user)', () => {
    const lastMsg: MessageParam = {
      role: 'assistant',
      content: [{ type: 'text', text: 'I will now call a tool.' }],
    };
    const input = makeInput(lastMsg);
    applyBeforeNextRound(input, 'redirect now');

    const content = lastMsg.content as unknown[];
    expect(content).toHaveLength(1);
    expect(emitQueuedUserMessage).not.toHaveBeenCalled();
  });

  it('handles string content by converting to array (defensive branch)', () => {
    // This branch should not fire at tool_result boundary, but the guard exists
    // to avoid corrupting messages if it ever does.
    const lastMsg = { role: 'user' as const, content: 'plain string content' };
    const input = makeInput(lastMsg as unknown as MessageParam);
    applyBeforeNextRound(input, 'steering');

    const content = (lastMsg as unknown as { content: unknown[] }).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(2);
    expect(content.at(-1)).toEqual({ type: 'text', text: 'steering' });
  });
});
