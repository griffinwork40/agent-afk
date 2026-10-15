/**
 * Unit tests for the `readOnlyMemory` provider option and its propagation
 * through {@link createChildProviderFactory}.
 *
 * Child (subagent / skill) sessions see `memory_search` AND `memory_update`
 * (target:"fact" only). Writing to `target:"hot"` is blocked at runtime by
 * the `createChildMemoryHotBlockHook` PreToolUse hook. `procedure_write` is
 * still unavailable.
 *
 * What we verify:
 *  1. Read-only provider exposes only the `memory_search` tool schema
 *     (readOnlyMemory: true still fully blocks memory_update in the schema).
 *  2. Full (default) provider still exposes all three memory tool schemas.
 *  3. System prompt for read-only provider lacks write-side memory
 *     instructions and includes the read-only sentinel.
 *  4. `createChildProviderFactory()` produces a provider that exposes BOTH
 *     `memory_search` AND `memory_update` — the hot-write guard is enforced
 *     by the hook, not by schema exclusion.
 *
 * Pattern: same mocked Anthropic Messages-API client factory used by
 * `plan-mode-system-payload.test.ts` — intercept at `messages.create`,
 * capture the `tools` and `system` args from each call, and assert.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHookRegistry } from '../../hooks.js';
import { createChildMemoryHotBlockHook } from '../../memory/memory-hooks.js';
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
import { createChildProviderFactory, buildSkillRestrictedProvider, CHILD_ALLOWED_TOOLS } from '../../tools/nesting.js';
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

  it('produces a provider that exposes memory_search AND memory_update (fact writes unblocked)', async () => {
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
    // memory_update is now present — target:"fact" writes are allowed;
    // target:"hot" writes are blocked at runtime by createChildMemoryHotBlockHook.
    expect(names).toContain('memory_update');
    expect(names).not.toContain('procedure_write');

    // Child providers no longer suppress memory_update guidance in the system
    // prompt — the full MEMORY_SYSTEM_PROMPT is used (children can write facts).
    const systemArg = (firstCall[0] as { system?: unknown }).system;
    const text = extractSystemText(systemArg);
    expect(text).toContain('Cross-Session Memory');
    // The full prompt includes memory_update guidance (target:"fact").
    expect(text).toContain('memory_update');
  });

  it('exposes memory_search AND memory_update on OpenAI-routed child providers', async () => {
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
    // memory_update is now present — target:"fact" writes are allowed;
    // target:"hot" writes are blocked at runtime by createChildMemoryHotBlockHook.
    expect(toolNames).toContain('memory_update');
    expect(toolNames).not.toContain('procedure_write');
  });

  it('dispatcher accepts a memory_update tool_use (target:fact — allowed in child sessions)', async () => {
    // Two-turn dance:
    //   turn 1 → model emits memory_update tool_use with target:"fact"
    //   turn 2 → model receives tool_result, ends turn with text
    // We assert that the tool_result block in the *user* message of turn 2
    // does NOT have is_error: true — proving the dispatcher now allows the call.
    // (target:"hot" writes are blocked by the createChildMemoryHotBlockHook
    // PreToolUse hook registered in default-hook-registry.ts, not by schema
    // exclusion. That hook is not wired into this unit test's provider, so we
    // verify the schema-level allowance here.)
    let callCount = 0;
    messagesCreateMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return fromArray(
          makeToolUseStream(
            'tool_update_1',
            'memory_update',
            JSON.stringify({ target: 'fact', action: 'set', content: 'x', category: 'learning' }),
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
    // memory_update is now in CHILD_ALLOWED_TOOLS — the dispatcher must NOT
    // reject it with is_error. The tool handler may set is_error for other
    // reasons (e.g. missing MemoryStore), but the allowlist gate must not fire.
    expect(toolResult!.is_error).not.toBe(true);
  });

  it('hook blocks target:"hot" write from a child session — tool result carries is_error: true', async () => {
    // Integration path: wire the createChildMemoryHotBlockHook into a real
    // HookRegistry, pass it on the query config, and assert the dispatcher
    // returns is_error: true when the model calls memory_update(target:"hot")
    // from a child session (parentSessionId set). This proves the hook's
    // `decision: 'block'` actually reaches the dispatcher — a unit test that
    // only checks the hook's return value cannot catch a wrong field name.
    let callCount = 0;
    messagesCreateMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return fromArray(
          makeToolUseStream(
            'tool_hot_1',
            'memory_update',
            JSON.stringify({ target: 'hot', action: 'set', content: 'bad hot write', category: 'preference' }),
          ),
        );
      }
      return fromArray(makeTextStream('done'));
    });

    // Registry with the real hot-block hook.
    const hookRegistry = createHookRegistry();
    hookRegistry.register('PreToolUse', createChildMemoryHotBlockHook());

    const factory = createChildProviderFactory();
    const provider = factory({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      childExecutor: { execute: vi.fn() } as any,
    });

    const query = provider.query({
      prompt: singleInput('please write to hot memory'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
        // Signal a child session — the hook only blocks when parentSessionId is set.
        parentSessionId: 'parent-session-x',
        hookRegistry,
      },
    });
    await drainQuery(query);

    // Two messages.create calls: initial turn + tool-result follow-up.
    expect(messagesCreateMock).toHaveBeenCalledTimes(2);

    const secondCall = messagesCreateMock.mock.calls[1]!;
    const messages = (secondCall[0] as {
      messages?: Array<{ role: string; content: ContentBlockParam[] | string }>;
    }).messages;
    const lastUser = [...(messages ?? [])]
      .reverse()
      .find((m) => m.role === 'user');
    const blocks = Array.isArray(lastUser!.content)
      ? (lastUser!.content as ContentBlockParam[])
      : [];
    const toolResult = blocks.find(
      (b) =>
        (b as { type?: string }).type === 'tool_result' &&
        (b as { tool_use_id?: string }).tool_use_id === 'tool_hot_1',
    ) as { is_error?: boolean; content?: unknown } | undefined;

    expect(toolResult).toBeDefined();
    // The hook blocks the hot write — the dispatcher must set is_error: true.
    expect(toolResult!.is_error).toBe(true);
  });

  it('child hot write is rejected structurally even with NO hook registry (library-embedder path)', async () => {
    // Regression for the #2093 re-review: the PreToolUse hook only runs when a
    // hookRegistry reaches the dispatcher. Library embedders (query()/AgentSession)
    // may omit it, so guardChildHotWrites must reject target:"hot" on its own.
    let callCount = 0;
    messagesCreateMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return fromArray(
          makeToolUseStream(
            'tool_hot_noreg',
            'memory_update',
            JSON.stringify({ target: 'hot', action: 'set', content: 'PWNED-BY-CHILD' }),
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
      prompt: singleInput('please write to hot memory'),
      // No hookRegistry on purpose.
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', parentSessionId: 'parent-session-x' },
    });
    await drainQuery(query);

    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
    const messages = (messagesCreateMock.mock.calls[1]![0] as {
      messages?: Array<{ role: string; content: ContentBlockParam[] | string }>;
    }).messages;
    const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === 'user');
    const blocks = Array.isArray(lastUser!.content) ? (lastUser!.content as ContentBlockParam[]) : [];
    const toolResult = blocks.find(
      (b) =>
        (b as { type?: string }).type === 'tool_result' &&
        (b as { tool_use_id?: string }).tool_use_id === 'tool_hot_noreg',
    ) as { is_error?: boolean; content?: unknown } | undefined;

    expect(toolResult).toBeDefined();
    expect(toolResult!.is_error).toBe(true);
    expect(JSON.stringify(toolResult!.content)).toContain('may not write target:\\"hot\\"');
  });

  it('skill-restricted child (no readOnlyState, no parentSessionId, no hook registry) cannot write hot', async () => {
    // Regression for the #2093 third re-review: buildSkillRestrictedProvider builds
    // children WITHOUT readOnlyState, and a skill fork under a stub parent carries no
    // parentSessionId. forkSubagent still stamps subagentToolOutputCapBytes on every
    // fork, so isForkedChildSession must catch it.
    let callCount = 0;
    messagesCreateMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return fromArray(
          makeToolUseStream(
            'tool_hot_skill',
            'memory_update',
            JSON.stringify({ target: 'hot', action: 'set', content: 'PWNED-SKILLRESTRICTED' }),
          ),
        );
      }
      return fromArray(makeTextStream('done'));
    });

    const provider = buildSkillRestrictedProvider([...CHILD_ALLOWED_TOOLS], 'claude-sonnet-5');
    const query = provider.query({
      prompt: singleInput('please write to hot memory'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test', subagentToolOutputCapBytes: 100_000 },
    });
    await drainQuery(query);

    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
    const messages = (messagesCreateMock.mock.calls[1]![0] as {
      messages?: Array<{ role: string; content: ContentBlockParam[] | string }>;
    }).messages;
    const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === 'user');
    const blocks = Array.isArray(lastUser!.content) ? (lastUser!.content as ContentBlockParam[]) : [];
    const toolResult = blocks.find(
      (b) =>
        (b as { type?: string }).type === 'tool_result' &&
        (b as { tool_use_id?: string }).tool_use_id === 'tool_hot_skill',
    ) as { is_error?: boolean; content?: unknown } | undefined;

    expect(toolResult).toBeDefined();
    expect(toolResult!.is_error).toBe(true);
  });
});
