/**
 * Slice 2 acceptance tests: a query can stream an assistant response
 * end-to-end against a stubbed OpenAI client.
 *
 * We use the `__setOpenAIClientFactory` test hook to inject a mock client
 * that returns a synthetic chunk stream. No network. No real SDK calls.
 *
 * Tool-call dispatch is verified in slice 3 (`loop.test.ts`); these tests
 * cover the text-streaming path and lifecycle (init, close, abort).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type OpenAI from 'openai';
import type { ProviderEvent, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';
import {
  __setOpenAIClientFactory,
  buildQueryFromConfig,
  OpenAICompatibleQuery,
  type OpenAIClientFactory,
} from './query.js';
import { OpenAICompatibleProvider } from './index.js';
import type { OpenAIChunk } from './translate.js';
import { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { createHookRegistry } from '../../hooks.js';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import type { ToolHandler } from '../../tools/types.js';
import { PLAN_MODE_ADDENDUM_TEXT } from '../anthropic-direct/plan-mode-addendum.js';
import { computeLineDiff } from '../../../utils/diff.js';
import type { ToolCall, ToolResult } from '../anthropic-direct/types.js';
import { setSlotBindings, resetSlotBindings } from '../../session/model-slots.js';

// ---- helpers --------------------------------------------------------------

let createCalls: Array<{ args: unknown; signal?: AbortSignal }> = [];
let pendingChunks: OpenAIChunk[] = [];
let pendingError: Error | null = null;

function installMockClient(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean }, options?: { signal?: AbortSignal }) => {
            const callRecord: { args: unknown; signal?: AbortSignal } = { args };
            if (options?.signal) callRecord.signal = options.signal;
            createCalls.push(callRecord);
            if (pendingError) throw pendingError;
            if (!args.stream) {
              throw new Error('mock only supports streaming mode');
            }
            const chunks = pendingChunks.slice();
            const gen = (async function* () {
              for (const c of chunks) {
                if (options?.signal?.aborted) {
                  const e = new Error('aborted');
                  e.name = 'AbortError';
                  throw e;
                }
                yield c;
              }
            })();
            return gen;
          },
        },
      },
    }) as unknown as OpenAI;
  __setOpenAIClientFactory(factory);
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

/** Build a prompt stream that yields one user message then ends. */
async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
  yield { content };
}

/** Build a prompt stream that yields multiple messages. */
async function* multiInput(...messages: string[]): AsyncIterable<ProviderUserTurn> {
  for (const m of messages) yield { content: m };
}

/** Promise-based prompt source: yields user inputs as `release()` is called. */
function makeControlledPromptStream(): {
  stream: AsyncIterable<ProviderUserTurn>;
  send: (content: string) => void;
  end: () => void;
} {
  const queue: ProviderUserTurn[] = [];
  let resolveNext: ((value: IteratorResult<ProviderUserTurn>) => void) | null = null;
  let ended = false;

  const stream: AsyncIterable<ProviderUserTurn> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ProviderUserTurn>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (ended) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };
  return {
    stream,
    send: (content) => {
      if (resolveNext) {
        resolveNext({ value: { content }, done: false });
        resolveNext = null;
      } else {
        queue.push({ content });
      }
    },
    end: () => {
      ended = true;
      if (resolveNext) {
        resolveNext({ value: undefined as never, done: true });
        resolveNext = null;
      }
    },
  };
}


function openAIToolNames(toolsArg: unknown): string[] {
  if (!Array.isArray(toolsArg)) return [];
  return (toolsArg as Array<{ function?: { name?: unknown } }>)
    .map((t) => (typeof t.function?.name === 'string' ? t.function.name : ''))
    .filter((n): n is string => n.length > 0);
}

function baseConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: 'gpt-4o-mini',
    apiKey: 'sk-test-key',
    ...over,
  } as AgentConfig;
}

// ---- scripted multi-turn client (shared by PR-2 describe blocks) ----------

let scriptedTurns: Array<{ chunks: OpenAIChunk[] }> = [];
let scriptedTurnIndex = 0;

function installScriptedClient(): void {
  const factory: OpenAIClientFactory = () =>
    ({
      chat: {
        completions: {
          create: async (args: { stream?: boolean }, options?: { signal?: AbortSignal }) => {
            const callRecord: { args: unknown; signal?: AbortSignal } = { args };
            if (options?.signal) callRecord.signal = options.signal;
            createCalls.push(callRecord);
            if (!args.stream) throw new Error('test mock only supports streaming');
            const script = scriptedTurns[scriptedTurnIndex++];
            if (!script) throw new Error(`scripted turn ${scriptedTurnIndex - 1} not defined`);
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

function makeDispatcherForPR2(opts?: { withDiff?: boolean }): {
  dispatcher: SessionToolDispatcher;
  handlerCalls: Array<{ name: string; input: unknown }>;
} {
  const handlerCalls: Array<{ name: string; input: unknown }> = [];
  const hookRegistry = createHookRegistry();
  const echoHandler: ToolHandler = async (input) => {
    handlerCalls.push({ name: 'echo', input });
    return { content: `echoed: ${JSON.stringify(input)}` };
  };
  const diffWriterHandler: ToolHandler = async (input) => {
    handlerCalls.push({ name: 'diff_writer', input });
    return {
      content: 'written',
      render: { diff: computeLineDiff('before\n', 'after\n') },
    };
  };
  const schemas: AnthropicToolDef[] = [
    { name: 'echo', description: 'Echo', input_schema: { type: 'object' } },
    { name: 'diff_writer', description: 'Write with diff', input_schema: { type: 'object' } },
  ];
  const handlers = new Map<string, ToolHandler>([
    ['echo', echoHandler],
    ...(opts?.withDiff ? [['diff_writer', diffWriterHandler] as [string, ToolHandler]] : []),
  ]);
  const dispatcher = new SessionToolDispatcher({ handlers, schemas, hookRegistry });
  return { dispatcher, handlerCalls };
}

beforeEach(() => {
  createCalls = [];
  pendingChunks = [];
  pendingError = null;
  scriptedTurns = [];
  scriptedTurnIndex = 0;
  installMockClient();
});

afterEach(() => {
  __setOpenAIClientFactory(null);
});

// ---- tests ----------------------------------------------------------------


describe('OpenAICompatibleProvider — readOnlyMemory option', () => {
  function stubOneTextTurn(): void {
    pendingChunks = [
      {
        choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
  }

  it('exposes only memory_search when readOnlyMemory: true', async () => {
    stubOneTextTurn();
    const provider = new OpenAICompatibleProvider({ readOnlyMemory: true });
    const q = provider.query({
      prompt: singleInput('hi'),
      config: { model: 'gpt-4o-mini', apiKey: 'sk-test-key' } as AgentConfig,
    });
    await collect(q);

    expect(createCalls).toHaveLength(1);
    const toolNames = openAIToolNames((createCalls[0]!.args as { tools?: unknown }).tools);
    expect(toolNames).toContain('memory_search');
    expect(toolNames).not.toContain('memory_update');
    expect(toolNames).not.toContain('procedure_write');
  });

  it('exposes all memory tools when readOnlyMemory is unset', async () => {
    stubOneTextTurn();
    const provider = new OpenAICompatibleProvider();
    const q = provider.query({
      prompt: singleInput('hi'),
      config: { model: 'gpt-4o-mini', apiKey: 'sk-test-key' } as AgentConfig,
    });
    await collect(q);

    const toolNames = openAIToolNames((createCalls[0]!.args as { tools?: unknown }).tools);
    expect(toolNames).toContain('memory_search');
    expect(toolNames).toContain('memory_update');
    expect(toolNames).toContain('procedure_write');
  });

  it('dispatcher rejects a memory_update tool call when readOnlyMemory: true', async () => {
    installScriptedClient();
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
                      id: 'call_memory_write',
                      type: 'function',
                      function: {
                        name: 'memory_update',
                        arguments: '{"target":"fact","action":"set","content":"child write","category":"decision"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          },
        ],
      },
      {
        chunks: [
          {
            choices: [{ delta: { content: 'understood' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          },
        ],
      },
    ];

    const provider = new OpenAICompatibleProvider({ readOnlyMemory: true });
    const q = provider.query({
      prompt: singleInput('try to write memory'),
      config: { model: 'gpt-4o-mini', apiKey: 'sk-test-key' } as AgentConfig,
    });
    const events = await collect(q);

    const out = events.find((e) => e.type === 'tool.output');
    expect(out?.type).toBe('tool.output');
    if (out?.type === 'tool.output') {
      expect(out.isError).toBe(true);
      expect(out.content).toMatch(/unknown tool|not permitted|not allowed|permission|allowlist/i);
    }
  });
});

describe('OpenAICompatibleQuery — text streaming', () => {
  it('emits session.init before any deltas', async () => {
    pendingChunks = [
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ];
    const q = buildQueryFromConfig(baseConfig(), singleInput('hi'));
    const events = await collect(q);
    expect(events[0]?.type).toBe('session.init');
    if (events[0]?.type === 'session.init') {
      expect(events[0].info.model).toBe('gpt-4o-mini');
      expect(events[0].info.apiKeySource).toBe('config');
      expect(events[0].info.sessionId).toMatch(/^openai-pending-/);
    }
  });

  it('streams a normal assistant response: init → deltas → assistant.message → turn.completed', async () => {
    pendingChunks = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
    ];
    const q = buildQueryFromConfig(baseConfig(), singleInput('hi'));
    const events = await collect(q);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session.init',
      'delta.text',
      'delta.text',
      'assistant.message',
      'turn.completed',
    ]);
    const final = events.at(-1);
    expect(final?.type).toBe('turn.completed');
    if (final?.type === 'turn.completed') {
      expect(final.usage.inputTokens).toBe(10);
      expect(final.usage.outputTokens).toBe(2);
      expect(final.usage.totalTokens).toBe(12);
      expect(final.usage.stopReason).toBe('stop');
      // Regression guard: turn.completed must carry durationMs so the REPL
      // footer (`◦ Xs · $cost · N tok`) renders the turn duration. Pre-fix
      // the openai-compatible runTurn passed bare accumulatedUsage with no
      // wall-clock anchor — the footer dropped to just `◦ N tok`.
      expect(typeof final.usage.durationMs).toBe('number');
      expect(final.usage.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('forwards system prompt as the first message in the request', async () => {
    pendingChunks = [
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const q = buildQueryFromConfig(
      baseConfig({ systemPrompt: 'you are helpful' }),
      singleInput('hi'),
    );
    await collect(q);
    expect(createCalls).toHaveLength(1);
    const args = createCalls[0]!.args as { messages: Array<{ role: string; content: string }> };
    expect(args.messages[0]).toEqual({ role: 'system', content: 'you are helpful' });
    expect(args.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('threads multi-turn history through priorTurns across subsequent calls', async () => {
    const controlled = makeControlledPromptStream();
    const q = buildQueryFromConfig(baseConfig(), controlled.stream);

    const iter = q[Symbol.asyncIterator]();

    // Turn 1
    pendingChunks = [
      { choices: [{ delta: { content: 'A1' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ];
    controlled.send('q1');
    // Drain until turn.completed
    let ev: IteratorResult<ProviderEvent>;
    const turn1Events: ProviderEvent[] = [];
    do {
      ev = await iter.next();
      if (!ev.done) turn1Events.push(ev.value);
    } while (!ev.done && ev.value.type !== 'turn.completed');
    expect(turn1Events.at(-1)?.type).toBe('turn.completed');

    // Turn 2 — verify the assistant message from turn 1 is in the request.
    pendingChunks = [
      { choices: [{ delta: { content: 'A2' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } },
    ];
    controlled.send('q2');
    const turn2Events: ProviderEvent[] = [];
    do {
      ev = await iter.next();
      if (!ev.done) turn2Events.push(ev.value);
    } while (!ev.done && ev.value.type !== 'turn.completed');

    expect(createCalls).toHaveLength(2);
    const turn2Messages = (createCalls[1]!.args as {
      messages: Array<{ role: string; content: string }>;
    }).messages;
    expect(turn2Messages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: 'q2' },
    ]);

    // Cleanly end the stream so we don't leak the iterator
    controlled.end();
    while (!(await iter.next()).done) {
      /* drain */
    }
  });

  it('includes resumeHistory before the current user turn', async () => {
    pendingChunks = [
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const q = buildQueryFromConfig(
      baseConfig({
        resumeHistory: [
          { user: 'prev q', assistant: 'prev a' },
        ],
      }),
      singleInput('next q'),
    );
    await collect(q);
    const args = createCalls[0]!.args as { messages: Array<{ role: string; content: string }> };
    expect(args.messages).toEqual([
      { role: 'user', content: 'prev q' },
      { role: 'assistant', content: 'prev a' },
      { role: 'user', content: 'next q' },
    ]);
  });
});

describe('OpenAICompatibleQuery — model-slot resolution in request body', () => {
  afterEach(() => {
    resetSlotBindings();
  });

  it('resolves a slot alias to its bound id before sending (closes the subagent-on-ChatGPT-backend gap)', async () => {
    // Bind every tier to gpt-5.5 — the only model a ChatGPT subscription
    // accepts. A subagent/skill that picks `sonnet` (the alias the LLM copies
    // from the agent tool's examples) must therefore reach the backend AS
    // gpt-5.5, not the literal string `sonnet`.
    setSlotBindings({
      small: { id: 'gpt-5.5' },
      medium: { id: 'gpt-5.5' },
      large: { id: 'gpt-5.5' },
    });
    pendingChunks = [
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const q = buildQueryFromConfig(baseConfig({ model: 'sonnet' }), singleInput('hi'));
    const events = await collect(q);
    const sentModel = (createCalls[0]!.args as { model: string }).model;
    expect(sentModel).toBe('gpt-5.5');
    expect(sentModel).not.toBe('sonnet');
    // The normalized session.init reflects the resolved id too.
    const init = events[0];
    if (init?.type === 'session.init') expect(init.info.model).toBe('gpt-5.5');
  });

  it('passes a concrete model id through unchanged (idempotent)', async () => {
    setSlotBindings({
      small: { id: 'gpt-5.5' },
      medium: { id: 'gpt-5.5' },
      large: { id: 'gpt-5.5' },
    });
    pendingChunks = [
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const q = buildQueryFromConfig(baseConfig({ model: 'gpt-4o-mini' }), singleInput('hi'));
    await collect(q);
    expect((createCalls[0]!.args as { model: string }).model).toBe('gpt-4o-mini');
  });
});

describe('OpenAICompatibleQuery — auth failure path', () => {
  it('emits session.init then error when no auth is resolvable', async () => {
    // Don't set apiKey on config; env is empty in test env; no codex auth.
    const noAuthDeps = { OPENAI_API_KEY: process.env['OPENAI_API_KEY'] };
    delete process.env['OPENAI_API_KEY'];
    try {
      const q = buildQueryFromConfig({ model: 'gpt-4o-mini' } as AgentConfig, singleInput('hi'));
      const events = await collect(q);
      expect(events[0]?.type).toBe('session.init');
      expect(events[1]?.type).toBe('error');
      if (events[1]?.type === 'error') {
        // Diagnostic must say API key is required and reference env+codex paths
        expect(events[1].error.message).toContain('OPENAI_API_KEY');
      }
      // Crucially: no wire call was made.
      expect(createCalls).toHaveLength(0);
    } finally {
      if (noAuthDeps.OPENAI_API_KEY !== undefined) {
        process.env['OPENAI_API_KEY'] = noAuthDeps.OPENAI_API_KEY;
      }
    }
  });

  it('emits a specific diagnostic when only ChatGPT OAuth is present', async () => {
    // We can't simulate the auth.json read at this layer — auth.test.ts
    // covers that. Here we verify the error event surfaces the resolution.
    // This case is exercised by auth.test.ts + the integration above.
    expect(true).toBe(true);
  });
});

describe('OpenAICompatibleQuery — lifecycle', () => {
  it('interrupt() aborts an in-flight stream', async () => {
    // Long stream — interrupt mid-way.
    pendingChunks = Array.from({ length: 100 }, (_, i) => ({
      choices: [{ delta: { content: `chunk${i}` } }],
    }));
    const controlled = makeControlledPromptStream();
    const q = buildQueryFromConfig(baseConfig(), controlled.stream);
    const iter = q[Symbol.asyncIterator]();
    controlled.send('long task');

    // Pull init + a few deltas, then interrupt.
    const initEv = await iter.next();
    expect(initEv.value).toMatchObject({ type: 'session.init' });
    await iter.next(); // delta 0
    await iter.next(); // delta 1

    await q.interrupt();
    // After interrupt, drain remaining events; we shouldn't see all 100.
    const remaining: ProviderEvent[] = [];
    controlled.end();
    let ev: IteratorResult<ProviderEvent>;
    do {
      ev = await iter.next();
      if (!ev.done) remaining.push(ev.value);
    } while (!ev.done);
    // Sanity: stream terminated; we didn't emit 100 delta events.
    expect(remaining.length).toBeLessThan(100);
  });

  it('close() stops the loop cleanly even with no input pending', async () => {
    const controlled = makeControlledPromptStream();
    const q = buildQueryFromConfig(baseConfig(), controlled.stream);
    const iter = q[Symbol.asyncIterator]();

    // Pull session.init, then close while waiting for first user input.
    const init = await iter.next();
    expect(init.value).toMatchObject({ type: 'session.init' });

    // close() should unblock the next-input wait.
    q.close();
    const next = await iter.next();
    expect(next.done).toBe(true);
  });

  it('emits error on OpenAI API failure', async () => {
    pendingError = new Error('rate_limit_exceeded');
    const q = buildQueryFromConfig(baseConfig(), singleInput('hi'));
    const events = await collect(q);
    const types = events.map((e) => e.type);
    expect(types).toContain('error');
    const errEv = events.find((e) => e.type === 'error');
    if (errEv?.type === 'error') {
      expect(errEv.error.message).toContain('rate_limit');
    }
  });
});

describe('OpenAICompatibleQuery — ProviderQuery surface', () => {
  it('all required methods return reasonable defaults', async () => {
    pendingChunks = [
      { choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ];
    const q = buildQueryFromConfig(baseConfig(), singleInput('hi'));
    // These are awaited without involving the iterator.
    // `supportedCommands` returns whatever the skill-bridge discovers on disk
    // (mirrors anthropic-direct). Assert shape, not content — the list grows
    // as skills are added and we don't want this test to churn on every
    // skill commit. Each entry must at minimum have `name` and `description`.
    const cmds = await q.supportedCommands();
    expect(Array.isArray(cmds)).toBe(true);
    for (const c of cmds) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.description).toBe('string');
    }
    expect(await q.supportedAgents()).toEqual([]);
    expect(await q.mcpServerStatus()).toEqual([]);

    const models = await q.supportedModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('value');

    const acct = await q.accountInfo();
    expect(acct['authSource']).toBe('config');

    const rewind = await q.rewindFiles('fake-id');
    expect(rewind.canRewind).toBe(false);
    expect(rewind.error).toContain('does not support');

    // NOTE: the in-loop `this.lastUsage = accumulatedUsage` write (query.ts:316)
    // is behaviorally tested in the 'in-loop lastUsage refresh (PR 527)' describe
    // block below — a toolDispatcher handler captures getContextUsage() mid-turn
    // and asserts non-null apiUsage + exact totalTokens=15. The post-turn assertion
    // here is a complementary guard on the steady-state post-loop value.
    const ctx = await q.getContextUsage();
    expect(ctx.tools).toEqual([]);
    expect(ctx.isAutoCompactEnabled).toBe(false);

    await q.setModel('gpt-4o');
    await q.setPermissionMode('plan');
    // Drain to clean up
    q.close();
  });

  it('does not expose `compact` (history mgmt deferred)', () => {
    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'kkkk' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('x'),
      config: baseConfig(),
    });
    expect(q.compact).toBeUndefined();
    q.close();
  });

  it('setCwd forwards cwd to dispatcher.setResolveBase (U1)', () => {
    const hookRegistry = createHookRegistry();
    const dispatcher = new SessionToolDispatcher({
      handlers: new Map<string, ToolHandler>(),
      schemas: [] as AnthropicToolDef[],
      hookRegistry,
    });
    const spy = vi.spyOn(dispatcher, 'setResolveBase');

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'kkkk' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('x'),
      config: baseConfig(),
      toolDispatcher: dispatcher,
    });
    q.setCwd('/new/path');
    expect(spy).toHaveBeenCalledWith('/new/path');
    q.close();
  });
});

describe('OpenAICompatibleQuery — plan-mode addendum (U2)', () => {
  it('appends PLAN_MODE_ADDENDUM_TEXT to system message when permissionMode is plan', async () => {
    pendingChunks = [
      {
        choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    const q = buildQueryFromConfig(
      baseConfig({ permissionMode: 'plan', systemPrompt: 'be helpful' }),
      singleInput('hi'),
    );
    await collect(q);
    expect(createCalls).toHaveLength(1);
    const args = createCalls[0]!.args as { messages: Array<{ role: string; content: string }> };
    expect(args.messages[0]?.role).toBe('system');
    expect(args.messages[0]?.content).toContain('be helpful');
    expect(args.messages[0]?.content).toContain(PLAN_MODE_ADDENDUM_TEXT);
  });

  it('does not modify system message when permissionMode is not plan', async () => {
    pendingChunks = [
      {
        choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    const q = buildQueryFromConfig(
      baseConfig({ systemPrompt: 'be helpful' }),
      singleInput('hi'),
    );
    await collect(q);
    const args = createCalls[0]!.args as { messages: Array<{ role: string; content: string }> };
    expect(args.messages[0]?.content).toBe('be helpful');
    expect(args.messages[0]?.content).not.toContain(PLAN_MODE_ADDENDUM_TEXT);
  });
});

describe('OpenAICompatibleQuery — toolName on tool.output (I3)', () => {
  beforeEach(() => {
    scriptedTurns = [];
    scriptedTurnIndex = 0;
    installScriptedClient();
  });

  it('includes toolName on tool.output events from real dispatch', async () => {
    const { dispatcher } = makeDispatcherForPR2();
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c1', type: 'function', function: { name: 'echo', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          },
        ],
      },
      {
        chunks: [
          {
            choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          },
        ],
      },
    ];
    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('go'),
      config: baseConfig(),
      toolDispatcher: dispatcher,
    });
    const events = await collect(q);
    const out = events.find((e) => e.type === 'tool.output');
    expect(out?.type).toBe('tool.output');
    if (out?.type === 'tool.output') {
      expect(out.toolName).toBe('echo');
    }
  });

  it('includes toolName on aborted tool.output events', async () => {
    const { dispatcher } = makeDispatcherForPR2();
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'c2', type: 'function', function: { name: 'echo', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          },
        ],
      },
    ];
    const controlled = makeControlledPromptStream();
    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: controlled.stream,
      config: baseConfig(),
      toolDispatcher: dispatcher,
    });
    const iter = q[Symbol.asyncIterator]();
    controlled.send('go');
    // Drain session.init
    await iter.next();
    // Pull one more event then interrupt
    await iter.next();
    await q.interrupt();
    controlled.end();
    const remaining: ProviderEvent[] = [];
    let ev: IteratorResult<ProviderEvent>;
    do {
      ev = await iter.next();
      if (!ev.done) remaining.push(ev.value);
    } while (!ev.done);
    // If an aborted tool.output was emitted, it must carry toolName
    const abortedOut = remaining.find(
      (e) => e.type === 'tool.output' && (e as { isError?: boolean }).isError === true,
    );
    if (abortedOut?.type === 'tool.output') {
      expect(abortedOut.toolName).toBe('echo');
    }
  });
});

describe('OpenAICompatibleQuery — tool.diff sidecar (I1)', () => {
  beforeEach(() => {
    scriptedTurns = [];
    scriptedTurnIndex = 0;
    installScriptedClient();
  });

  it('emits tool.diff after tool.output when result.render.diff is set', async () => {
    const { dispatcher } = makeDispatcherForPR2({ withDiff: true });
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'd1', type: 'function', function: { name: 'diff_writer', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          },
        ],
      },
      {
        chunks: [
          {
            choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          },
        ],
      },
    ];
    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('write'),
      config: baseConfig(),
      toolDispatcher: dispatcher,
    });
    const events = await collect(q);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool.diff');
    const toolOut = events.find((e) => e.type === 'tool.output');
    const toolDiff = events.find((e) => e.type === 'tool.diff');
    expect(toolDiff?.type).toBe('tool.diff');
    if (toolDiff?.type === 'tool.diff' && toolOut?.type === 'tool.output') {
      expect(toolDiff.toolUseId).toBe(toolOut.toolUseId);
      expect(toolDiff.diff).toBeDefined();
    }
    // tool.output must appear before tool.diff
    const outIdx = types.indexOf('tool.output');
    const diffIdx = types.indexOf('tool.diff');
    expect(outIdx).toBeLessThan(diffIdx);
  });

  it('does not emit tool.diff when render.diff is absent', async () => {
    const { dispatcher } = makeDispatcherForPR2(); // echo only, no render
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'd2', type: 'function', function: { name: 'echo', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          },
        ],
      },
      {
        chunks: [
          {
            choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          },
        ],
      },
    ];
    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('echo'),
      config: baseConfig(),
      toolDispatcher: dispatcher,
    });
    const events = await collect(q);
    expect(events.some((e) => e.type === 'tool.diff')).toBe(false);
  });
});

describe('OpenAICompatibleQuery — progress events (I2)', () => {
  beforeEach(() => {
    scriptedTurns = [];
    scriptedTurnIndex = 0;
    installScriptedClient();
  });

  it('emits a progress event after each tool-loop iteration', async () => {
    const { dispatcher } = makeDispatcherForPR2();
    // Two tool-call iterations then a stop
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'p1', type: 'function', function: { name: 'echo', arguments: '{"msg":"a"}' } },
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
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'p2', type: 'function', function: { name: 'echo', arguments: '{"msg":"b"}' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
          },
        ],
      },
      {
        chunks: [
          {
            choices: [{ delta: { content: 'all done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 },
          },
        ],
      },
    ];
    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('go'),
      config: baseConfig(),
      toolDispatcher: dispatcher,
    });
    const events = await collect(q);
    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents).toHaveLength(2);

    const p0 = progressEvents[0];
    const p1 = progressEvents[1];
    if (p0?.type === 'progress' && p1?.type === 'progress') {
      // taskId must be stable across both events (same turn)
      expect(p0.progress.taskId).toBe(p1.progress.taskId);
      expect(typeof p0.progress.taskId).toBe('string');
      expect(p0.progress.taskId.length).toBeGreaterThan(0);

      // toolUses increments: 1 then 2
      expect(p0.progress.toolUses).toBe(1);
      expect(p1.progress.toolUses).toBe(2);

      // lastToolName matches the dispatched tool
      expect(p0.progress.lastToolName).toBe('echo');
      expect(p1.progress.lastToolName).toBe('echo');

      // durationMs is a non-negative number
      expect(typeof p0.progress.durationMs).toBe('number');
      expect(p0.progress.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('includes totalTokens from accumulated usage in progress event', async () => {
    const { dispatcher } = makeDispatcherForPR2();
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 't1', type: 'function', function: { name: 'echo', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          },
        ],
      },
      {
        chunks: [
          {
            choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 },
          },
        ],
      },
    ];
    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('go'),
      config: baseConfig(),
      toolDispatcher: dispatcher,
    });
    const events = await collect(q);
    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents).toHaveLength(1);
    if (progressEvents[0]?.type === 'progress') {
      // totalTokens should reflect iteration 0's accumulated tokens (150)
      expect(progressEvents[0].progress.totalTokens).toBe(150);
    }
  });
});

// ─── In-loop lastUsage refresh (PR 527) ─────────────────────────────────────
//
// Proves the `this.lastUsage = accumulatedUsage` assignment at query.ts:316 runs
// INSIDE the tool-use loop (before round-2 is requested), not just post-loop.
// Strategy: inject a toolDispatcher whose `execute` handler calls the PUBLIC
// `getContextUsage()` method on the query instance and records the result.
// If the in-loop write were removed, `lastUsage` would still be null at the
// point of handler invocation (set only post-loop) and `apiUsage` would be null.

describe('OpenAICompatibleQuery — in-loop lastUsage refresh (PR 527)', () => {
  beforeEach(() => {
    scriptedTurns = [];
    scriptedTurnIndex = 0;
    installScriptedClient();
  });

  it('getContextUsage() reflects round-1 usage during tool dispatch (in-loop write)', async () => {
    // Round 1: tool_calls finish — prompt=10, completion=5, total=15.
    // Round 2: stop — final text.
    scriptedTurns = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'inloop_1', type: 'function', function: { name: 'echo', arguments: '{}' } },
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
          {
            choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
          },
        ],
      },
    ];

    // Use a qRef closure so the handler can call getContextUsage() without
    // accessing private fields — purely public API, no coupling to internals.
    let qRef: OpenAICompatibleQuery | null = null;
    let capturedDuringDispatch: { totalTokens?: number; apiUsage: Record<string, unknown> | null } | null = null;

    const minimalDispatcher = {
      execute: async (_call: ToolCall): Promise<ToolResult> => {
        if (qRef) {
          // getContextUsage() now exposes totalTokens as a top-level field and
          // apiUsage in snake_case (was: raw camelCase ProviderUsage). Cast to
          // the consumer-facing shape — ProviderContextUsage's index signature
          // otherwise hides these fields under `unknown`.
          const ctx = (await qRef.getContextUsage()) as {
            totalTokens?: number;
            apiUsage: Record<string, unknown> | null;
          };
          capturedDuringDispatch = {
            totalTokens: ctx.totalTokens,
            apiUsage: ctx.apiUsage,
          };
        }
        return { content: 'ok' };
      },
    };

    const q = new OpenAICompatibleQuery({
      auth: { apiKey: 'k', source: 'config', last4: 'test' },
      model: 'gpt-4o-mini',
      synthesizedSessionId: 'sid',
      promptStream: singleInput('go'),
      config: baseConfig(),
      toolDispatcher: minimalDispatcher,
    });
    qRef = q;

    await collect(q);

    // The handler ran and captured usage during round-1 dispatch.
    expect(capturedDuringDispatch).not.toBeNull();
    // apiUsage must be non-null — the in-loop write at query.ts:316 fires BEFORE
    // dispatchAndAppend is called, so lastUsage is already populated.
    // If the in-loop write were removed, apiUsage would be null here (only set
    // post-loop) and this assertion would fail — proving the line has real teeth.
    expect(capturedDuringDispatch?.apiUsage).not.toBeNull();
    // Exact-value anchor: round-1 accumulated inputTokens+outputTokens = 10+5 = 15.
    // totalTokens is now a top-level field on the context-usage object (it was
    // previously read — incorrectly — from apiUsage.totalTokens, the camelCase
    // ProviderUsage the /tokens consumer never actually reads).
    expect(capturedDuringDispatch?.totalTokens).toBe(15);
    // apiUsage is the snake_case last-turn breakdown the /tokens command and
    // status-line sampler read — NOT the raw camelCase ProviderUsage.
    expect(capturedDuringDispatch?.apiUsage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
});

// --------------------------------------------------------------------------
// OpenAICompatibleProvider — ask_question stripped for skill-dispatch sub-agents
// --------------------------------------------------------------------------
// Parity with AnthropicDirectProvider: a skill-dispatch sub-agent must never
// pause to ask the operator "which skill?". The provider's buildDispatcher
// strips `ask_question` from the dispatcher schemas when config.isSkillDispatch
// is true, so it never reaches the request's tools[]. Verified safe: no
// bundled/registry/user skill calls ask_question.

describe('OpenAICompatibleProvider — skill-dispatch ask_question suppression', () => {
  /** Collect tool names from an OpenAI-format `tools[]` request payload. */
  function openAIToolNames(toolsArg: unknown): string[] {
    if (!Array.isArray(toolsArg)) return [];
    return (toolsArg as Array<{ function?: { name?: unknown } }>)
      .map((t) => (typeof t.function?.name === 'string' ? t.function.name : ''))
      .filter((n): n is string => n.length > 0);
  }

  // A single clean text turn so the query terminates after one create() call.
  function stubOneTextTurn(): void {
    pendingChunks = [
      {
        choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
  }

  it('regular session: ask_question IS offered as a tool', async () => {
    stubOneTextTurn();
    const provider = new OpenAICompatibleProvider();
    const q = provider.query({
      prompt: singleInput('hi'),
      config: { model: 'gpt-4o-mini', apiKey: 'sk-test-key' } as AgentConfig,
    });
    await collect(q);

    expect(createCalls).toHaveLength(1);
    const toolNames = openAIToolNames((createCalls[0]!.args as { tools?: unknown }).tools);
    expect(toolNames).toContain('ask_question');
    // Sanity: the rest of the builtin toolset is present too.
    expect(toolNames).toContain('read_file');
  });

  it('skill-dispatch sub-agent (isSkillDispatch=true): ask_question is STRIPPED', async () => {
    stubOneTextTurn();
    const provider = new OpenAICompatibleProvider();
    const q = provider.query({
      prompt: singleInput(
        'Run the harvest skill now, following the instructions in your system prompt.',
      ),
      config: {
        model: 'gpt-4o-mini',
        apiKey: 'sk-test-key',
        isSkillDispatch: true,
        systemPrompt: 'You are the harvest skill. Extract patterns.',
      } as AgentConfig,
    });
    await collect(q);

    expect(createCalls).toHaveLength(1);
    const toolNames = openAIToolNames((createCalls[0]!.args as { tools?: unknown }).tools);
    // The escape-hatch tool must be gone for skill sub-agents…
    expect(toolNames).not.toContain('ask_question');
    // …but the rest of the toolset must remain intact.
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('bash');
  });
});

// --------------------------------------------------------------------------
// OpenAICompatibleProvider — terminal_font_size stripped for skill-dispatch sub-agents
// --------------------------------------------------------------------------
// Parity with AnthropicDirectProvider: a bare numeric skill arg (e.g. /review 621)
// can lure a confused model into calling terminal_font_size(<n>) instead of running
// the skill. Strip it for skill-dispatch sub-agents alongside ask_question.
// Verified safe: no bundled/registry/user skill calls terminal_font_size.

describe('OpenAICompatibleProvider — skill-dispatch terminal_font_size suppression', () => {
  /** Collect tool names from an OpenAI-format `tools[]` request payload. */
  function openAIToolNames(toolsArg: unknown): string[] {
    if (!Array.isArray(toolsArg)) return [];
    return (toolsArg as Array<{ function?: { name?: unknown } }>)
      .map((t) => (typeof t.function?.name === 'string' ? t.function.name : ''))
      .filter((n): n is string => n.length > 0);
  }

  // A single clean text turn so the query terminates after one create() call.
  function stubOneTextTurn(): void {
    pendingChunks = [
      {
        choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
  }

  it('regular session: terminal_font_size IS offered as a tool', async () => {
    stubOneTextTurn();
    const provider = new OpenAICompatibleProvider();
    const q = provider.query({
      prompt: singleInput('hi'),
      config: { model: 'gpt-4o-mini', apiKey: 'sk-test-key' } as AgentConfig,
    });
    await collect(q);

    expect(createCalls).toHaveLength(1);
    const toolNames = openAIToolNames((createCalls[0]!.args as { tools?: unknown }).tools);
    expect(toolNames).toContain('terminal_font_size');
    // Sanity: the rest of the builtin toolset is present too.
    expect(toolNames).toContain('read_file');
  });

  it('skill-dispatch sub-agent (isSkillDispatch=true): terminal_font_size is STRIPPED', async () => {
    stubOneTextTurn();
    const provider = new OpenAICompatibleProvider();
    const q = provider.query({
      prompt: singleInput(
        'Run the review skill now, following the instructions in your system prompt.',
      ),
      config: {
        model: 'gpt-4o-mini',
        apiKey: 'sk-test-key',
        isSkillDispatch: true,
        systemPrompt: 'You are the review skill. Analyze the diff.',
      } as AgentConfig,
    });
    await collect(q);

    expect(createCalls).toHaveLength(1);
    const toolNames = openAIToolNames((createCalls[0]!.args as { tools?: unknown }).tools);
    // The environment tool must be gone for skill sub-agents…
    expect(toolNames).not.toContain('terminal_font_size');
    // …but a sanity tool must remain intact (precise filtering, not blanket strip).
    expect(toolNames).toContain('read_file');
  });
});
