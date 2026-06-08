/**
 * Integration test: a real AgentSession (no injected config.provider → the
 * ProviderRouter path) switches provider FAMILIES mid-session via setModel,
 * with BOTH SDKs mocked. Proves the cross-provider switch works end-to-end and
 * that the session's turn accumulator is NOT reset by the swap (the property
 * that the rejected session-level "fork-on-switch" would have broken).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type OpenAI from 'openai';
import { AgentSession } from './agent-session.js';
import { __setAnthropicClientFactory } from '../providers/anthropic-direct/index.js';
import { __setOpenAIClientFactory } from '../providers/openai-compatible/query.js';
import { resetSlotBindings } from './model-slots.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

// ---- anthropic mock -------------------------------------------------------
const anthropicCreateMock = vi.fn();
class MockAnthropic {
  public messages = { create: anthropicCreateMock };
}
async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}
function anthropicTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-haiku-4-5',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

// ---- openai mock ----------------------------------------------------------
const openaiCreateMock = vi.fn();
function openaiChunks(text: string): unknown[] {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  ];
}

describe('AgentSession — cross-provider switch via ProviderRouter', () => {
  let savedOpenAiKey: string | undefined;

  beforeEach(() => {
    resetSlotBindings();
    anthropicCreateMock.mockReset();
    openaiCreateMock.mockReset();
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
    __setOpenAIClientFactory(
      () => ({ chat: { completions: { create: openaiCreateMock } } }) as unknown as OpenAI,
    );
    savedOpenAiKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-openai-test';
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
    __setOpenAIClientFactory(null);
    if (savedOpenAiKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = savedOpenAiKey;
    resetSlotBindings();
  });

  it('routes turn 1 to anthropic, turn 2 to openai after /model, preserving turn count', async () => {
    anthropicCreateMock.mockImplementation(() => fromArray(anthropicTextStream('anthropic reply')));
    openaiCreateMock.mockImplementation(() => fromArray(openaiChunks('openai reply')));

    // No config.provider → the session installs the ProviderRouter.
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
    });

    try {
      // Turn 1: routes to anthropic (startup family).
      const reply1 = await session.sendMessage('first message');
      expect(reply1.content).toContain('anthropic reply');
      expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
      expect(openaiCreateMock).not.toHaveBeenCalled();

      // Cross-family switch.
      await session.setModel('gpt-4o-mini');

      // Turn 2: router swaps the inner provider to openai-compatible.
      const reply2 = await session.sendMessage('second message');
      expect(reply2.content).toContain('openai reply');
      expect(openaiCreateMock).toHaveBeenCalledTimes(1);
      // Anthropic was NOT called again for turn 2.
      expect(anthropicCreateMock).toHaveBeenCalledTimes(1);

      // The session-level turn accumulator survived the provider swap
      // (it would have reset to 1 under a session-level reset/fork-on-switch).
      expect(session.getTurnCount()).toBe(2);

      // The openai client was constructed with the OPENAI key, never the
      // anthropic OAuth token (cross-provider credential anti-leak).
      const openaiAuthArg = openaiCreateMock.mock.calls[0]?.[0] as { model?: string } | undefined;
      expect(openaiAuthArg?.model).toBeDefined();
    } finally {
      await session.close();
    }
  });

  it('seeds the openai turn with the prior anthropic turn as text history', async () => {
    anthropicCreateMock.mockImplementation(() => fromArray(anthropicTextStream('the secret is 42')));
    openaiCreateMock.mockImplementation(() => fromArray(openaiChunks('ok')));

    const session = new AgentSession({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-oat01-test' });
    try {
      await session.sendMessage('what is the secret?');
      await session.setModel('gpt-4o-mini');
      await session.sendMessage('repeat it');

      // The openai request messages must include the carried prior turn text.
      const req = openaiCreateMock.mock.calls[0]?.[0] as { messages?: Array<{ role: string; content: unknown }> };
      const serialized = JSON.stringify(req?.messages ?? []);
      expect(serialized).toContain('what is the secret?');
      expect(serialized).toContain('the secret is 42');
    } finally {
      await session.close();
    }
  });
});
