/**
 * Slice 3 acceptance: the query can execute at least one tool call and
 * return the result, with hooks/permissions/dispatch happening inside AFK
 * (not in any external SDK).
 *
 * These tests use:
 *   - a stubbed OpenAI client that scripts a multi-turn exchange:
 *     turn 1 → model emits tool_calls + finish_reason=tool_calls
 *     turn 2 → model emits final text + finish_reason=stop
 *   - a real `SessionToolDispatcher` with stub handlers + hooks so we
 *     verify the hook firing path and permission gate are exercised.
 *
 * The point is to prove the harness owns the dispatch path. If this test
 * passes, OpenAI models can use AFK's full tool surface (hooks, permissions,
 * built-in handlers) without involving Codex CLI or any harness-in-harness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { createHookRegistry } from '../../hooks.js';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import type { ToolHandler } from '../../tools/types.js';
import {
  __setOpenAIClientFactory,
  OpenAICompatibleQuery,
  type OpenAIClientFactory,
} from './query.js';
import type { OpenAIChunk } from './translate.js';

// ---- mock OpenAI client ---------------------------------------------------

interface ScriptedTurn {
  chunks: OpenAIChunk[];
}

let scriptedTurns: ScriptedTurn[] = [];
let turnIndex = 0;
let createCalls: Array<{ args: { messages: unknown[]; tools?: unknown[] } }> = [];

function installScriptedClient(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean; messages: unknown[]; tools?: unknown[] }) => {
            createCalls.push({ args });
            if (!args.stream) throw new Error('test mock only supports streaming');
            const script = scriptedTurns[turnIndex++];
            if (!script) {
              throw new Error(`scripted turn ${turnIndex - 1} not defined`);
            }
            const chunks = script.chunks.slice();
            return (async function* () {
              for (const c of chunks) yield c;
            })();
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of query) events.push(ev);
  return events;
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

// ---- dispatcher fixture ---------------------------------------------------

interface DispatcherFixture {
  dispatcher: SessionToolDispatcher;
  handlerCalls: Array<{ name: string; input: unknown }>;
  preHookFired: string[];
  postHookFired: string[];
}

function makeDispatcher(opts?: { allowedTools?: string[] }): DispatcherFixture {
  const handlerCalls: DispatcherFixture['handlerCalls'] = [];
  const preHookFired: string[] = [];
  const postHookFired: string[] = [];

  const echoHandler: ToolHandler = async (input) => {
    handlerCalls.push({ name: 'echo', input });
    return { content: `echoed: ${JSON.stringify(input)}` };
  };
  const failingHandler: ToolHandler = async () => {
    handlerCalls.push({ name: 'always_fail', input: null });
    return { content: 'permission denied by handler', isError: true };
  };

  const schemas: AnthropicToolDef[] = [
    {
      name: 'echo',
      description: 'Echo input back',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
    },
    {
      name: 'always_fail',
      description: 'Always returns an error',
      input_schema: { type: 'object' },
    },
  ];

  const hookRegistry = createHookRegistry();
  hookRegistry.register('PreToolUse', async (ctx) => {
    if (ctx.event === 'PreToolUse') preHookFired.push(ctx.toolName);
    return {};
  });
  hookRegistry.register('PostToolUse', async (ctx) => {
    if (ctx.event === 'PostToolUse') postHookFired.push(ctx.toolName);
    return {};
  });

  const dispatcherOpts: ConstructorParameters<typeof SessionToolDispatcher>[0] = {
    handlers: new Map<string, ToolHandler>([
      ['echo', echoHandler],
      ['always_fail', failingHandler],
    ]),
    schemas,
    hookRegistry,
  };
  if (opts?.allowedTools !== undefined) {
    dispatcherOpts.permissions = { allowedTools: opts.allowedTools };
  }

  const dispatcher = new SessionToolDispatcher(dispatcherOpts);

  return { dispatcher, handlerCalls, preHookFired, postHookFired };
}

beforeEach(() => {
  scriptedTurns = [];
  turnIndex = 0;
  createCalls = [];
  installScriptedClient();
});

afterEach(() => {
  __setOpenAIClientFactory(null);
});

// ---- tests ----------------------------------------------------------------

describe('OpenAICompatibleQuery — tool dispatch (slice 3)', () => {
  it('dispatches a single tool call and feeds the result back to the model', async () => {
    const fixture = makeDispatcher();

    // Turn 1: model decides to call echo.
    // Turn 2: model produces final text.
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'echo', arguments: '{"msg":"hi"}' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'Tool said hi back.' } }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
          },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-test', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid-1',
      promptStream: singleInput('please echo hi'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });

    const events = await collect(q);

    // Verify the event sequence (progress event added after tool dispatch — I2 parity)
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session.init',
      'tool.use.start',
      'tool.output',
      'progress',
      'delta.text',
      'assistant.message',
      'turn.completed',
    ]);

    // Verify the handler was actually invoked through the dispatcher
    expect(fixture.handlerCalls).toEqual([{ name: 'echo', input: { msg: 'hi' } }]);

    // Verify hooks fired
    expect(fixture.preHookFired).toContain('echo');
    expect(fixture.postHookFired).toContain('echo');

    // Verify the assistant message + tool output are surfaced
    const toolOutput = events.find((e) => e.type === 'tool.output');
    expect(toolOutput?.type).toBe('tool.output');
    if (toolOutput?.type === 'tool.output') {
      expect(toolOutput.toolUseId).toBe('call_1');
      expect(toolOutput.content).toBe('echoed: {"msg":"hi"}');
    }
    const finalMsg = events.find((e) => e.type === 'assistant.message');
    expect(finalMsg?.type).toBe('assistant.message');
    if (finalMsg?.type === 'assistant.message') {
      expect(finalMsg.text).toBe('Tool said hi back.');
    }
  });

  it('mints a synthetic id for an empty-id tool call and keeps assistant/tool-result ids matched', async () => {
    // Regression: local MLX/llama.cpp shims sometimes stream tool_calls with no
    // id. The provider must mint ONE synthetic id and use it on BOTH the
    // assistant turn's tool_calls[].id and the tool-result tool_call_id —
    // generating it independently in each builder would desync the pair and
    // produce a request OpenAI/strict shims reject with HTTP 400.
    const fixture = makeDispatcher();
    scriptedTurns = [
      {
        chunks: [
          {
            // NOTE: no `id` field on the tool call — the empty-id case.
            choices: [
              { delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'echo', arguments: '{"msg":"hi"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'done' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-test', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid-empty-id',
      promptStream: singleInput('please echo hi'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });

    await collect(q);

    // The call was dispatched (not dropped) despite the empty id.
    expect(fixture.handlerCalls).toEqual([{ name: 'echo', input: { msg: 'hi' } }]);

    // The SECOND request must carry a well-formed assistant tool_calls turn and
    // a matching tool-result message: same id, non-empty.
    expect(createCalls.length).toBe(2);
    const secondMessages = createCalls[1]!.args.messages as Array<Record<string, unknown>>;
    const assistantToolTurn = secondMessages.find(
      (m) => m['role'] === 'assistant' && Array.isArray(m['tool_calls']),
    );
    const toolResult = secondMessages.find((m) => m['role'] === 'tool');
    expect(assistantToolTurn).toBeDefined();
    expect(toolResult).toBeDefined();
    const assistantId = (assistantToolTurn!['tool_calls'] as Array<{ id: string }>)[0]!.id;
    const resultId = toolResult!['tool_call_id'] as string;
    expect(assistantId.length).toBeGreaterThan(0);
    expect(resultId).toBe(assistantId);
  });

  // Cross-provider parity: the openai-compatible `summarizeToolInput` is a
  // separate copy of the anthropic-direct helper (they must render identically
  // — see the docstring on each). This guards the skill-label behavior against
  // drift between the two copies: a skill dispatch must surface the skill name
  // as a paren-wrapped label in tool.use.start so the tool lane shows
  // `skill(diagnose)` rather than a bare `skill [skill]`.
  it('surfaces the skill name as a paren-wrapped label in tool.use.start', async () => {
    const fixture = makeDispatcher();

    // Turn 1: model dispatches the skill tool. Turn 2: final text so the
    // query terminates. The skill handler is unregistered in the fixture, but
    // tool.use.start fires BEFORE dispatch (query.ts), so the label is emitted
    // regardless of whether the dispatch itself succeeds.
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_skill',
                      type: 'function',
                      function: { name: 'skill', arguments: '{"name":"diagnose","arguments":"flaky test"}' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'done' } }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
          },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-test', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid-skill',
      promptStream: singleInput('diagnose this'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });

    const events = await collect(q);
    const start = events.find((e) => e.type === 'tool.use.start');
    expect(start?.type).toBe('tool.use.start');
    if (start?.type === 'tool.use.start') {
      expect(start.toolName).toBe('skill');
      expect(start.toolInput).toBe('(diagnose)');
    }
  });

  it("includes the tool catalog as 'tools' in the request", async () => {
    const fixture = makeDispatcher();
    scriptedTurns = [
      {
        chunks: [
          { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk-test', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('hi'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });
    await collect(q);

    expect(createCalls).toHaveLength(1);
    const tools = createCalls[0]!.args.tools as Array<{
      type: string;
      function: { name: string; parameters: unknown };
    }>;
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.function.name).sort()).toEqual(['always_fail', 'echo']);
    expect(tools[0]!.type).toBe('function');
    // input_schema renamed to parameters
    expect(tools[0]!.function.parameters).toBeDefined();
  });

  it('feeds tool results to the next turn in the correct OpenAI ordering', async () => {
    const fixture = makeDispatcher();
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_x', type: 'function', function: { name: 'echo', arguments: '{"msg":"a"}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('echo a'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });
    await collect(q);

    // Turn 2 request: must include the prior tool_calls + tool result in
    // OpenAI's strict ordering.
    expect(createCalls).toHaveLength(2);
    const turn2Messages = createCalls[1]!.args.messages as Array<{
      role: string;
      content?: unknown;
      tool_call_id?: string;
      tool_calls?: unknown[];
    }>;
    // Expect: user, assistant{tool_calls}, tool{tool_call_id}
    expect(turn2Messages).toHaveLength(3);
    expect(turn2Messages[0]).toMatchObject({ role: 'user', content: 'echo a' });
    expect(turn2Messages[1]).toMatchObject({ role: 'assistant' });
    expect(turn2Messages[1]!.tool_calls).toBeDefined();
    expect(turn2Messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_x',
      content: 'echoed: {"msg":"a"}',
    });
  });

  it('handles tool errors by surfacing the error in tool.output and prefixing in the next request', async () => {
    const fixture = makeDispatcher();
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_fail', type: 'function', function: { name: 'always_fail', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'sorry' }, finish_reason: 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 1, total_tokens: 16 } },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('break it'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });
    const events = await collect(q);

    // The tool.output event should carry isError=true
    const out = events.find((e) => e.type === 'tool.output');
    expect(out?.type).toBe('tool.output');
    if (out?.type === 'tool.output') {
      expect(out.isError).toBe(true);
      expect(out.content).toBe('permission denied by handler');
    }

    // The next request's tool message should be prefixed with [error]
    const turn2Messages = createCalls[1]!.args.messages as Array<{ role: string; content: string; tool_call_id?: string }>;
    const toolMsg = turn2Messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/^\[error\] /);
  });

  it('respects permission gate (allowedTools) — blocked tool returns error result', async () => {
    // echo is allowed; always_fail is in the gate but explicitly disallowed.
    const fixture = makeDispatcher({ allowedTools: ['echo'] });
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_x', type: 'function', function: { name: 'always_fail', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'understood' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('try the blocked tool'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });
    const events = await collect(q);

    // The handler should NOT have been invoked — permission gate caught it.
    // (Note: fixture.handlerCalls would include it ONLY if the handler ran.)
    expect(fixture.handlerCalls).toHaveLength(0);

    const out = events.find((e) => e.type === 'tool.output');
    expect(out?.type).toBe('tool.output');
    if (out?.type === 'tool.output') {
      expect(out.isError).toBe(true);
      expect(out.content).toMatch(/not permitted|not allowed|permission|allowlist/i);
    }
  });

  it('dispatches multiple parallel tool calls in one turn', async () => {
    const fixture = makeDispatcher();
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'a', type: 'function', function: { name: 'echo', arguments: '{"msg":"first"}' } },
                    { index: 1, id: 'b', type: 'function', function: { name: 'echo', arguments: '{"msg":"second"}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 1, total_tokens: 31 } },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('echo two things'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });
    const events = await collect(q);

    const toolOutputs = events.filter((e) => e.type === 'tool.output');
    expect(toolOutputs).toHaveLength(2);
    expect(fixture.handlerCalls).toHaveLength(2);

    // Turn 2 request must have BOTH tool result messages
    const turn2Messages = createCalls[1]!.args.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>;
    const toolMsgs = turn2Messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual(['a', 'b']);
  });

  it('sums usage across iterations into a single turn.completed event', async () => {
    const fixture = makeDispatcher();
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c', type: 'function', function: { name: 'echo', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('do it'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });
    const events = await collect(q);

    const completed = events.filter((e) => e.type === 'turn.completed');
    expect(completed).toHaveLength(1);
    if (completed[0]?.type === 'turn.completed') {
      expect(completed[0].usage.inputTokens).toBe(300); // 100 + 200
      expect(completed[0].usage.outputTokens).toBe(60); // 50 + 10
      expect(completed[0].usage.stopReason).toBe('stop'); // from last iteration
    }
  });

  it('surfaces malformed tool arguments as parse-error in the result fed to the model', async () => {
    const fixture = makeDispatcher();
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    // arguments isn't valid JSON
                    { index: 0, id: 'call_bad', type: 'function', function: { name: 'echo', arguments: '{not json' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
        ],
      },
      {
        chunks: [
          { choices: [{ delta: { content: 'sorry, will reformulate' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
        ],
      },
    ];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('bad args'),
      config: baseConfig(),
      toolDispatcher: fixture.dispatcher,
    });
    const events = await collect(q);

    // The tool.output should show the parse error attached to the result.
    const out = events.find((e) => e.type === 'tool.output');
    if (out?.type === 'tool.output') {
      expect(out.content).toMatch(/Failed to parse tool arguments/);
    }
  });

  // Shared helper: a turn where the model emits one tool_call and stops on
  // `tool_calls` (so the loop dispatches + iterates).
  const toolCallTurn = (id: string): ScriptedTurn => ({
    chunks: [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id, type: 'function', function: { name: 'echo', arguments: '{}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ],
  });

  it('caps tool rounds at an explicit maxToolUseIterations, then runs a tools-stripped wind-down round', async () => {
    // Explicit cap of 3 → 3 tool rounds, then ONE tools-stripped wind-down round
    // where the model answers in text (no silent stop). Mirrors anthropic-direct's
    // graceful cap; the shared policy lives in shared/tool-loop-cap.ts.
    const fixture = makeDispatcher();
    const windDownTurn: ScriptedTurn = {
      chunks: [
        { choices: [{ delta: { content: 'Final answer from gathered context.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ],
    };
    // 3 tool rounds + 1 wind-down text round.
    scriptedTurns = [toolCallTurn('c0'), toolCallTurn('c1'), toolCallTurn('c2'), windDownTurn];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('go'),
      config: baseConfig({ maxToolUseIterations: 3 }),
      toolDispatcher: fixture.dispatcher,
    });
    const events = await collect(q);

    // 3 tool-use rounds + 1 tools-stripped wind-down round = 4 model calls.
    expect(createCalls.length).toBe(4);
    // The first (tool) round advertised tools; the wind-down round (last) did not.
    expect(createCalls[0]!.args.tools?.length ?? 0).toBeGreaterThan(0);
    expect(createCalls[3]!.args.tools).toBeUndefined();
    // The wind-down produced a real final assistant message (not a silent stop).
    const assistantMsg = events.find((e) => e.type === 'assistant.message');
    expect(assistantMsg?.type === 'assistant.message' ? assistantMsg.text : '').toContain(
      'Final answer',
    );
    // Terminal turn.completed carries the capped stop reason → closure iteration_cap.
    const completed = events.at(-1);
    expect(completed?.type).toBe('turn.completed');
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('tool_use_loop_capped');
    }
  });

  it('runs uncapped at top level — past the former hard-coded 50-round limit (no maxToolUseIterations)', async () => {
    // Decision (a): with no config cap, top-level openai-compatible is uncapped
    // (matches anthropic-direct's DEFAULT_MAX_TOOL_USE_ITERATIONS=0), NOT the old
    // hard-coded 50. 52 tool rounds + a natural stop must all run, with no
    // wind-down and no `tool_use_loop_capped`.
    const fixture = makeDispatcher();
    const stopTurn: ScriptedTurn = {
      chunks: [
        { choices: [{ delta: { content: 'done' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ],
    };
    scriptedTurns = [...Array.from({ length: 52 }, (_, i) => toolCallTurn(`c${i}`)), stopTurn];

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('go'),
      config: baseConfig(), // no maxToolUseIterations → unlimited
      toolDispatcher: fixture.dispatcher,
    });
    const events = await collect(q);

    // 52 tool rounds + 1 natural-stop round = 53 model calls — the old cap would
    // have stopped at 50.
    expect(createCalls.length).toBe(53);
    const completed = events.at(-1);
    expect(completed?.type).toBe('turn.completed');
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).not.toBe('tool_use_loop_capped');
    }
  });
});

describe('OpenAICompatibleQuery — tool dispatch without dispatcher', () => {
  it('does not include tools[] in request when no dispatcher is provided', async () => {
    scriptedTurns = [
      {
        chunks: [
          { choices: [{ delta: { content: 'no tools' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ],
      },
    ];
    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'sk', source: 'config' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('hi'),
      config: baseConfig(),
      // no toolDispatcher
    });
    await collect(q);
    expect(createCalls[0]!.args.tools).toBeUndefined();
  });
});
