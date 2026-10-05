/**
 * Hot-write guard coverage — routes not exercised in read-only-memory.test.ts.
 * (That file is at the 634-LOC ceiling; new tests live here.)
 *
 * Tests:
 *  1. OpenAI-compatible route + forked child (subagentToolOutputCapBytes set,
 *     no parentSessionId) → structural guard blocks target:"hot".
 *  2. Top-level session (no fork signals) → structural guard does NOT block.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type OpenAI from 'openai';
import { __setOpenAIClientFactory, type OpenAIClientFactory } from '../openai-compatible/query.js';
import type { OpenAIChunk } from '../openai-compatible/translate.js';
import { buildSkillRestrictedProvider, CHILD_ALLOWED_TOOLS, createChildProviderFactory } from '../../tools/nesting.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';

// ---------------------------------------------------------------------------
// Anthropic mock plumbing
// ---------------------------------------------------------------------------

const messagesCreateMock = vi.fn();
class MockAnthropic {
  public messages = { create: messagesCreateMock };
}

function installAnthropicFactory(): void {
  __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function drainEvents(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    { type: 'message_start', message: { id: 'msg_t', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null } } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function makeToolUseStream(toolId: string, toolName: string, inputJson: string): RawMessageStreamEvent[] {
  return [
    { type: 'message_start', message: { id: 'msg_tu', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null } } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputJson } } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

// ---------------------------------------------------------------------------
// OpenAI mock plumbing
// ---------------------------------------------------------------------------

let openAICreateCalls: Array<{ args: unknown }> = [];

function makeOpenAIToolCallChunks(callId: string, fnName: string, argsJson: string): OpenAIChunk[] {
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: fnName, arguments: argsJson } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
  ];
}

function makeOpenAITextChunks(text: string): OpenAIChunk[] {
  return [{ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }];
}

function makeScriptedOpenAIFactory(turns: OpenAIChunk[][]): OpenAIClientFactory {
  let idx = 0;
  return () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean }) => {
            openAICreateCalls.push({ args });
            if (!args.stream) throw new Error('mock only supports streaming mode');
            const chunks = turns[idx++] ?? makeOpenAITextChunks('done');
            return (async function* () { for (const c of chunks) yield c; })();
          },
        },
      },
    }) as unknown as OpenAI;
}

// ---------------------------------------------------------------------------
// Tests: OpenAI route + forked child
// ---------------------------------------------------------------------------

describe('hot-write guard — OpenAI route, skill fork (subagentToolOutputCapBytes, no parentSessionId)', () => {
  beforeEach(() => {
    openAICreateCalls = [];
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    __setOpenAIClientFactory(null);
    installAnthropicFactory();
  });

  it('blocks target:"hot" on OpenAI-routed child provider with subagentToolOutputCapBytes', async () => {
    // The structural guard (guardChildHotWrites → isForkedChildSession) must
    // detect the fork via subagentToolOutputCapBytes even when parentSessionId
    // is absent from the query config.
    __setOpenAIClientFactory(
      makeScriptedOpenAIFactory([
        makeOpenAIToolCallChunks('call_hot_oai', 'memory_update', JSON.stringify({ target: 'hot', action: 'set', content: 'OAI-PWNED' })),
        makeOpenAITextChunks('done'),
      ]),
    );

    const factory = createChildProviderFactory();
    const provider = factory({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      childExecutor: { execute: vi.fn() } as any,
      model: 'gpt-4o',
    });
    expect(provider.name).toBe('openai-compatible');

    const events = await drainEvents(
      provider.query({
        prompt: singleInput('write hot memory'),
        config: { model: 'gpt-4o', apiKey: 'sk-test-key', subagentToolOutputCapBytes: 100_000 },
      }),
    );

    const toolOut = events.find((e) => e.type === 'tool.output');
    expect(toolOut?.type).toBe('tool.output');
    if (toolOut?.type === 'tool.output') {
      expect(toolOut.isError).toBe(true);
      expect(toolOut.content).toContain('may not write target:"hot"');
    }
  });

  it('blocks target:"hot" on Anthropic skill-restricted child carrying only subagentToolOutputCapBytes', async () => {
    // Regression for #2242 item 1 on the Anthropic route.
    let callCount = 0;
    messagesCreateMock.mockImplementation(() => {
      callCount++;
      return fromArray(callCount === 1
        ? makeToolUseStream('tool_hot_cap', 'memory_update', JSON.stringify({ target: 'hot', action: 'set', content: 'PWNED-CAP-ONLY' }))
        : makeTextStream('done'));
    });

    const provider = buildSkillRestrictedProvider([...CHILD_ALLOWED_TOOLS], 'claude-sonnet-5');
    const events = await drainEvents(
      provider.query({
        prompt: singleInput('write hot memory'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', subagentToolOutputCapBytes: 100_000 },
      }),
    );

    const toolOut = events.find((e) => e.type === 'tool.output');
    expect(toolOut?.type).toBe('tool.output');
    if (toolOut?.type === 'tool.output') {
      expect(toolOut.isError).toBe(true);
      expect(toolOut.content).toContain('may not write target:"hot"');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: top-level session — over-blocking guard
// ---------------------------------------------------------------------------

describe('hot-write guard — top-level session is NOT blocked', () => {
  beforeEach(() => {
    openAICreateCalls = [];
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    __setOpenAIClientFactory(null);
    installAnthropicFactory();
  });

  it('does not block target:"hot" for a top-level session (no fork signals anywhere)', async () => {
    // Over-blocking regression: a top-level session must pass through the structural
    // guard unchanged. guardChildHotWrites returns the unmodified handler map when
    // isForkedChildSession is false.
    let callCount = 0;
    messagesCreateMock.mockImplementation(() => {
      callCount++;
      return fromArray(callCount === 1
        ? makeToolUseStream('tool_hot_top', 'memory_update', JSON.stringify({ target: 'hot', action: 'set', content: 'top-level write' }))
        : makeTextStream('done'));
    });

    // Top-level: no readOnlyState, no parentSessionId, no subagentToolOutputCapBytes.
    const provider = new AnthropicDirectProvider();
    const events = await drainEvents(
      provider.query({
        prompt: singleInput('write hot memory'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
      }),
    );

    // The guard's denial sentinel must not appear. The handler may still error
    // for unrelated reasons (e.g. no persistent store in this unit context),
    // but the guard must NOT be the source.
    const toolOut = events.find((e) => e.type === 'tool.output');
    if (toolOut?.type === 'tool.output') {
      expect(toolOut.content).not.toContain('sub-agent sessions may not write target:"hot"');
    }
  });
});
