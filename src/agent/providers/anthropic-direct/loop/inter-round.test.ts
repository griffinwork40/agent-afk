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

  it('pushes a NEW user turn (not an in-place mutation) when steeringText is non-empty', () => {
    const lastMsg: MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }],
    };
    const input = makeInput(lastMsg);
    applyBeforeNextRound(input, 'focus on auth module');

    // The original tool_result message must be UNCHANGED (JournalSync detects
    // new pushes by reference; in-place mutations are invisible to the journal).
    const originalContent = lastMsg.content as Array<{ type: string }>;
    expect(originalContent).toHaveLength(1);
    expect(originalContent[0]!.type).toBe('tool_result');

    // A fresh user turn was pushed after the tool_result turn.
    expect(input.messages).toHaveLength(2);
    const newTurn = input.messages[1] as MessageParam;
    expect(newTurn.role).toBe('user');
    const newContent = newTurn.content as Array<{ type: string; text: string }>;
    expect(newContent).toHaveLength(1);
    expect(newContent[0]).toEqual({ type: 'text', text: 'focus on auth module' });
  });

  it('is a no-op when steeringText is undefined', () => {
    const lastMsg: MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'ok' }],
    };
    const input = makeInput(lastMsg);
    applyBeforeNextRound(input, undefined);

    // No extra turn pushed.
    expect(input.messages).toHaveLength(1);
    expect(emitQueuedUserMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when steeringText is an empty string', () => {
    const lastMsg: MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu-3', content: 'ok' }],
    };
    const input = makeInput(lastMsg);
    applyBeforeNextRound(input, '');

    // No extra turn pushed.
    expect(input.messages).toHaveLength(1);
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

    // No extra turn pushed, original unchanged.
    expect(input.messages).toHaveLength(1);
    expect(emitQueuedUserMessage).not.toHaveBeenCalled();
  });

  it('pushes a fresh user turn even when last message has string content', () => {
    // A string-content user turn: the guard allows it (role === 'user'), and we
    // push a separate new user turn for the steering text rather than mutating.
    const lastMsg = { role: 'user' as const, content: 'plain string content' };
    const input = makeInput(lastMsg as unknown as MessageParam);
    applyBeforeNextRound(input, 'steering');

    // Original message is UNCHANGED.
    expect(lastMsg.content).toBe('plain string content');
    // A new turn was pushed.
    expect(input.messages).toHaveLength(2);
    const newTurn = input.messages[1] as MessageParam;
    expect(newTurn.role).toBe('user');
    const newContent = newTurn.content as Array<{ type: string; text: string }>;
    expect(newContent[0]).toEqual({ type: 'text', text: 'steering' });
  });
});
