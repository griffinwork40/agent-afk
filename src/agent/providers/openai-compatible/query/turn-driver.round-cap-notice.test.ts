/**
 * Tests for injectRoundCapNotice in the openai-compatible turn-driver.
 *
 * Verifies:
 *   1. String-content tool message: notice appended directly (integration via mock API).
 *   2. No notice on rounds before the notice threshold.
 *   3. round_cap_notice_dropped NOT emitted when notice successfully injected.
 *   4. round_cap_notice_dropped emitted (via emitSessionPhase mock) when no string-content tool
 *      message exists: unit tests call the exported helper directly (#4261).
 *
 * Uses the real runTurnInner loop with a scripted mock OpenAI client
 * (same pattern as query.test.ts / date-rollover-system-payload.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../trace/emit.js', () => ({
  emitSessionPhase: vi.fn().mockResolvedValue(undefined),
  emitQueuedUserMessage: vi.fn().mockResolvedValue(undefined),
  emitToolCall: vi.fn().mockResolvedValue(undefined),
}));

import { emitSessionPhase } from '../../../trace/emit.js';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../../provider.js';
import type { AgentConfig } from '../../../types/config-types.js';
import type { OpenAIChunk } from '../translate.js';
import type { OpenAIMessage } from '../messages.js';
import { injectRoundCapNotice } from './turn-driver.js';
import {
  __setOpenAIClientFactory,
  buildQueryFromConfig,
  type OpenAIClientFactory,
} from '../query.js';
import { SessionToolDispatcher } from '../../../tools/dispatcher.js';
import { createHookRegistry } from '../../../hooks.js';
import type { AnthropicToolDef } from '../../anthropic-direct/types.js';
import type { ToolHandler } from '../../../tools/types.js';

// ---------------------------------------------------------------------------
// Scripted mock client
// ---------------------------------------------------------------------------

type ScriptedCall = { chunks: OpenAIChunk[] };
let scriptedCalls: ScriptedCall[] = [];
let callIndex = 0;
let capturedRequests: Array<{ messages: OpenAIMessage[] }> = [];

function installClient(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (
            args: { stream?: boolean; messages?: OpenAIMessage[] },
            _options?: { signal?: AbortSignal },
          ) => {
            if (!args.stream) throw new Error('mock: streaming only');
            capturedRequests.push({ messages: (args.messages ?? []) as OpenAIMessage[] });
            const call = scriptedCalls[callIndex++];
            if (!call) throw new Error(`scripted call ${callIndex - 1} not defined`);
            const chunks = call.chunks.slice();
            return (async function* () {
              for (const c of chunks) yield c;
            })();
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

// ---------------------------------------------------------------------------
// Chunk helpers
// ---------------------------------------------------------------------------

function stopChunk(text = 'done'): OpenAIChunk[] {
  return [
    { choices: [{ delta: { content: text } }] } as OpenAIChunk,
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as OpenAIChunk,
  ];
}

function toolChunk(toolId: string, toolName: string): OpenAIChunk[] {
  return [
    {
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: toolId, type: 'function', function: { name: toolName, arguments: '{}' } }],
        },
      }],
    } as unknown as OpenAIChunk,
    {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as OpenAIChunk,
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collect(q: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of q) out.push(ev);
  return out;
}

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

function baseConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: 'gpt-4o-mini',
    apiKey: 'sk-test-key',
    ...over,
  } as AgentConfig;
}

/** Build a SessionToolDispatcher with a no-op 'bash' tool for testing. */
function makeBashDispatcher(): SessionToolDispatcher {
  const hookRegistry = createHookRegistry();
  const bashHandler: ToolHandler = async () => ({ content: 'ok' });
  const schemas: AnthropicToolDef[] = [
    { name: 'bash', description: 'Run a shell command', input_schema: { type: 'object' } },
  ];
  return new SessionToolDispatcher({
    handlers: new Map([['bash', bashHandler]]),
    schemas,
    hookRegistry,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('openai-compatible injectRoundCapNotice', () => {
  beforeEach(() => {
    scriptedCalls = [];
    callIndex = 0;
    capturedRequests = [];
    vi.mocked(emitSessionPhase).mockClear();
    vi.stubEnv('AFK_VITALS', '0');
    installClient();
  });

  afterEach(() => {
    __setOpenAIClientFactory(null as never);
    vi.restoreAllMocks();
  });

  it('notice text present in API request at notice round (string tool content)', async () => {
    // budget=4 → notice fires at round max(1,4-3)=1.
    // After round 1 completes (iterations=1), injectRoundCapNotice appends the
    // notice to the last tool message before round 2's API call.
    // Round 1: model calls bash → tool result (string content via SessionToolDispatcher).
    // Round 2 request should carry the notice in the tool result message.
    // Round 2: stop.
    const toolId = 'call_notice_str';
    scriptedCalls = [
      { chunks: toolChunk(toolId, 'bash') },   // round 1: model calls bash
      { chunks: stopChunk('summary') },          // round 2: model answers
    ];

    const dispatcher = makeBashDispatcher();
    const q = buildQueryFromConfig(
      baseConfig({ maxToolUseIterations: 4 }),
      singleInput('go'),
      { toolDispatcher: dispatcher },
    );

    await collect(q);

    // The second API call (round 2) must contain the notice text in the tool message.
    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const round2Messages = capturedRequests[1]!.messages;
    const toolMessages = round2Messages.filter((m) => m.role === 'tool');
    const hasNotice = toolMessages.some((m) => {
      const c = m.content;
      return typeof c === 'string' && c.includes('Budget notice');
    });
    expect(hasNotice).toBe(true);
  });

  it('no notice injected on rounds before the notice threshold', async () => {
    // budget=50 → notice fires at round 47; with only 1 tool round, no notice fires.
    const toolId = 'call_no_notice';
    scriptedCalls = [
      { chunks: toolChunk(toolId, 'bash') },
      { chunks: stopChunk('early answer') },
    ];

    const dispatcher = makeBashDispatcher();
    const q = buildQueryFromConfig(
      baseConfig({ maxToolUseIterations: 50 }),
      singleInput('go'),
      { toolDispatcher: dispatcher },
    );

    await collect(q);

    // Round 1 is not the notice round (47 for budget=50); no notice injected.
    const round2 = capturedRequests[1]?.messages ?? [];
    const toolMsgs = round2.filter((m) => m.role === 'tool');
    const hasNotice = toolMsgs.some((m) => {
      const c = m.content;
      return typeof c === 'string' && c.includes('Budget notice');
    });
    expect(hasNotice).toBe(false);
  });

  it('no round_cap_notice_dropped event when notice is successfully injected', async () => {
    // budget=5 → notice fires at round 2; tool message exists → injection succeeds.
    const toolId = 'call_no_drop';
    scriptedCalls = [
      { chunks: toolChunk(toolId, 'bash') },
      { chunks: stopChunk('summary') },
    ];

    const dispatcher = makeBashDispatcher();
    const q = buildQueryFromConfig(
      baseConfig({ maxToolUseIterations: 5 }),
      singleInput('go'),
      { toolDispatcher: dispatcher },
    );

    await collect(q);

    const droppedCalls = vi.mocked(emitSessionPhase).mock.calls.filter(
      ([, payload]) => (payload as { phase: string }).phase === 'round_cap_notice_dropped',
    );
    expect(droppedCalls).toHaveLength(0);
  });

  it('no notice or drop event when no tool rounds happen (stop on first call)', async () => {
    // No tool calls → no tool messages in history → injectRoundCapNotice never
    // reaches the notice round for budget=50.
    scriptedCalls = [{ chunks: stopChunk('no tools') }];

    const q = buildQueryFromConfig(
      baseConfig({ maxToolUseIterations: 50 }),
      singleInput('just answer'),
    );

    await collect(q);

    const droppedCalls = vi.mocked(emitSessionPhase).mock.calls.filter(
      ([, p]) => (p as { phase: string }).phase === 'round_cap_notice_dropped',
    );
    expect(droppedCalls).toHaveLength(0);
  });

  it('notice text is appended (not prepended) to the tool result content', async () => {
    // budget=4 → notice fires at round max(1,4-3)=1.
    // Verifies the exact injection shape: 'ok\n\n[Budget notice:…]'
    const toolId = 'call_append_check';
    scriptedCalls = [
      { chunks: toolChunk(toolId, 'bash') },
      { chunks: stopChunk('final') },
    ];

    const dispatcher = makeBashDispatcher();
    const q = buildQueryFromConfig(
      baseConfig({ maxToolUseIterations: 4 }),
      singleInput('go'),
      { toolDispatcher: dispatcher },
    );

    await collect(q);

    const round2Messages = capturedRequests[1]?.messages ?? [];
    const toolMsg = round2Messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    const content = toolMsg!.content as string;
    expect(typeof content).toBe('string');
    // Original tool output ('ok') comes first; notice is appended after \n\n
    expect(content).toContain('ok');
    expect(content).toContain('[Budget notice:');
    const noticeIdx = content.indexOf('[Budget notice:');
    const okIdx = content.indexOf('ok');
    expect(noticeIdx).toBeGreaterThan(okIdx);
  });
});

// #4261: the drop branch cannot be reached through the loop (the notice is
// injected only after a tool round appended tool messages), so the exported
// helper is exercised directly.
describe('injectRoundCapNotice drop path (unit)', () => {
  const sink = {} as Parameters<typeof injectRoundCapNotice>[3];
  const dropped = () => vi.mocked(emitSessionPhase).mock.calls.filter(
    (c) => (c[1] as { phase?: string } | undefined)?.phase === 'round_cap_notice_dropped',
  );

  beforeEach(() => vi.mocked(emitSessionPhase).mockClear());

  it('emits round_cap_notice_dropped when no tool message exists at the notice round', () => {
    const turns: OpenAIMessage[] = [{ role: 'user', content: 'go' }];
    injectRoundCapNotice(turns, 2, 5, sink);
    expect(dropped()).toHaveLength(1);
    expect(dropped()[0]![0]).toBe(sink);
    expect(dropped()[0]![1]).toEqual({
      phase: 'round_cap_notice_dropped',
      metadata: { provider: 'openai-compatible', round: 2 },
    });
    expect(turns).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('emits round_cap_notice_dropped when the last tool message has non-string content', () => {
    const content = [{ type: 'text', text: 'result' }];
    const turns = [{ role: 'tool', tool_call_id: 'c1', content }] as unknown as OpenAIMessage[];
    injectRoundCapNotice(turns, 2, 5, sink);
    expect(dropped()).toHaveLength(1);
    expect(content).toEqual([{ type: 'text', text: 'result' }]);
  });

  it('appends to a string tool message and emits nothing', () => {
    const turns: OpenAIMessage[] = [{ role: 'tool', tool_call_id: 'c1', content: 'result' }];
    injectRoundCapNotice(turns, 2, 5, sink);
    expect(dropped()).toHaveLength(0);
    expect((turns[0] as { content: string }).content).toContain('Budget notice');
  });

  it('does nothing off the notice round, even with no tool message', () => {
    injectRoundCapNotice([{ role: 'user', content: 'go' }], 1, 5, sink);
    expect(vi.mocked(emitSessionPhase)).not.toHaveBeenCalled();
  });
});
