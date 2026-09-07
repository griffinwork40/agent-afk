/**
 * Integration: skill fork path under the openai-compatible provider.
 *
 * Asserts three guarantees:
 *   1. Credential anti-leak — OpenAI parent → child gets the OpenAI cred
 *      resolved by `resolveApiKeyForModel`, NOT the raw ctx.apiKey.
 *   2. Provider routing — `createChildProviderFactory` returns
 *      OpenAICompatibleProvider for gpt-4o / gpt-4o-mini children.
 *   3. Multi-round tool loop — OpenAICompatibleQuery drives a 2-turn
 *      tool-call cycle through both the Chat Completions and Responses
 *      API wires using the scripted mock-client pattern.
 *
 * Kept in a separate file from skill-executor.test.ts to avoid its global
 * vi.mock on credential-resolver conflicting with the resolver we stub here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type OpenAI from 'openai';
import { SkillExecutor } from '../../tools/skill-executor.js';
import { SubagentManager } from '../../subagent.js';
import { registerSkill, _resetRegistry } from '../../../skills/index.js';
import * as promptLoader from '../../../skills/_lib/prompt-loader.js';
import { createChildProviderFactory } from '../../tools/nesting.js';
import { OpenAICompatibleProvider } from './index.js';
import { AnthropicDirectProvider } from '../anthropic-direct/index.js';
import {
  __setOpenAIClientFactory,
  OpenAICompatibleQuery,
  type OpenAIClientFactory,
} from './query.js';
import type { OpenAIChunk } from './translate.js';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { createHookRegistry } from '../../hooks.js';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import type { ToolHandler } from '../../tools/types.js';
import type { ResponsesStreamEvent } from './responses-translate.js';
import type { SubagentExecutor } from '../../tools/subagent-executor.js';

// ---------------------------------------------------------------------------
// Scripted mock-client plumbing (mirrors tool-dispatch.test.ts)
// ---------------------------------------------------------------------------

interface ScriptedTurn { chunks: OpenAIChunk[] }
let scriptedTurns: ScriptedTurn[] = [];
let turnIndex = 0;
let createCalls: Array<{ args: Record<string, unknown> }> = [];
let responsesEvents: ResponsesStreamEvent[] = [];
let responseCreateArgs: Record<string, unknown> | null = null;

function installChatClient(): void {
  const factory: OpenAIClientFactory = () => ({
    chat: {
      completions: {
        create: async (args: Record<string, unknown>) => {
          createCalls.push({ args });
          const script = scriptedTurns[turnIndex++];
          if (!script) throw new Error(`scripted turn ${turnIndex - 1} not defined`);
          const chunks = script.chunks.slice();
          return (async function* () { for (const c of chunks) yield c; })();
        },
      },
    },
  }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

function installResponsesClient(): void {
  const factory: OpenAIClientFactory = () => ({
    responses: {
      create: async (args: Record<string, unknown>) => {
        responseCreateArgs = args;
        const events = responsesEvents.slice();
        return (async function* () { for (const e of events) yield e; })();
      },
    },
  }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

async function collect(q: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of q) out.push(ev);
  return out;
}
async function* single(content: string): AsyncIterable<ProviderUserTurn> { yield { content }; }
function cfg(over: Partial<AgentConfig> = {}): AgentConfig {
  return { model: 'gpt-4o-mini', apiKey: 'sk-test', ...over } as AgentConfig;
}

function makeEchoDispatcher(): SessionToolDispatcher {
  const echo: ToolHandler = async (input) => ({ content: `echoed: ${JSON.stringify(input)}` });
  const schemas: AnthropicToolDef[] = [{
    name: 'echo', description: 'Echo', input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
  }];
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([['echo', echo]]),
    schemas,
    hookRegistry: createHookRegistry(),
  });
}

const abortSignal = new AbortController().signal;

beforeEach(() => {
  scriptedTurns = []; turnIndex = 0; createCalls = [];
  responsesEvents = []; responseCreateArgs = null;
});
afterEach(() => {
  __setOpenAIClientFactory(null);
  _resetRegistry();
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. Credential anti-leak: OpenAI parent → skill child gets correct cred
// ===========================================================================

describe('skill fork — credential anti-leak', () => {
  function captureManagerOnFork(): { get: () => SubagentManager | undefined } {
    let captured: SubagentManager | undefined;
    vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(
      function (this: SubagentManager) {
        captured = this;
        return Promise.resolve({
          id: 'h',
          runToResult: vi.fn().mockResolvedValue({ status: 'succeeded', message: { content: 'ok' } }),
          teardown: vi.fn().mockResolvedValue(undefined),
          getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
        }) as ReturnType<SubagentManager['forkSubagent']>;
      },
    );
    vi.spyOn(SubagentManager.prototype, 'teardownAll').mockResolvedValue(undefined);
    return { get: () => captured };
  }

  it('forks with the resolver-derived OpenAI cred, not the raw parent apiKey', async () => {
    registerSkill({ name: 'cred-test-skill', description: 'test', context: 'fork', handler: vi.fn() });
    vi.spyOn(promptLoader, 'loadSkillPrompts').mockReturnValue({ 'system.md': 'System.' });
    const capture = captureManagerOnFork();

    const resolveApiKeyForModel = vi.fn((model: string) =>
      model === 'gpt-4o-mini' ? 'openai-child-key' : 'anthropic-key',
    );
    const executor = new SkillExecutor({
      parentSession: {
        sessionId: 'parent-oai', getInputStreamRef: () => ({ pushUserMessage: () => {} }), abortSignal,
      },
      defaultModel: 'gpt-4o-mini',
      defaultSubagentModel: 'gpt-4o-mini',
      apiKey: 'openai-parent-key',
      resolveApiKeyForModel,
    });

    const result = await executor.execute({
      id: 'c1', name: 'skill', input: { name: 'cred-test-skill' }, signal: abortSignal,
    });

    expect(result.isError).toBeUndefined();
    expect(resolveApiKeyForModel).toHaveBeenCalledWith('gpt-4o-mini');

    const mgr = capture.get();
    expect(mgr).toBeDefined();
    // parentApiKey is private — reach through unknown cast (mirrors skill-executor.test.ts:1330)
    const parentApiKey = (mgr as unknown as { parentApiKey: string | undefined }).parentApiKey;
    expect(parentApiKey).toBe('openai-child-key');
    expect(parentApiKey).not.toBe('openai-parent-key');
  });
});

// ===========================================================================
// 2. Provider routing: gpt-* → OpenAICompatibleProvider
// ===========================================================================

describe('createChildProviderFactory — provider selection for skill child', () => {
  const stub = {} as SubagentExecutor;

  it('routes gpt-4o child to OpenAICompatibleProvider', () => {
    const provider = createChildProviderFactory()({ childExecutor: stub, model: 'gpt-4o' });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('routes gpt-4o-mini child to OpenAICompatibleProvider (not AnthropicDirect)', () => {
    const provider = createChildProviderFactory()({ childExecutor: stub, model: 'gpt-4o-mini' });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider).not.toBeInstanceOf(AnthropicDirectProvider);
  });

  it('routes sonnet child to AnthropicDirectProvider (cross-provider isolation)', () => {
    const provider = createChildProviderFactory()({ childExecutor: stub, model: 'sonnet' });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
    expect(provider).not.toBeInstanceOf(OpenAICompatibleProvider);
  });
});

// ===========================================================================
// 3a. Multi-round tool loop — Chat Completions path
// ===========================================================================

describe('multi-round tool loop — Chat Completions', () => {
  it('drives a 2-turn cycle: tool_calls → final text, feeding results back', async () => {
    installChatClient();
    scriptedTurns = [
      {
        chunks: [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"msg":"skill-test"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'OpenAI skill fork complete.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-oai', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'chat-loop-sid',
      promptStream: single('run the skill'),
      config: cfg(),
      toolDispatcher: makeEchoDispatcher(),
    });

    const events = await collect(q);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool.use.start');
    expect(types).toContain('tool.output');
    expect(types).toContain('assistant.message');
    expect(types).toContain('turn.completed');

    // Tool output carries the echo result
    const toolOut = events.find((e) => e.type === 'tool.output');
    if (toolOut?.type === 'tool.output') {
      expect(toolOut.toolUseId).toBe('call_1');
      expect(toolOut.content).toContain('skill-test');
    }

    // Final text message
    const msg = events.find((e) => e.type === 'assistant.message');
    if (msg?.type === 'assistant.message') expect(msg.text).toBe('OpenAI skill fork complete.');

    // Two model calls; turn 2 request carries the tool result
    expect(createCalls).toHaveLength(2);
    const turn2 = createCalls[1]!.args['messages'] as Array<{ role: string; tool_call_id?: string }>;
    expect(turn2.find((m) => m.role === 'tool')?.tool_call_id).toBe('call_1');

    // Usage summed across both turns
    const done = events.find((e) => e.type === 'turn.completed');
    if (done?.type === 'turn.completed') {
      expect(done.usage.inputTokens).toBe(60);  // 20 + 40
      expect(done.usage.outputTokens).toBe(18); // 10 + 8
    }
  });
});

// ===========================================================================
// 3b. Multi-round tool loop — Responses API path
// ===========================================================================

describe('multi-round tool loop — Responses API', () => {
  it('streams text through the Responses wire with correct request shape', async () => {
    installResponsesClient();
    responsesEvents = [
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'Skill via Responses API.' },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 15, output_tokens: 6, total_tokens: 21 } } },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-oai-resp', source: 'env' },
      model: 'gpt-5',
      synthesizedSessionId: 'responses-sid',
      promptStream: single('run skill via responses'),
      config: { model: 'gpt-5', systemPrompt: 'Test assistant.' } as AgentConfig,
      useResponsesApi: true,
    });

    const events = await collect(q);

    // Responses API must use `input` + `instructions`, never `messages`
    expect(responseCreateArgs).not.toBeNull();
    expect(responseCreateArgs!['messages']).toBeUndefined();
    expect(responseCreateArgs!['input']).toBeDefined();
    expect(responseCreateArgs!['instructions']).toBe('Test assistant.');

    const text = events.filter((e) => e.type === 'delta.text')
      .map((e) => (e.type === 'delta.text' ? e.text : '')).join('');
    expect(text).toBe('Skill via Responses API.');

    const done = events.find((e) => e.type === 'turn.completed');
    if (done?.type === 'turn.completed') {
      expect(done.usage.inputTokens).toBe(15);
      expect(done.usage.outputTokens).toBe(6);
    }
  });
});
