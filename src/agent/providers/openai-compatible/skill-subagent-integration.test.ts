/**
 * Integration tests: forking a skill subagent under an openai-compatible
 * session and driving a multi-round tool loop.
 *
 * Issue #654: no direct/e2e coverage of skill subagents under
 * openai-compatible (Chat Completions + Responses wire). Credential
 * resolver unit test (item 1) shipped in credential-resolver.test.ts.
 * This file covers item 2.
 *
 * Suite 1 — Chat Completions multi-round loop:
 *   Drives a two-round Chat Completions turn through OpenAICompatibleProvider
 *   (tool_call in round 1, final text in round 2). Asserts: two model calls
 *   issued, history carries assistant + tool messages between rounds, final
 *   text and aggregated usage correct.
 *
 * Suite 2 — Responses wire multi-round loop:
 *   Same shape via OpenAICompatibleQuery with useResponsesApi:true (the
 *   function_call loop seam that query-responses.test.ts leaves uncovered).
 *   Asserts: Responses wire shape (input/instructions), function_call output
 *   threaded back as input item, final text and aggregated usage correct.
 *
 * Suite 3 — Skill subagent fork under openai-compatible parent:
 *   Uses SkillExecutor with a fork-mode registered skill. Spies on
 *   SubagentManager.forkSubagent to assert correct child model, credential
 *   isolation (no parent OpenAI key leaking to an Anthropic child), and
 *   fall-through to resolveCredentialForModel when no custom resolver is set.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import {
  __setOpenAIClientFactory,
  OpenAICompatibleQuery,
  type OpenAIClientFactory,
} from './query.js';
import { OpenAICompatibleProvider } from './index.js';
import { AnthropicDirectProvider } from '../anthropic-direct/index.js';
import type { OpenAIChunk } from './translate.js';
import type { ResponsesStreamEvent } from './responses-translate.js';
import { registerSkill, _resetRegistry } from '../../../skills/index.js';
import { SkillExecutor } from '../../tools/skill-executor.js';
import { SubagentManager } from '../../subagent.js';
import * as promptLoader from '../../../skills/_lib/prompt-loader.js';
import type { OpenAIAuthResolution } from './auth.js';

// ─── credential-resolver mock ──────────────────────────────────────────────
// Keeps all tests hermetic — no keychain, no env dependency.
const mockResolveCredentialForModel = vi.hoisted(() =>
  vi.fn((_model: string | undefined) => 'sk-openai-resolved' as string | undefined),
);
vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: mockResolveCredentialForModel,
  loadAnthropicCredential: vi.fn(() => 'sk-ant-test'),
  loadOpenAICredential: vi.fn(() => 'sk-openai-resolved'),
}));

// ─── helpers ───────────────────────────────────────────────────────────────

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

const abortSignal = new AbortController().signal;
function makeCall(input: unknown) {
  return { id: 'call-skill', name: 'skill', input, signal: abortSignal };
}

// ─── Chat Completions: scripted multi-turn mock ────────────────────────────

type ScriptedTurn = { chunks: OpenAIChunk[] };

function makeScriptedChatClient(script: ScriptedTurn[]): {
  factory: OpenAIClientFactory;
  allCreateArgs: Array<unknown>;
} {
  const allCreateArgs: Array<unknown> = [];
  let idx = 0;
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (
            args: { stream?: boolean },
            options?: { signal?: AbortSignal },
          ) => {
            allCreateArgs.push(args);
            const turn = script[idx++];
            if (!turn) throw new Error(`No scripted turn at index ${idx - 1}`);
            const chunks = turn.chunks.slice();
            return (async function* () {
              for (const c of chunks) {
                if (options?.signal?.aborted) {
                  const e = new Error('aborted');
                  e.name = 'AbortError';
                  throw e;
                }
                yield c;
              }
            })();
          },
        },
      },
    }) as unknown as OpenAI;
  return { factory, allCreateArgs };
}

// ─── Responses: scripted multi-turn mock ──────────────────────────────────

function makeScriptedResponsesClient(script: ResponsesStreamEvent[][]): {
  factory: OpenAIClientFactory;
  allCreateArgs: Array<Record<string, unknown>>;
} {
  const allCreateArgs: Array<Record<string, unknown>> = [];
  let idx = 0;
  const factory: OpenAIClientFactory = () =>
    ({
      responses: {
        create: async (
          args: Record<string, unknown>,
          options?: { signal?: AbortSignal },
        ) => {
          allCreateArgs.push(args);
          const events = script[idx++] ?? [];
          return (async function* () {
            for (const e of events) {
              if (options?.signal?.aborted) {
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
              }
              yield e;
            }
          })();
        },
      },
    }) as unknown as OpenAI;
  return { factory, allCreateArgs };
}

// ─── Shared chunk / event payloads ────────────────────────────────────────

/**
 * Chat Completions — round 1: emit one tool_call (bash), finish_reason=tool_calls.
 * Round 2: emit final text.
 */
const chatTurn1: ScriptedTurn = {
  chunks: [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'tc_bash_1',
                type: 'function',
                function: { name: 'bash', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    } as OpenAIChunk,
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"command":"echo hi"}' } }],
          },
          finish_reason: null,
        },
      ],
    } as OpenAIChunk,
    {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as OpenAIChunk,
  ],
};

const chatTurn2: ScriptedTurn = {
  chunks: [
    {
      choices: [{ delta: { content: 'Done. Output: hi' }, finish_reason: null }],
    } as OpenAIChunk,
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    } as OpenAIChunk,
  ],
};

/**
 * Responses wire — round 1: function_call item + done.
 * Round 2: text answer.
 */
const responsesRound1: ResponsesStreamEvent[] = [
  { type: 'response.created' } as ResponsesStreamEvent,
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fi_1',
      call_id: 'fc_call_1',
      name: 'bash',
      arguments: '',
    },
  } as unknown as ResponsesStreamEvent,
  {
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    item_id: 'fi_1',
    delta: '{"command":"ls"}',
  } as unknown as ResponsesStreamEvent,
  {
    type: 'response.function_call_arguments.done',
    output_index: 0,
    item_id: 'fi_1',
    arguments: '{"command":"ls"}',
  } as unknown as ResponsesStreamEvent,
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    },
  } as unknown as ResponsesStreamEvent,
];

const responsesRound2: ResponsesStreamEvent[] = [
  { type: 'response.created' } as ResponsesStreamEvent,
  { type: 'response.output_text.delta', delta: 'Listed files.' } as ResponsesStreamEvent,
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      usage: { input_tokens: 15, output_tokens: 3, total_tokens: 18 },
    },
  } as unknown as ResponsesStreamEvent,
];

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1: Multi-round tool loop — Chat Completions wire
// ═══════════════════════════════════════════════════════════════════════════

describe('openai-compatible multi-round tool loop — Chat Completions wire', () => {
  afterEach(() => {
    __setOpenAIClientFactory(null);
  });

  it('drives two rounds (tool_call → bash dispatch → final text) via the provider', async () => {
    // Drive through OpenAICompatibleProvider.query() so the built-in
    // SessionToolDispatcher is wired (tools array + dispatch path are live).
    const { factory, allCreateArgs } = makeScriptedChatClient([chatTurn1, chatTurn2]);
    __setOpenAIClientFactory(factory);

    const provider = new OpenAICompatibleProvider({});
    const q = provider.query({
      prompt: singleInput('run bash'),
      config: {
        model: 'gpt-4o-mini',
        apiKey: 'sk-openai-test',
        systemPrompt: 'You are a helpful assistant.',
      } as AgentConfig,
    });
    const events = await collect(q);

    // Two model calls were issued (tool round + final answer round).
    expect(allCreateArgs).toHaveLength(2);

    // First call carries a non-empty tools array (built-in tool catalog wired
    // by SessionToolDispatcher — bash should be in there).
    const firstTools = (allCreateArgs[0] as { tools?: unknown }).tools;
    expect(Array.isArray(firstTools)).toBe(true);
    const firstToolNames = (firstTools as Array<{ function?: { name?: string } }>)
      .map((t) => t.function?.name ?? '')
      .filter(Boolean);
    expect(firstToolNames).toContain('bash');

    // Second call messages carry the assistant tool_calls + tool result from
    // round 1 (history was properly appended between rounds).
    const secondMessages = (
      allCreateArgs[1] as { messages?: Array<{ role: string }> }
    ).messages ?? [];
    const roles = secondMessages.map((m) => m.role);
    expect(roles).toContain('assistant');
    expect(roles).toContain('tool');

    // Final text arrived.
    const textDeltas = events
      .filter((e) => e.type === 'delta.text')
      .map((e) => (e as { text: string }).text);
    expect(textDeltas.join('')).toContain('Done');

    // turn.completed emitted with aggregated usage across both rounds.
    const completed = events.find((e) => e.type === 'turn.completed') as
      | { usage: { inputTokens?: number; outputTokens?: number } }
      | undefined;
    expect(completed).toBeDefined();
    // 10+20 = 30 input, 5+4 = 9 output.
    expect(completed!.usage.inputTokens).toBe(30);
    expect(completed!.usage.outputTokens).toBe(9);
  });

  it('routes to OpenAICompatibleProvider (never AnthropicDirectProvider)', () => {
    const provider = new OpenAICompatibleProvider({});
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider).not.toBeInstanceOf(AnthropicDirectProvider);
  });

  it('emits a tool.output event after dispatching bash', async () => {
    const { factory } = makeScriptedChatClient([chatTurn1, chatTurn2]);
    __setOpenAIClientFactory(factory);

    const provider = new OpenAICompatibleProvider({});
    const q = provider.query({
      prompt: singleInput('echo hi'),
      config: { model: 'gpt-4o-mini', apiKey: 'sk-openai-test' } as AgentConfig,
    });
    const events = await collect(q);

    // The loop must have dispatched the bash tool and emitted tool.output.
    const toolOutput = events.find((e) => e.type === 'tool.output');
    expect(toolOutput).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2: Multi-round tool loop — Responses wire
// ═══════════════════════════════════════════════════════════════════════════

describe('openai-compatible multi-round tool loop — Responses wire', () => {
  const savedResponsesEnv = process.env['AFK_OPENAI_USE_RESPONSES'];

  beforeEach(() => {
    // Opt into Responses wire for every test in this suite.
    process.env['AFK_OPENAI_USE_RESPONSES'] = '1';
  });

  afterEach(() => {
    __setOpenAIClientFactory(null);
    if (savedResponsesEnv === undefined) delete process.env['AFK_OPENAI_USE_RESPONSES'];
    else process.env['AFK_OPENAI_USE_RESPONSES'] = savedResponsesEnv;
  });

  it('drives two rounds (function_call → bash dispatch → final text) via Responses wire', async () => {
    // Drive through OpenAICompatibleProvider.query() so the built-in
    // SessionToolDispatcher is wired — same pattern as the Chat Completions
    // suite. AFK_OPENAI_USE_RESPONSES=1 switches to the Responses wire; the
    // `__setOpenAIClientFactory` hook intercepts both `client.responses.create`
    // calls.
    //
    // Contract:
    //   - Both requests use Responses wire shape (input/instructions, no messages).
    //   - Second request's input[] carries a function_call_output item for the
    //     bash dispatch result — proving the loop seam is live.
    //   - Final text and aggregated usage are correct.

    const { factory, allCreateArgs } = makeScriptedResponsesClient([
      responsesRound1,
      responsesRound2,
    ]);
    __setOpenAIClientFactory(factory);

    const provider = new OpenAICompatibleProvider({});
    const q = provider.query({
      prompt: singleInput('list files'),
      config: {
        model: 'gpt-5',
        apiKey: 'sk-openai-test',
        systemPrompt: 'You are a file explorer.',
      } as AgentConfig,
    });
    const events = await collect(q);

    // Two Responses API calls were issued (one tool round + one final text round).
    expect(allCreateArgs).toHaveLength(2);

    // Both calls use Responses wire shape: `input` + `instructions`, NOT `messages`.
    // The provider assembles the full system prompt (toolBase + userSystem + env),
    // so `instructions` contains the user's system prompt as a substring.
    for (const args of allCreateArgs) {
      expect(args['messages']).toBeUndefined();
      expect(typeof args['instructions']).toBe('string');
      expect(args['instructions'] as string).toContain('You are a file explorer.');
      expect(args['input']).toBeDefined();
    }

    // First call carries a tools array (bash is in the built-in tool catalog).
    const firstTools = allCreateArgs[0]?.['tools'];
    expect(Array.isArray(firstTools)).toBe(true);
    const firstToolNames = (firstTools as Array<{ name?: string }>)
      .map((t) => t.name ?? '')
      .filter(Boolean);
    expect(firstToolNames).toContain('bash');

    // Second call: the function_call output must appear as a function_call_output
    // item in `input`, proving the loop seam threads tool results correctly.
    const secondInput = allCreateArgs[1]?.['input'] as Array<{ type: string }> | undefined;
    expect(Array.isArray(secondInput)).toBe(true);
    const resultItem = secondInput?.find((item) => item.type === 'function_call_output');
    expect(resultItem).toBeDefined();

    // Final text arrived.
    const textDeltas = events
      .filter((e) => e.type === 'delta.text')
      .map((e) => (e as { text: string }).text);
    expect(textDeltas.join('')).toContain('Listed');

    // turn.completed with aggregated usage: 8+15=23 in, 3+3=6 out.
    const completed = events.find((e) => e.type === 'turn.completed') as
      | { usage: { inputTokens?: number; outputTokens?: number } }
      | undefined;
    expect(completed).toBeDefined();
    expect(completed!.usage.inputTokens).toBe(23);
    expect(completed!.usage.outputTokens).toBe(6);
  });

  it('Responses wire sends stream:true and never sends messages field', async () => {
    // Direct OpenAICompatibleQuery with useResponsesApi:true is fine for
    // wire-shape assertions that don't drive a tool loop — no dispatcher needed.
    // AFK_OPENAI_USE_RESPONSES=1 is set by beforeEach, but useResponsesApi is
    // also accepted directly on the query opts (belt-and-suspenders).
    const { factory, allCreateArgs } = makeScriptedResponsesClient([
      [{ type: 'response.completed', response: { status: 'completed' } } as unknown as ResponsesStreamEvent],
    ]);
    __setOpenAIClientFactory(factory);

    const auth: OpenAIAuthResolution = { apiKey: 'sk-x', source: 'env' };
    const query = new OpenAICompatibleQuery({
      auth,
      model: 'gpt-5',
      synthesizedSessionId: 'sess-wire-check',
      promptStream: singleInput('hello'),
      config: { model: 'gpt-5', systemPrompt: 'sys' } as unknown as AgentConfig,
      useResponsesApi: true,
    });
    await collect(query);

    expect(allCreateArgs).toHaveLength(1);
    expect(allCreateArgs[0]!['stream']).toBe(true);
    expect(allCreateArgs[0]!['messages']).toBeUndefined();
    expect(allCreateArgs[0]!['input']).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3: Skill subagent fork under openai-compatible parent session
// ═══════════════════════════════════════════════════════════════════════════

describe('skill subagent fork — openai-compatible parent session', () => {
  beforeEach(() => {
    _resetRegistry();
    mockResolveCredentialForModel.mockClear();
    vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
  });

  afterEach(() => {
    _resetRegistry();
    vi.restoreAllMocks();
  });

  /** Common fork spy: captures `this` (the manager) and call args. */
  function installForkSpy(): {
    getManager: () => SubagentManager | undefined;
    getArgs: () => Parameters<SubagentManager['forkSubagent']>[0] | undefined;
  } {
    let capturedManager: SubagentManager | undefined;
    let capturedArgs: Parameters<SubagentManager['forkSubagent']>[0] | undefined;

    vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
      function (this: SubagentManager, args) {
        capturedManager = this;
        capturedArgs = args;
        return Promise.resolve({
          id: 'child-handle',
          runToResult: vi.fn().mockResolvedValue({
            status: 'succeeded',
            message: { content: 'skill result' },
          }),
          teardown: vi.fn().mockResolvedValue(undefined),
          getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
        }) as never;
      } as never,
    );

    return {
      getManager: () => capturedManager,
      getArgs: () => capturedArgs,
    };
  }

  it('forks the skill child with the correct child model and credential', async () => {
    registerSkill({
      name: 'oai-integration-probe',
      description: 'Probe skill for openai-compatible fork integration test',
      context: 'fork',
      handler: vi.fn(),
    });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
      'system.md': 'You are the oai-integration-probe skill.',
    });

    const { getManager, getArgs } = installForkSpy();

    // Resolver: parent is gpt-4o (OpenAI key), child is gpt-4o-mini (separate key).
    const resolveApiKeyForModel = vi.fn((model: string) =>
      model === 'gpt-4o' ? 'sk-openai-parent' : 'sk-openai-child',
    );

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'oai-parent-session',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
      apiKey: 'sk-openai-parent',
      defaultModel: 'gpt-4o',
      defaultSubagentModel: 'gpt-4o-mini',
      resolveApiKeyForModel,
    });

    const result = await executor.execute(makeCall({ name: 'oai-integration-probe' }));

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('skill result');

    // Resolver was called with the child model.
    expect(resolveApiKeyForModel).toHaveBeenCalledWith('gpt-4o-mini');

    // Child manager carries the child-resolved key (not the parent's).
    const childApiKey = (getManager() as unknown as { parentApiKey: string | undefined })
      .parentApiKey;
    expect(childApiKey).toBe('sk-openai-child');

    // forkSubagent was given the correct child model.
    expect(getArgs()!.config.model).toBe('gpt-4o-mini');
  });

  it('falls back to resolveCredentialForModel when no resolver is injected', async () => {
    registerSkill({
      name: 'oai-fallback-probe',
      description: 'Probe fallback credential resolution',
      context: 'fork',
      handler: vi.fn(),
    });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
      'system.md': 'Fallback skill body.',
    });

    const { getManager } = installForkSpy();

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'oai-fallback-parent',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
      apiKey: 'sk-openai-parent',
      defaultModel: 'gpt-4o',
      // No resolveApiKeyForModel → falls back to module-level mock.
    });

    await executor.execute(makeCall({ name: 'oai-fallback-probe' }));

    // The module-level resolveCredentialForModel mock was called.
    expect(mockResolveCredentialForModel).toHaveBeenCalled();
    // The resolved value reaches the child manager.
    const childApiKey = (getManager() as unknown as { parentApiKey: string | undefined })
      .parentApiKey;
    expect(childApiKey).toBe('sk-openai-resolved');
  });

  it('never leaks the OpenAI parent key to an Anthropic-routed child', async () => {
    // Cross-provider isolation: parent is gpt-4o (OpenAI), child is sonnet
    // (Anthropic). The resolver must return the Anthropic key for sonnet —
    // the parent's OpenAI key must never appear on the child manager.
    registerSkill({
      name: 'oai-to-ant-probe',
      description: 'Cross-provider credential isolation probe',
      context: 'fork',
      handler: vi.fn(),
    });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({
      'system.md': 'Cross-provider skill.',
    });

    const { getManager, getArgs } = installForkSpy();

    const resolveApiKeyForModel = vi.fn((model: string) =>
      model.startsWith('gpt') || model.startsWith('o') ? 'sk-openai-key' : 'sk-ant-key',
    );

    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'oai-cross-parent',
        getInputStreamRef: () => ({ pushUserMessage: () => {} }),
        abortSignal,
      },
      apiKey: 'sk-openai-key',
      defaultModel: 'gpt-4o',
      defaultSubagentModel: 'sonnet',   // Anthropic-routed child
      resolveApiKeyForModel,
    });

    await executor.execute(makeCall({ name: 'oai-to-ant-probe' }));

    // Child model is sonnet.
    expect(getArgs()!.config.model).toBe('sonnet');

    // Parent OpenAI key must NOT reach the child manager.
    const childApiKey = (getManager() as unknown as { parentApiKey: string | undefined })
      .parentApiKey;
    expect(childApiKey).not.toBe('sk-openai-key');
    expect(childApiKey).toBe('sk-ant-key');
  });
});
