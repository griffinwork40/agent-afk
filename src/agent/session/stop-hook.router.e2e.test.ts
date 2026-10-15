/**
 * End-to-end Stop-hook test through the REAL ProviderRouter (#2957).
 *
 * A real AgentSession with no injected `config.provider` installs the
 * ProviderRouter, which builds a real AnthropicDirectProvider whose SDK client
 * is mocked. This is the path that let a missing `setBeforeTurnEnd` forward in
 * provider-router.ts pass CI before a7cc139f2: the seam, the router forward,
 * and the session-layer exactly-once guard were only unit-tested in isolation.
 *
 * Asserts:
 *   (a) a blocking Stop hook produces a same-turn continuation (a second
 *       model request carrying the block reason as a user message);
 *   (b) Stop dispatches exactly once per turn end (seam + session layer never
 *       both fire);
 *   (c) AFK_STOP_HOOK_MAX_CONTINUATIONS=0 still fires Stop once (via the
 *       session-layer fallback) but never continues the turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { AgentSession } from './agent-session.js';
import { __setAnthropicClientFactory } from '../providers/anthropic-direct/index.js';
import { createHookRegistry } from '../hook-registry.js';
import { resetSlotBindings } from './model-slots.js';
import type { HookContext, HookDecision } from '../hooks.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

const createMock = vi.fn();
class MockAnthropic {
  public messages = { create: createMock };
}
async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}
function textStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', content: [],
        model: 'claude-haiku-4-5', stop_reason: null, stop_sequence: null,
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

/** Session on the ProviderRouter path with a Stop handler and wired Stop. */
function makeSession(stopHandler: (ctx: HookContext) => HookDecision): {
  session: AgentSession;
  stopCalls: HookContext[];
} {
  const registry = createHookRegistry();
  const stopCalls: HookContext[] = [];
  registry.register('Stop', async (ctx) => {
    stopCalls.push(ctx);
    return stopHandler(ctx);
  });
  // No config.provider → the session installs the ProviderRouter.
  const session = new AgentSession({
    model: 'claude-haiku-4-5',
    apiKey: 'sk-ant-oat01-test',
    hookRegistry: registry,
  });
  session.wireStopHook({ getHasNextTurn: () => true });
  return { session, stopCalls };
}

/** Serialized `messages` of the Nth model request. */
function requestMessages(n: number): string {
  const req = createMock.mock.calls[n]?.[0] as { messages?: unknown } | undefined;
  return JSON.stringify(req?.messages ?? []);
}

describe('AgentSession Stop hook — end-to-end through ProviderRouter (#2957)', () => {
  beforeEach(() => {
    resetSlotBindings();
    createMock.mockReset();
    __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
    vi.unstubAllEnvs();
    resetSlotBindings();
  });

  it('non-blocking Stop dispatches exactly once per turn end', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2');
    createMock.mockImplementation(() => fromArray(textStream('all good')));
    const { session, stopCalls } = makeSession(() => ({}));
    try {
      await session.sendMessage('turn one');
      expect(stopCalls).toHaveLength(1);
      await session.sendMessage('turn two');
      expect(stopCalls).toHaveLength(2);
      expect(createMock).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });

  it('a blocking Stop hook continues the same turn with the block reason', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2');
    let n = 0;
    createMock.mockImplementation(() => fromArray(textStream(n++ === 0 ? 'first draft' : 'verified answer')));
    // Block the first Stop only; approve the continuation's Stop.
    const { session, stopCalls } = makeSession((ctx) =>
      stopCalls.length === 1 ? { decision: 'block', reason: 'please verify your work' } : (void ctx, {}),
    );
    try {
      const reply = await session.sendMessage('do the thing');
      // (a) continuation: a second model request inside the same turn whose
      // history carries the block reason as a user message.
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(requestMessages(1)).toContain('please verify your work');
      expect(reply.content).toContain('verified answer');
      // (b) Stop fired once per seam round (block + approve) and the session
      // layer did NOT dispatch a third, duplicate Stop.
      expect(stopCalls).toHaveLength(2);
      expect((stopCalls[1] as { continuation?: number }).continuation).toBe(1);
      expect(session.getTurnCount()).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('AFK_STOP_HOOK_MAX_CONTINUATIONS=0 still fires Stop once but never continues', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '0');
    createMock.mockImplementation(() => fromArray(textStream('only answer')));
    const { session, stopCalls } = makeSession(() => ({ decision: 'block', reason: 'nope' }));
    try {
      await session.sendMessage('hello');
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(stopCalls).toHaveLength(1);
    } finally {
      await session.close();
    }
  });
});
