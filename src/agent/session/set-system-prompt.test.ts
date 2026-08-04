/**
 * Live AgentSession.setSystemPrompt() propagation test — the end-to-end proof
 * for the `/afk-md` hot-reload feature.
 *
 * Verifies the full chain, not the wiring in isolation:
 *   session.setSystemPrompt(newPrompt)
 *     → ProviderQuery.setSystemPrompt(newPrompt)
 *       → AnthropicDirectQuery.setSystemPrompt()   [re-assembles via the rebuild factory]
 *         → next turn's messages.create() system carries the NEW prompt
 *
 * Structured as a deliberate sibling of the T19 setCwd test in
 * `agent-session.test.ts` (same stubbed-client harness), because the two share a
 * failure mode: a mid-session rebuild that mutates the wrong copy of the shared
 * prompt parts looks correct in a unit test and silently reverts on the next
 * turn. The composition case below (setSystemPrompt then setCwd) is the one a
 * copy-based implementation fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { AgentSession } from './agent-session.js';
import {
  AnthropicDirectProvider,
  __setAnthropicClientFactory,
} from '../providers/anthropic-direct/index.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

function makeTextStream(text: string): RawMessageStreamEvent[] {
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
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function extractSystemText(systemArg: unknown): string {
  if (typeof systemArg === 'string') return systemArg;
  if (!Array.isArray(systemArg)) return '';
  return (systemArg as ContentBlockParam[])
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

function systemOfCall(n: number): string {
  return extractSystemText((messagesCreateMock.mock.calls[n]![0] as { system?: unknown }).system);
}

describe('AgentSession.setSystemPrompt() — live session propagation', () => {
  const OLD_PROMPT = 'FRAMEWORK-BASE\n\n# Operator configuration\n\nOLD-OVERLAY-MARKER';
  const NEW_PROMPT = 'FRAMEWORK-BASE\n\n# Operator configuration\n\nNEW-OVERLAY-MARKER';
  const CWD = '/fixture/workspace';

  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
    vi.restoreAllMocks();
  });

  function makeSession(): AgentSession {
    return new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
      cwd: CWD,
      systemPrompt: OLD_PROMPT,
      provider: new AnthropicDirectProvider(),
    });
  }

  it('makes the NEXT turn send the new prompt, and reports that it applied', async () => {
    messagesCreateMock
      .mockImplementationOnce(() => fromArray(makeTextStream('one')))
      .mockImplementationOnce(() => fromArray(makeTextStream('two')));
    const session = makeSession();

    try {
      await session.sendMessage('first');
      expect(systemOfCall(0)).toContain('OLD-OVERLAY-MARKER');

      const applied = session.setSystemPrompt(NEW_PROMPT);
      expect(applied).toBe(true);

      await session.sendMessage('second');
      const turn2 = systemOfCall(1);
      expect(turn2).toContain('NEW-OVERLAY-MARKER');
      expect(turn2).not.toContain('OLD-OVERLAY-MARKER');
      // The framework doctrine must survive the swap — losing it is the
      // catastrophic failure mode of passing a bare overlay.
      expect(turn2).toContain('FRAMEWORK-BASE');
      expect(turn2).toContain('Working directory');
    } finally {
      await session.close();
    }
  });

  it('does not wipe conversation history (no implicit reset)', async () => {
    messagesCreateMock
      .mockImplementationOnce(() => fromArray(makeTextStream('one')))
      .mockImplementationOnce(() => fromArray(makeTextStream('two')));
    const session = makeSession();

    try {
      await session.sendMessage('first message');
      session.setSystemPrompt(NEW_PROMPT);
      await session.sendMessage('second message');

      const turn2Messages = (messagesCreateMock.mock.calls[1]![0] as { messages: unknown[] }).messages;
      // Turn 1's user text + assistant reply must still be in the payload.
      expect(JSON.stringify(turn2Messages)).toContain('first message');
      expect(turn2Messages.length).toBeGreaterThan(1);
    } finally {
      await session.close();
    }
  });

  it('survives a subsequent setCwd() — the shared-prefix composition case', async () => {
    messagesCreateMock
      .mockImplementationOnce(() => fromArray(makeTextStream('one')))
      .mockImplementationOnce(() => fromArray(makeTextStream('two')));
    const session = makeSession();

    try {
      await session.sendMessage('first');
      session.setSystemPrompt(NEW_PROMPT);
      // A cwd re-anchor re-assembles the prompt from the shared stable parts. If
      // setSystemPrompt had written to a copy, this would resurrect OLD_PROMPT.
      session.setCwd('/moved/worktree');

      await session.sendMessage('second');
      const turn2 = systemOfCall(1);
      expect(turn2).toContain('NEW-OVERLAY-MARKER');
      expect(turn2).not.toContain('OLD-OVERLAY-MARKER');
      expect(turn2).toContain('/moved/worktree');
    } finally {
      await session.close();
    }
  });

  it('clearing the prompt drops the overlay but keeps the rest of the system payload', async () => {
    messagesCreateMock
      .mockImplementationOnce(() => fromArray(makeTextStream('one')))
      .mockImplementationOnce(() => fromArray(makeTextStream('two')));
    const session = makeSession();

    try {
      await session.sendMessage('first');
      expect(session.setSystemPrompt(undefined)).toBe(true);

      await session.sendMessage('second');
      const turn2 = systemOfCall(1);
      expect(turn2).not.toContain('OLD-OVERLAY-MARKER');
      expect(turn2).toContain('Working directory');
    } finally {
      await session.close();
    }
  });
});
