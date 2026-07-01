/**
 * Unit tests for the `readOnlyMemory` provider option and its propagation
 * through {@link createChildProviderFactory}.
 *
 * Child (subagent / skill) sessions must only see `memory_search` — never
 * `memory_update` or `procedure_write`. The parent session is the single
 * writer for the cross-session store; allowing writes from subagents would
 * cause uncoordinated fan-out into the shared memory.
 *
 * What we verify:
 *  1. Read-only provider exposes only the `memory_search` tool schema.
 *  2. Full (default) provider still exposes all three memory tool schemas.
 *  3. System prompt for read-only provider lacks write-side memory
 *     instructions and includes the read-only sentinel.
 *  4. `createChildProviderFactory()` produces a provider that exhibits
 *     read-only behaviour AND that the dispatcher refuses a `memory_update`
 *     tool_use with an `is_error: true` tool_result.
 *
 * Pattern: same mocked Anthropic Messages-API client factory used by
 * `plan-mode-system-payload.test.ts` — intercept at `messages.create`,
 * capture the `tools` and `system` args from each call, and assert.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  RawMessageStreamEvent,
  Tool,
} from '@anthropic-ai/sdk/resources';
import {
  AnthropicDirectProvider,
  __setAnthropicClientFactory,
} from './index.js';
import { createChildProviderFactory } from '../../tools/nesting.js';
import type OpenAI from 'openai';
import { __setOpenAIClientFactory, type OpenAIClientFactory } from '../openai-compatible/query.js';
import type { OpenAIChunk } from '../openai-compatible/translate.js';

// --- Mock Anthropic Messages-API plumbing --------------------------------

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

function installFactory(): void {
  __setAnthropicClientFactory(
    () => new MockAnthropic() as unknown as Anthropic,
  );
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** End-of-turn stream that emits a single text block — no tool calls. */
function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Stream that emits a single `tool_use` block for the given tool. */
function makeToolUseStream(
  toolId: string,
  toolName: string,
  inputJson: string,
): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_t',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function extractSystemText(systemArg: unknown): string {
  if (typeof systemArg === 'string') return systemArg;
  if (!Array.isArray(systemArg)) return '';
  const blocks = systemArg as ContentBlockParam[];
  return blocks
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}


// --- Mock OpenAI Chat Completions plumbing --------------------------------

let openAICreateCalls: Array<{ args: unknown; signal?: AbortSignal }> = [];
let pendingOpenAIChunks: OpenAIChunk[] = [];

function installOpenAIFactory(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean }, options?: { signal?: AbortSignal }) => {
            const callRecord: { args: unknown; signal?: AbortSignal } = { args };
            if (options?.signal) callRecord.signal = options.signal;
            openAICreateCalls.push(callRecord);
            if (!args.stream) throw new Error('mock only supports streaming mode');
            const chunks = pendingOpenAIChunks.slice();
            return (async function* () {
              for (const c of chunks) yield c;
            })();
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

function openAIToolNames(toolsArg: unknown): string[] {
  if (!Array.isArray(toolsArg)) return [];
  return (toolsArg as Array<{ function?: { name?: unknown } }>)
    .map((t) => (typeof t.function?.name === 'string' ? t.function.name : ''))
    .filter((n): n is string => n.length > 0);
}

function toolNamesFromArg(toolsArg: unknown): string[] {
  if (!Array.isArray(toolsArg)) return [];
  return (toolsArg as Tool[]).map((t) => t.name);
}

async function drainQuery(query: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ev of query) {
    // drain
  }
}

describe('AnthropicDirectProvider — readOnlyMemory option', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    openAICreateCalls = [];
    pendingOpenAIChunks = [];
    __setAnthropicClientFactory(null);
    __setOpenAIClientFactory(null);
    installFactory();
    installOpenAIFactory();
    messagesCreateMock.mockImplementation(() =>
      fromArray(makeTextStream('ok')),
    );
  });

  it('exposes only memory_search when readOnlyMemory: true', async () => {
    const provider = new AnthropicDirectProvider({ readOnlyMemory: true });
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
      },
    });

    await drainQuery(query);

    expect(messagesCreateMock).toHaveBeenCalled();
    const firstCall = messagesCreateMock.mock.calls[0]!;
    const toolsArg = (firstCall[0] as { tools?: unknown }).tools;
    const names = toolNamesFromArg(toolsArg);
    expect(names).toContain('memory_search');
    expect(names).not.toContain('memory_update');
    expect(names).not.toContain('procedure_write');
  });

  it('exposes all three memory tools when readOnlyMemory is unset (default)', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const toolsArg = (firstCall[0] as { tools?: unknown }).tools;
    const names = toolNamesFromArg(toolsArg);
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_update');
    expect(names).toContain('procedure_write');
  });

  it('substitutes the read-only memory system prompt when readOnlyMemory: true', async () => {
    const provider = new AnthropicDirectProvider({ readOnlyMemory: true });
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);
    // Read-only sentinel from MEMORY_SYSTEM_PROMPT_READONLY.
    expect(text).toContain('Cross-Session Memory (read-only)');
    expect(text).toContain('Reading memory');
    // Writes are NOT advertised in the read-only variant.
    expect(text).not.toContain('Writing memory');
    expect(text).not.toContain('Procedures (procedure_write)');
    expect(text).not.toContain('Hot memory vs. fact archive');
  });

  it('default provider system prompt still contains write instructions', async () => {
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
      },
    });

    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);
    expect(text).toContain('Writing memory');
    expect(text).toContain('Procedures (procedure_write)');
    expect(text).not.toContain('Cross-Session Memory (read-only)');
  });
});

describe('createChildProviderFactory — readOnlyMemory propagation', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    openAICreateCalls = [];
    pendingOpenAIChunks = [];
    __setAnthropicClientFactory(null);
    __setOpenAIClientFactory(null);
    installFactory();
    installOpenAIFactory();
  });

  it('produces a provider that exposes only memory_search', async () => {
    messagesCreateMock.mockImplementation(() =>
      fromArray(makeTextStream('ok')),
    );

    // childExecutor is unused for the memory-tool assertions, but the
    // factory's call signature requires it. A bare object satisfies the
    // shape — the schema injection only fires if executor is truthy, which
    // we don't depend on here.
    const factory = createChildProviderFactory();
    const provider = factory({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      childExecutor: { execute: vi.fn() } as any,
    });

    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
      },
    });
    await drainQuery(query);

    const firstCall = messagesCreateMock.mock.calls[0]!;
    const toolsArg = (firstCall[0] as { tools?: unknown }).tools;
    const names = toolNamesFromArg(toolsArg);
    expect(names).toContain('memory_search');
    expect(names).not.toContain('memory_update');
    expect(names).not.toContain('procedure_write');

    // System prompt is also read-only.
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);
    expect(text).toContain('Cross-Session Memory (read-only)');
    expect(text).not.toContain('Writing memory');
  });

  it('applies read-only memory to OpenAI-routed child providers', async () => {
    pendingOpenAIChunks = [
      {
        choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];

    const factory = createChildProviderFactory();
    const provider = factory({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      childExecutor: { execute: vi.fn() } as any,
      model: 'gpt-4o',
    });

    expect(provider.name).toBe('openai-compatible');
    const query = provider.query({
      prompt: singleInput('hello'),
      config: {
        model: 'gpt-4o',
        apiKey: 'sk-test-key',
      },
    });
    await drainQuery(query);

    const firstCall = openAICreateCalls[0]!;
    const toolNames = openAIToolNames((firstCall.args as { tools?: unknown }).tools);
    expect(toolNames).toContain('memory_search');
    expect(toolNames).not.toContain('memory_update');
    expect(toolNames).not.toContain('procedure_write');
  });

  it('dispatcher rejects a memory_update tool_use with is_error tool_result', async () => {
    // Two-turn dance:
    //   turn 1 → model emits memory_update tool_use
    //   turn 2 → model receives tool_result, ends turn with text
    // We assert that the tool_result block in the *user* message of turn 2
    // has is_error: true and contains the permission-denied / unknown-tool
    // sentinel — proving the dispatcher refused to execute the write.
    let callCount = 0;
    messagesCreateMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return fromArray(
          makeToolUseStream(
            'tool_update_1',
            'memory_update',
            JSON.stringify({ target: 'hot', action: 'set', content: 'x' }),
          ),
        );
      }
      return fromArray(makeTextStream('done'));
    });

    const factory = createChildProviderFactory();
    const provider = factory({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      childExecutor: { execute: vi.fn() } as any,
    });

    const query = provider.query({
      prompt: singleInput('please remember this'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
      },
    });
    await drainQuery(query);

    // Two messages.create invocations: initial turn + tool-result follow-up.
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);

    const secondCall = messagesCreateMock.mock.calls[1]!;
    const messages = (secondCall[0] as {
      messages?: Array<{ role: string; content: ContentBlockParam[] | string }>;
    }).messages;
    expect(Array.isArray(messages)).toBe(true);

    // The last user message carries the tool_result blocks.
    const lastUser = [...(messages ?? [])]
      .reverse()
      .find((m) => m.role === 'user');
    expect(lastUser).toBeDefined();
    const blocks = Array.isArray(lastUser!.content)
      ? (lastUser!.content as ContentBlockParam[])
      : [];
    const toolResult = blocks.find(
      (b) =>
        (b as { type?: string }).type === 'tool_result' &&
        (b as { tool_use_id?: string }).tool_use_id === 'tool_update_1',
    ) as { is_error?: boolean; content?: unknown } | undefined;

    expect(toolResult).toBeDefined();
    expect(toolResult!.is_error).toBe(true);
    const content =
      typeof toolResult!.content === 'string'
        ? toolResult!.content
        : Array.isArray(toolResult!.content)
          ? (toolResult!.content as Array<{ text?: string }>)
              .map((c) => c.text ?? '')
              .join('')
          : '';
    // Permission rejection sentinel (CHILD_ALLOWED_TOOLS excludes memory_update)
    // OR unknown-tool sentinel (handler is also unregistered) — either proves
    // the dispatcher refused to write.
    expect(content).toMatch(/not in the configured allowlist|Unknown tool/);
  });
});
