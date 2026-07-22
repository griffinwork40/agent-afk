/**
 * Integration tests for `anthropic-direct` provider.
 *
 * The Anthropic SDK is intercepted via the provider's
 * `__setAnthropicClientFactory` escape hatch — no real network, no real timers.
 *
 * Coverage:
 *  - provider name and synthetic `session.init`
 *  - missing api key error
 *  - oauth recipe (constructor opts, headers, system prefix)
 *  - api-key recipe (no oauth headers, no billing prefix)
 *  - text streaming → delta.text + assistant.message + turn.completed
 *  - tool-use loop (assistant tool_use → dispatcher → tool_result follow-up turn)
 *  - default RejectAllToolDispatcher returns isError
 *  - interrupt() aborts in-flight stream
 *  - close() unblocks promptIterator.next()
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  MessageParam,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../provider.js';
import {
  AnthropicDirectProvider,
  __setAnthropicClientFactory,
} from './anthropic-direct/index.js';
import {
  OAUTH_BETA_HEADER,
  CLI_USER_AGENT,
  BILLING_HEADER_TEXT,
} from './anthropic-direct/auth.js';
import type {
  ToolCall,
  ToolDispatcher,
  ToolResult,
} from './anthropic-direct/tool-dispatcher.js';

// --- Mock SDK plumbing ---

type CreateArgs = [
  Record<string, unknown>,
  { headers?: Record<string, string>; signal?: AbortSignal } | undefined,
];

const messagesCreateMock = vi.fn();
const anthropicCtorMock = vi.fn();

class MockAnthropic {
  public opts: unknown;
  public messages: { create: typeof messagesCreateMock };
  constructor(opts: unknown) {
    anthropicCtorMock(opts);
    this.opts = opts;
    this.messages = { create: messagesCreateMock };
  }
}

function installFactory(): void {
  __setAnthropicClientFactory(
    (opts) => new MockAnthropic(opts) as unknown as Anthropic,
  );
}

// --- Helpers ---

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

async function* noInputAwaitingClose(
  done: Promise<void>,
): AsyncIterable<{ content: string }> {
  await done;
  return;
}

/**
 * Multi-turn driver: yield N user inputs one at a time, fully drain each
 * turn before the next is enqueued so the provider's per-turn
 * abortController is reliably cleared between calls.
 */
interface MultiTurnHarness {
  prompt: AsyncIterable<{ content: string }>;
  /** Resolve the i-th user turn and wait for one full turn.completed cycle. */
  fireTurn(i: number, content: string): Promise<void>;
  /** Resolve the trailing await so the prompt iterator can finish. */
  stop(): void;
  /** Internal — bumped by the drainer when a turn.completed flows through. */
  onTurnCompleted: () => void;
  /** Promise that resolves when the next turn.completed arrives. */
  nextTurnCompleted(): Promise<void>;
}

function makeMultiTurnHarness(turnCount: number): MultiTurnHarness {
  const cues: Array<((c: string) => void)> = [];
  const turns: Array<Promise<{ content: string }>> = [];
  for (let i = 0; i < turnCount; i++) {
    let resolve!: (c: string) => void;
    turns.push(
      new Promise<{ content: string }>((res) => {
        resolve = (c): void => res({ content: c });
      }),
    );
    cues.push(resolve);
  }
  let stopResolve!: () => void;
  const stopPromise = new Promise<void>((r) => {
    stopResolve = r;
  });
  async function* prompt(): AsyncIterable<{ content: string }> {
    for (const t of turns) yield await t;
    await stopPromise;
  }

  let pendingResolve: (() => void) | null = null;
  const harness: MultiTurnHarness = {
    prompt: prompt(),
    onTurnCompleted: (): void => {
      const r = pendingResolve;
      pendingResolve = null;
      if (r) r();
    },
    nextTurnCompleted: (): Promise<void> =>
      new Promise<void>((resolve) => {
        pendingResolve = resolve;
      }),
    fireTurn: async (i, content): Promise<void> => {
      const wait = harness.nextTurnCompleted();
      cues[i]?.(content);
      await wait;
      // Advance one microtask cycle so the runTurn finally block has a
      // chance to clear the per-turn abortController before the next call.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
    stop: (): void => stopResolve(),
  };
  return harness;
}

/** Pump the query iterator, signaling the harness on every turn.completed. */
function drainQuery(
  query: AsyncIterable<ProviderEvent>,
  harness: MultiTurnHarness,
): Promise<void> {
  return (async (): Promise<void> => {
    for await (const ev of query) {
      if (ev.type === 'turn.completed') harness.onTurnCompleted();
    }
  })();
}

/** Build a minimal text-only stream that ends with stop_reason=end_turn. */
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

/**
 * Like {@link makeTextStream} but reports `input_tokens` high enough to cross
 * 0.7 of the sonnet auto-compaction budget (200k), so `state.lastUsage` marks
 * the session "full" and the adaptive compaction keep-window engages. 181k of
 * 200k = 0.905 — comfortably above the 0.7 shrink gate.
 */
function makeHighUsageTextStream(text: string): RawMessageStreamEvent[] {
  const evts = makeTextStream(text);
  const start = evts[0] as unknown as { message: { usage: { input_tokens: number } } };
  start.message.usage.input_tokens = 181_000;
  return evts;
}

/** Build a stream that emits a single tool_use block, ending with stop_reason=tool_use. */
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
          input_tokens: 7,
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

/**
 * Build a stream where a SINGLE assistant turn emits multiple parallel
 * `tool_use` blocks (distinct content-block indices), ending with
 * stop_reason=tool_use. Models this scenario: one round batches N tool calls.
 */
function makeParallelToolUseStream(
  calls: Array<{ id: string; name: string; inputJson: string }>,
): RawMessageStreamEvent[] {
  const events: RawMessageStreamEvent[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_par',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
  ];
  calls.forEach((call, index) => {
    events.push(
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      } as unknown as RawMessageStreamEvent,
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: call.inputJson },
      } as unknown as RawMessageStreamEvent,
      {
        type: 'content_block_stop',
        index,
      } as unknown as RawMessageStreamEvent,
    );
  });
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  );
  return events;
}

// --- Tests ---

describe('AnthropicDirectProvider', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    anthropicCtorMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
  });

  it('exposes name = "anthropic-direct"', () => {
    expect(new AnthropicDirectProvider().name).toBe('anthropic-direct');
  });

  it('emits a synthetic session.init event before the first user turn', async () => {
    const provider = new AnthropicDirectProvider();
    let closeResolve!: () => void;
    const closePromise = new Promise<void>((r) => {
      closeResolve = r;
    });
    const query = provider.query({
      prompt: noInputAwaitingClose(closePromise),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' },
    });

    const iter = query[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('session.init');
    if (first.value?.type === 'session.init') {
      expect(first.value.info.model).toBe('claude-sonnet-5');
      expect(first.value.info.apiKeySource).toBe('oauth');
      expect(first.value.info.version).toBe('anthropic-direct-v1');
      expect(typeof first.value.info.sessionId).toBe('string');
      expect(first.value.info.sessionId.length).toBeGreaterThan(0);
    }

    closeResolve();
    query.close();
  });

  it('uses resume id and seeds text history when resumeHistory is provided', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Fresh reply')));

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('fresh question'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-oat01-test',
        resume: 'saved-session-123',
        resumeHistory: [{ user: 'old question', assistant: 'old reply' }],
      },
    });
    const events = await collect(query);

    const init = events.find((e) => e.type === 'session.init');
    expect(init).toMatchObject({
      type: 'session.init',
      info: { sessionId: 'saved-session-123' },
    });

    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    const [params, opts] = messagesCreateMock.mock.calls[0] as CreateArgs;
    expect(opts?.headers?.['X-Claude-Code-Session-Id']).toBe('saved-session-123');
    const messages = params['messages'] as unknown[];
    expect(messages.slice(0, 2)).toEqual([
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old reply' },
    ]);
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'fresh question' }],
    });
  });

  it('throws when config.apiKey is missing', () => {
    const provider = new AnthropicDirectProvider();
    expect(() =>
      provider.query({
        prompt: singleInput('hi'),
        config: { model: 'claude-sonnet-5' },
      }),
    ).toThrow(/apiKey/);
  });

  it('OAuth path: outbound headers and billing prefix match the proven recipe', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('ping'),
      // Non-effort model on purpose: keeps anthropic-beta equal to the base
      // OAUTH_BETA_HEADER recipe. Effort-tier models (e.g. claude-sonnet-5)
      // append the `effort-2025-11-24` beta — asserted in auth.test.ts and
      // resolve-effort.test.ts, not here.
      config: { model: 'claude-sonnet-4-5-20250929', apiKey: 'sk-ant-oat01-test' },
    });
    const events = await collect(query);
    // Sanity: at least session.init + turn.completed
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);

    expect(anthropicCtorMock).toHaveBeenCalledTimes(1);
    const ctorArg = anthropicCtorMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ctorArg).toEqual({ authToken: 'sk-ant-oat01-test' });
    expect('apiKey' in ctorArg).toBe(false);

    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    const [params, opts] = messagesCreateMock.mock.calls[0] as CreateArgs;
    expect(opts?.headers?.['anthropic-beta']).toBe(OAUTH_BETA_HEADER);
    expect(opts?.headers?.['x-app']).toBe('cli');
    expect(opts?.headers?.['User-Agent']).toBe(CLI_USER_AGENT);
    expect(typeof opts?.headers?.['X-Claude-Code-Session-Id']).toBe('string');
    expect((opts?.headers?.['X-Claude-Code-Session-Id'] ?? '').length).toBeGreaterThan(0);
    expect(typeof opts?.headers?.['x-client-request-id']).toBe('string');
    expect((opts?.headers?.['x-client-request-id'] ?? '').length).toBeGreaterThan(0);

    expect(Array.isArray(params['system'])).toBe(true);
    const sys = params['system'] as Array<{ type: string; text: string }>;
    expect(sys[0]).toEqual({ type: 'text', text: BILLING_HEADER_TEXT });
  });

  it('API-key path: no oauth headers, no billing prefix', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('ping'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    await collect(query);

    expect(anthropicCtorMock).toHaveBeenCalledTimes(1);
    expect(anthropicCtorMock.mock.calls[0]?.[0]).toEqual({ apiKey: 'sk-ant-api03-test' });

    const [params, opts] = messagesCreateMock.mock.calls[0] as CreateArgs;
    expect(opts?.headers?.['anthropic-beta']).toBeUndefined();
    expect(opts?.headers?.['x-app']).toBeUndefined();
    expect(opts?.headers?.['User-Agent']).toBeUndefined();

    // system is omitted entirely (no userSystem set, no oauth prefix)
    if (params['system'] !== undefined) {
      const sys = params['system'];
      const billing = JSON.stringify(sys);
      expect(billing).not.toContain('cc_entrypoint=cli');
    }
  });

  // Local-server mode tests. The user sets `AFK_LOCAL_BASE_URL` (which ends
  // up on `config.baseUrl`) to route Messages traffic at an Anthropic-Messages-
  // compatible local shim (e.g. vllm-mlx serving an MLX-hosted model).
  describe('local-server mode (config.baseUrl)', () => {
    it('forwards baseURL to the Anthropic ctor and uses placeholder api key by default', async () => {
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));

      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('ping'),
        config: {
          model: 'local-qwen-3-6',
          apiKey: 'local',
          baseUrl: 'http://127.0.0.1:8080',
        },
      });
      await collect(query);

      expect(anthropicCtorMock).toHaveBeenCalledTimes(1);
      expect(anthropicCtorMock.mock.calls[0]?.[0]).toEqual({
        apiKey: 'local',
        baseURL: 'http://127.0.0.1:8080',
      });
    });

    it('does NOT fall through to ANTHROPIC_API_KEY when local mode is active', async () => {
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));
      const prev = process.env['ANTHROPIC_API_KEY'];
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-REAL-KEY-NEVER-SEND';
      try {
        const provider = new AnthropicDirectProvider();
        const query = provider.query({
          prompt: singleInput('ping'),
          // No explicit apiKey; provider must NOT pick up the real env key.
          config: { model: 'local-qwen-3-6', baseUrl: 'http://127.0.0.1:8080' },
        });
        await collect(query);

        const ctorArg = anthropicCtorMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(ctorArg['apiKey']).not.toBe('sk-ant-api03-REAL-KEY-NEVER-SEND');
        expect(ctorArg['apiKey']).toBe('local');
        expect(ctorArg['baseURL']).toBe('http://127.0.0.1:8080');
      } finally {
        if (prev === undefined) delete process.env['ANTHROPIC_API_KEY'];
        else process.env['ANTHROPIC_API_KEY'] = prev;
      }
    });

    it('honors AFK_LOCAL_API_KEY when set', async () => {
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));
      const prev = process.env['AFK_LOCAL_API_KEY'];
      process.env['AFK_LOCAL_API_KEY'] = 'my-shim-secret';
      try {
        const provider = new AnthropicDirectProvider();
        const query = provider.query({
          prompt: singleInput('ping'),
          config: { model: 'local-qwen-3-6', baseUrl: 'http://127.0.0.1:8080' },
        });
        await collect(query);

        const ctorArg = anthropicCtorMock.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(ctorArg['apiKey']).toBe('my-shim-secret');
      } finally {
        if (prev === undefined) delete process.env['AFK_LOCAL_API_KEY'];
        else process.env['AFK_LOCAL_API_KEY'] = prev;
      }
    });

    it('emits no OAuth headers and no billing prefix in local mode', async () => {
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('ping'),
        config: { model: 'local-qwen-3-6', baseUrl: 'http://127.0.0.1:8080' },
      });
      await collect(query);

      const [params, opts] = messagesCreateMock.mock.calls[0] as CreateArgs;
      expect(opts?.headers?.['anthropic-beta']).toBeUndefined();
      expect(opts?.headers?.['x-app']).toBeUndefined();
      expect(opts?.headers?.['User-Agent']).toBeUndefined();
      // No billing-header text block in the system array.
      if (params['system'] !== undefined) {
        expect(JSON.stringify(params['system'])).not.toContain('cc_entrypoint=cli');
      }
    });

    it('suppresses cache_control markers in local mode', async () => {
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('ping'),
        config: {
          model: 'local-qwen-3-6',
          baseUrl: 'http://127.0.0.1:8080',
          systemPrompt: 'You are running on a local model.',
        },
      });
      await collect(query);

      const [params] = messagesCreateMock.mock.calls[0] as CreateArgs;
      // The cache_control marker is the load-bearing field; "ephemeral" alone
      // appears in unrelated prose (e.g. memory system-prompt) so we only
      // assert the structural field is absent.
      const serialized = JSON.stringify(params);
      expect(serialized).not.toContain('cache_control');
    });

    it('passes the model id through verbatim (no resolveModelId rewriting)', async () => {
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('ping'),
        config: { model: 'local-qwen-3-6', baseUrl: 'http://127.0.0.1:8080' },
      });
      await collect(query);

      const [params] = messagesCreateMock.mock.calls[0] as CreateArgs;
      expect(params['model']).toBe('local-qwen-3-6');
    });
  });

  it('single text turn → delta.text + assistant.message + turn.completed', async () => {
    messagesCreateMock.mockImplementation(() =>
      fromArray([
        ...makeTextStream('').slice(0, 2), // message_start, content_block_start
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi ' },
        } as unknown as RawMessageStreamEvent,
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'there' },
        } as unknown as RawMessageStreamEvent,
        ...makeTextStream('').slice(3), // content_block_stop, message_delta, message_stop
      ]),
    );

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hello'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('session.init');
    const deltas = events.filter((e) => e.type === 'delta.text') as Array<
      Extract<ProviderEvent, { type: 'delta.text' }>
    >;
    expect(deltas.length).toBe(2);
    expect(deltas.map((d) => d.text).join('')).toBe('Hi there');

    const assistant = events.find((e) => e.type === 'assistant.message');
    expect(assistant).toBeDefined();
    if (assistant?.type === 'assistant.message') {
      expect(assistant.text).toBe('Hi there');
    }

    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('end_turn');
    }
  });

  it('tool-use loop: dispatcher invoked, second turn fires with tool_result message', async () => {
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_x', 'get_weather', '{"city":"SF"}'));
      }
      return fromArray(makeTextStream('Sunny.'));
    });

    const dispatched: ToolCall[] = [];
    const dispatcher: ToolDispatcher = {
      async execute(call: ToolCall): Promise<ToolResult> {
        dispatched.push(call);
        return { content: 'sunny' };
      },
    };

    const provider = new AnthropicDirectProvider({ tools: dispatcher });
    const query = provider.query({
      prompt: singleInput('weather?'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    expect(messagesCreateMock).toHaveBeenCalledTimes(2);
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]?.name).toBe('get_weather');
    expect(dispatched[0]?.input).toEqual({ city: 'SF' });

    const secondCallParams = messagesCreateMock.mock.calls[1]?.[0] as Record<
      string,
      unknown
    >;
    const msgs = secondCallParams['messages'] as MessageParam[];
    expect(msgs.length).toBe(3);
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[1]?.role).toBe('assistant');
    const assistantContent = msgs[1]?.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    if (Array.isArray(assistantContent)) {
      expect(assistantContent.some((b) => (b as { type: string }).type === 'tool_use')).toBe(
        true,
      );
    }
    expect(msgs[2]?.role).toBe('user');
    const toolResultContent = msgs[2]?.content;
    expect(Array.isArray(toolResultContent)).toBe(true);
    if (Array.isArray(toolResultContent)) {
      const tr = toolResultContent.find(
        (b) => (b as { type: string }).type === 'tool_result',
      ) as { content: string } | undefined;
      expect(tr?.content).toBe('sunny');
    }

    const toolOutput = events.find((e) => e.type === 'tool.output');
    expect(toolOutput).toBeDefined();
    if (toolOutput?.type === 'tool.output') {
      expect(toolOutput.content).toBe('sunny');
      expect(toolOutput.isError).toBeUndefined();
    }
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('end_turn');
    }
  });

  it('long tool-use loop completes naturally — no default iteration cap', async () => {
    // 30 tool_use rounds (well past the old hardcoded 25), then end_turn.
    // With the cap removed, the loop must terminate via stop_reason=end_turn,
    // not the synthetic 'tool_use_loop_capped'.
    let callIdx = 0;
    const TOOL_USE_ROUNDS = 30;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx <= TOOL_USE_ROUNDS) {
        return fromArray(
          makeToolUseStream(`toolu_${callIdx}`, 'get_weather', '{"city":"SF"}'),
        );
      }
      return fromArray(makeTextStream('All done.'));
    });

    const dispatcher: ToolDispatcher = {
      async execute(): Promise<ToolResult> {
        return { content: 'sunny' };
      },
    };

    const provider = new AnthropicDirectProvider({ tools: dispatcher });
    const query = provider.query({
      prompt: singleInput('weather?'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    expect(messagesCreateMock).toHaveBeenCalledTimes(TOOL_USE_ROUNDS + 1);

    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('end_turn');
      expect(completed.usage.stopReason).not.toBe('tool_use_loop_capped');
    }
  });

  it('caps the tool-use loop at config.maxToolUseIterations (config → provider → loop)', async () => {
    // End-to-end plumbing guard: AgentConfig.maxToolUseIterations must thread
    // through AnthropicDirectProvider.query() → AnthropicDirectQueryOptions →
    // the constructor → runInput → the loop's `maxIterations`. After the cap the
    // loop runs one tools-stripped wind-down round (rounds 1-2 request tools;
    // round 3 answers in text), so the turn ends with a real final message AND
    // stopReason 'tool_use_loop_capped' — the guard a forked subagent relies on
    // to avoid hanging its parent (see SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS).
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx >= 3) return fromArray(makeTextStream('Summary of findings.'));
      return fromArray(
        makeToolUseStream(`toolu_${callIdx}`, 'get_weather', '{"city":"SF"}'),
      );
    });

    const dispatcher: ToolDispatcher = {
      async execute(): Promise<ToolResult> {
        return { content: 'sunny' };
      },
    };

    const provider = new AnthropicDirectProvider({ tools: dispatcher });
    const query = provider.query({
      prompt: singleInput('weather?'),
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-api03-test',
        maxToolUseIterations: 2,
      },
    });
    const events = await collect(query);

    // 2 tool-use rounds + 1 tools-stripped wind-down round, not left to spin.
    expect(messagesCreateMock).toHaveBeenCalledTimes(3);
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('tool_use_loop_capped');
    }
  });

  it('default SessionToolDispatcher rejects unknown tools with isError', async () => {
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_y', 'get_weather', '{}'));
      }
      return fromArray(makeTextStream('done'));
    });

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('weather?'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    const toolOutput = events.find((e) => e.type === 'tool.output');
    expect(toolOutput).toBeDefined();
    if (toolOutput?.type === 'tool.output') {
      expect(toolOutput.isError).toBe(true);
    }
  });

  it('interrupt() aborts in-flight stream', async () => {
    let resolveBlock!: () => void;
    const blockPromise = new Promise<void>((r) => {
      resolveBlock = r;
    });
    let signalCapture: AbortSignal | undefined;

    messagesCreateMock.mockImplementation(
      (
        _params: Record<string, unknown>,
        opts?: { headers?: Record<string, string>; signal?: AbortSignal },
      ) => {
        signalCapture = opts?.signal;
        return (async function* () {
          // Yield message_start, then block until resolved or aborted.
          yield {
            type: 'message_start',
            message: {
              id: 'msg_x',
              type: 'message',
              role: 'assistant',
              content: [],
              model: 'claude-sonnet-5',
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 1,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                server_tool_use: null,
                service_tier: null,
              },
            },
          } as unknown as RawMessageStreamEvent;
          await blockPromise;
          throw new Error('aborted');
        })();
      },
    );

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hang'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });

    const events: ProviderEvent[] = [];
    const drain = (async () => {
      for await (const ev of query) events.push(ev);
    })();

    // Wait one tick for session.init + the create() call to fire.
    await new Promise<void>((r) => setTimeout(r, 5));
    await query.interrupt();
    expect(signalCapture?.aborted).toBe(true);
    resolveBlock();

    await drain;

    const types = events.map((e) => e.type);
    expect(types).toContain('session.init');
    expect(types).toContain('turn.completed');
  });

  it('close() releases waiting promptIterator.next()', async () => {
    const provider = new AnthropicDirectProvider();
    let closeResolve!: () => void;
    const closePromise = new Promise<void>((r) => {
      closeResolve = r;
    });
    const query = provider.query({
      prompt: noInputAwaitingClose(closePromise),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });

    const iter = query[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value?.type).toBe('session.init');

    query.close();
    closeResolve();

    const second = await iter.next();
    expect(second.done).toBe(true);
  });

  it('tool-use loop emits progress events with correct fields', async () => {
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx <= 2) {
        const toolName = callIdx === 1 ? 'read_file' : 'write_file';
        return fromArray(makeToolUseStream(`toolu_${callIdx}`, toolName, '{}'));
      }
      return fromArray(makeTextStream('Done.'));
    });

    const dispatcher: ToolDispatcher = {
      async execute(): Promise<ToolResult> {
        return { content: 'ok' };
      },
    };

    const provider = new AnthropicDirectProvider({ tools: dispatcher });
    const query = provider.query({
      prompt: singleInput('do stuff'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    const progressEvents = events.filter((e) => e.type === 'progress') as Array<
      Extract<ProviderEvent, { type: 'progress' }>
    >;
    expect(progressEvents.length).toBe(2);

    const first = progressEvents[0]!;
    expect(first.progress.taskId).toBeTruthy();
    expect(first.progress.description).toBe('Working');
    expect(first.progress.toolUses).toBe(1);
    expect(first.progress.lastToolName).toBe('read_file');
    expect(first.progress.totalTokens).toBeGreaterThanOrEqual(0);
    expect(first.progress.durationMs).toBeGreaterThanOrEqual(0);
    expect(first.progress.summary).toContain('round 1');
    expect(first.progress.summary).toContain('read_file');
    expect(first.sessionId).toBeTruthy();

    const second = progressEvents[1]!;
    expect(second.progress.toolUses).toBe(2);
    expect(second.progress.lastToolName).toBe('write_file');
    expect(second.progress.summary).toContain('round 2');
    expect(second.progress.summary).toContain('write_file');
    expect(second.progress.taskId).toBe(first.progress.taskId);
  });

  // Regression (PR 508 codex review, P2): a single round that batches multiple
  // parallel tool_use blocks must report `toolUses` as the actual number of
  // tool CALLS — not "1" (the round/iteration count). Before the fix `toolUses`
  // carried the round counter, so 3 parallel calls in round 1 rendered as
  // "1 tool call".
  it('progress.toolUses reflects actual tool-call count when a round batches parallel calls', async () => {
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        // Round 1: THREE parallel tool_use blocks in a single assistant turn.
        return fromArray(
          makeParallelToolUseStream([
            { id: 'toolu_a', name: 'read_file', inputJson: '{"path":"a"}' },
            { id: 'toolu_b', name: 'read_file', inputJson: '{"path":"b"}' },
            { id: 'toolu_c', name: 'read_file', inputJson: '{"path":"c"}' },
          ]),
        );
      }
      return fromArray(makeTextStream('Done.'));
    });

    const dispatcher: ToolDispatcher = {
      async execute(): Promise<ToolResult> {
        return { content: 'ok' };
      },
    };

    const provider = new AnthropicDirectProvider({ tools: dispatcher });
    const query = provider.query({
      prompt: singleInput('read three files'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    const progressEvents = events.filter((e) => e.type === 'progress') as Array<
      Extract<ProviderEvent, { type: 'progress' }>
    >;
    // One progress event (one round), but it dispatched 3 calls.
    expect(progressEvents.length).toBe(1);
    const only = progressEvents[0]!;
    // The fix: toolUses is the cumulative CALL count (3), not the round (1).
    expect(only.progress.toolUses).toBe(3);
    // The human-readable summary still names the ROUND, unchanged.
    expect(only.progress.summary).toContain('round 1');
  });

  it('single text response emits no progress events', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hello')));

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hi'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    expect(events.filter((e) => e.type === 'progress').length).toBe(0);
  });

  it('short final text emits a suggestion event', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Try running pnpm test')));

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('what next?'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    const suggestions = events.filter((e) => e.type === 'suggestion') as Array<
      Extract<ProviderEvent, { type: 'suggestion' }>
    >;
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]!.suggestion).toBe('Try running pnpm test');
    expect(suggestions[0]!.sessionId).toBeTruthy();
  });

  it('long final text emits no suggestion event', async () => {
    const longText = 'x'.repeat(201);
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream(longText)));

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('explain'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    expect(events.filter((e) => e.type === 'suggestion').length).toBe(0);
  });

  it('tool-use followed by long final text emits no suggestion event', async () => {
    const longResponse = 'x'.repeat(201);
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_z', 'bash', '{}'));
      }
      return fromArray(makeTextStream(longResponse));
    });

    const dispatcher: ToolDispatcher = {
      async execute(): Promise<ToolResult> {
        return { content: 'ok' };
      },
    };

    const provider = new AnthropicDirectProvider({ tools: dispatcher });
    const query = provider.query({
      prompt: singleInput('run it'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    expect(events.filter((e) => e.type === 'suggestion').length).toBe(0);
    expect(events.some((e) => e.type === 'progress')).toBe(true);
  });

  it('text exactly at 200-char boundary emits suggestion', async () => {
    const exactText = 'y'.repeat(200);
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream(exactText)));

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: singleInput('hint'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    const suggestions = events.filter((e) => e.type === 'suggestion') as Array<
      Extract<ProviderEvent, { type: 'suggestion' }>
    >;
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]!.suggestion).toBe(exactText);
  });

  it('tool-use followed by short final text emits both progress and suggestion', async () => {
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_a', 'read_file', '{}'));
      }
      return fromArray(makeTextStream('File looks good'));
    });

    const dispatcher: ToolDispatcher = {
      async execute(): Promise<ToolResult> {
        return { content: 'contents' };
      },
    };

    const provider = new AnthropicDirectProvider({ tools: dispatcher });
    const query = provider.query({
      prompt: singleInput('check the file'),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const events = await collect(query);

    const progress = events.filter((e) => e.type === 'progress') as Array<
      Extract<ProviderEvent, { type: 'progress' }>
    >;
    expect(progress.length).toBe(1);
    expect(progress[0]!.progress.toolUses).toBe(1);
    expect(progress[0]!.progress.lastToolName).toBe('read_file');
    expect(progress[0]!.progress.durationMs).toBeGreaterThanOrEqual(0);

    const suggestions = events.filter((e) => e.type === 'suggestion') as Array<
      Extract<ProviderEvent, { type: 'suggestion' }>
    >;
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]!.suggestion).toBe('File looks good');
  });

  it('should inject plugin tools into the query', async () => {
    installFactory();
    const provider = new AnthropicDirectProvider();

    // Mock the messages.create to return a simple text stream
    messagesCreateMock.mockImplementation(async function* (params) {
      // Verify that plugin tools would be included in the params
      const tools = (params as Record<string, unknown>).tools as Array<Record<string, unknown>> | undefined;
      // We expect at least the built-in tools to be present
      expect(tools).toBeDefined();
      expect((tools ?? []).length).toBeGreaterThan(0);

      yield {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-sonnet-5',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      } as RawMessageStreamEvent;
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      } as RawMessageStreamEvent;
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      } as RawMessageStreamEvent;
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 10 },
      } as RawMessageStreamEvent;
      yield {
        type: 'message_stop',
      } as RawMessageStreamEvent;
    });

    const query = provider.query({
      config: {
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-fake',
        plugins: [
          // Pass an invalid plugin path that won't exist
          // This tests that the injector gracefully handles missing paths
          { type: 'local', path: '/nonexistent/plugin/path' },
        ],
      },
      prompt: singleInput('hello'),
    });

    const events = await collect(query);
    expect(events.length).toBeGreaterThan(0);

    // Verify that the provider still works even with non-existent plugins
    const msgEvents = events.filter((e) => e.type === 'assistant.message');
    expect(msgEvents.length).toBeGreaterThan(0);
  });

  it('compact() summarizes older history and the next turn sends the compacted prefix', async () => {
    // Drive 6 user turns to populate `messages`, then compact (keep last 3),
    // then drive a 7th turn and inspect what `messages.create` receives.
    // The compacted preamble must appear at the head and the kept tail must
    // alternate user/assistant correctly.

    // Streams: turns 1..6 return short text. Call 7 is the summarization;
    // call 8 is the post-compaction follow-up turn.
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx === 7) {
        return fromArray(makeTextStream('SUMMARY-OF-EARLIER-TURNS'));
      }
      return fromArray(makeTextStream(`reply-${callIdx}`));
    });

    const harness = makeMultiTurnHarness(7);
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: harness.prompt,
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const drive = drainQuery(query, harness);

    // Cue 6 turns and wait for each to fully drain (so the per-turn
    // abortController is cleared by the runTurn finally block).
    for (let i = 0; i < 6; i++) {
      await harness.fireTurn(i, `user-turn-${i + 1}`);
    }
    expect(messagesCreateMock).toHaveBeenCalledTimes(6);

    const compactResult = await query.compact!();
    expect(compactResult.compacted).toBe(true);
    expect(compactResult.messagesBefore).toBeGreaterThan(compactResult.messagesAfter);
    expect(messagesCreateMock).toHaveBeenCalledTimes(7);

    const [summarizeParams] = messagesCreateMock.mock.calls[6] as CreateArgs;
    expect(summarizeParams['model']).toBe('claude-haiku-4-5-20251001');
    expect(summarizeParams['stream']).toBe(true);
    expect(summarizeParams['tools']).toBeUndefined();
    const summarizeMessages = summarizeParams['messages'] as MessageParam[];
    expect(summarizeMessages.length).toBe(1);
    expect(summarizeMessages[0]?.role).toBe('user');

    await harness.fireTurn(6, 'user-turn-7');
    expect(messagesCreateMock).toHaveBeenCalledTimes(8);
    const [postCompactParams] = messagesCreateMock.mock.calls[7] as CreateArgs;
    const msgs = postCompactParams['messages'] as MessageParam[];
    expect(msgs[0]?.role).toBe('user');
    expect(
      typeof msgs[0]?.content === 'string' &&
        msgs[0]?.content.includes('SUMMARY-OF-EARLIER-TURNS'),
    ).toBe(true);
    expect(msgs[1]?.role).toBe('assistant');
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe('user');
    // With prompt caching enabled, the tail message's string content gets
    // wrapped into a single text block carrying cache_control. Tolerate
    // either shape so this test stays focused on the post-compact prefix.
    const lastText =
      typeof last?.content === 'string'
        ? last.content
        : ((last?.content as Array<{ text?: string }>)?.find(
            (b) => typeof b.text === 'string',
          )?.text ?? '');
    expect(lastText).toBe('user-turn-7');

    harness.stop();
    query.close();
    await drive;
  });

  it('compact() returns history-too-short before any turns have run', async () => {
    const provider = new AnthropicDirectProvider();
    let closeResolve!: () => void;
    const closePromise = new Promise<void>((r) => {
      closeResolve = r;
    });
    const query = provider.query({
      prompt: noInputAwaitingClose(closePromise),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    // Drain the synthetic session.init so the iterator is parked on the
    // prompt stream.
    const iter = query[Symbol.asyncIterator]();
    await iter.next();

    const result = await query.compact!();
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('history-too-short');
    expect(messagesCreateMock).not.toHaveBeenCalled();

    closeResolve();
    query.close();
  });

  it('compact() returns nothing-to-summarize when all history is within the keep window', async () => {
    // With DEFAULT_COMPACT_KEEP_LAST_TURNS=2, exactly 2 fresh user turns means
    // findCompactionBoundary returns 0 (kept tail starts at message 0 — nothing
    // older). This is distinct from history-too-short (boundary=-1): the
    // history is long enough; it just falls entirely within the keep window.
    messagesCreateMock.mockImplementation(() =>
      fromArray(makeTextStream('reply')),
    );
    const harness = makeMultiTurnHarness(2);
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: harness.prompt,
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const drive = drainQuery(query, harness);
    await harness.fireTurn(0, 'u1');
    await harness.fireTurn(1, 'u2');

    const result = await query.compact!();
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('nothing-to-summarize');
    // No summarization call should have been made.
    expect(messagesCreateMock).toHaveBeenCalledTimes(2); // only the 2 user turns

    harness.stop();
    query.close();
    await drive;
  });

  it('compact() summarizes a short-but-full session (2 turns, window near limit)', async () => {
    // The mirror of the test above: the SAME 2-turn shape that returns
    // nothing-to-summarize when the window is empty MUST compact once the
    // window is full. Both turns report high usage (181k of the 200k sonnet
    // budget → 0.9), so the adaptive keep-window relaxes from 2 → 1 fresh user
    // turn and the older turn is summarized. Regression guard for the
    // "compact refuses on a full 1-2 turn session" gap.
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      // Calls 1-2 are the user turns (high usage); call 3 is the summarization.
      if (callIdx <= 2) return fromArray(makeHighUsageTextStream('reply'));
      return fromArray(makeTextStream('## Summary\n\nOlder turn compressed.'));
    });
    const harness = makeMultiTurnHarness(2);
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: harness.prompt,
      // No autoCompactThreshold → auto-compaction stays disabled; the only
      // compaction is the manual compact() call below.
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const drive = drainQuery(query, harness);
    await harness.fireTurn(0, 'u1');
    await harness.fireTurn(1, 'u2');

    const result = await query.compact!();
    expect(result.compacted).toBe(true);
    // The summarization request fired (3rd create call) — proof the adaptive
    // shrink engaged rather than short-circuiting to a no-op.
    expect(messagesCreateMock).toHaveBeenCalledTimes(3);
    expect(result.messagesBefore).toBeGreaterThan(0);

    harness.stop();
    query.close();
    await drive;
  });

  it('compact() leaves history untouched when summarization throws', async () => {
    let callIdx = 0;
    messagesCreateMock.mockImplementation(() => {
      callIdx += 1;
      if (callIdx >= 7) throw new Error('boom');
      return fromArray(makeTextStream(`reply-${callIdx}`));
    });

    const harness = makeMultiTurnHarness(6);
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: harness.prompt,
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const drive = drainQuery(query, harness);
    for (let i = 0; i < 6; i++) {
      await harness.fireTurn(i, `u${i + 1}`);
    }

    const result = await query.compact!();
    expect(result.compacted).toBe(false);
    expect(result.reason ?? '').toMatch(/summarization-failed/);

    harness.stop();
    query.close();
    await drive;
  });

  it('compact() is not blocked between turns when consumer breaks on turn.completed', async () => {
    // Regression: the AgentSession REPL consumer (sendMessageStreamInternal)
    // breaks its own loop the moment it sees a `done` output and stops
    // pulling from the provider iterator. The provider generator is left
    // suspended at `yield turn.completed`, inside the per-turn try block —
    // so the `finally` that clears `this.abortController` never runs until
    // the NEXT turn's .next() resumes the generator.
    //
    // Before the fix, `/compact` issued in that gap always saw a non-null
    // `this.abortController` and returned `turn-in-flight`. The fix is to
    // clear the controller eagerly when `turn.completed` is observed,
    // before the yield. This test mirrors the REPL consumer pattern (stop
    // pulling after `turn.completed`) and asserts compact() is not falsely
    // marked `turn-in-flight`.
    messagesCreateMock.mockImplementation(() =>
      fromArray(makeTextStream('hi')),
    );

    let cueResolve!: (c: string) => void;
    const cuePromise = new Promise<{ content: string }>((res) => {
      cueResolve = (c): void => res({ content: c });
    });
    let hangResolve!: () => void;
    const hangPromise = new Promise<void>((res) => {
      hangResolve = res;
    });
    async function* prompt(): AsyncIterable<{ content: string }> {
      yield await cuePromise;
      // Park the prompt iterator so the provider's outer while-loop stays
      // alive waiting for a (never-arriving) second turn — mirroring the
      // REPL idle-between-turns state.
      await hangPromise;
    }

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: prompt(),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const iter = query[Symbol.asyncIterator]();

    // Drain session.init so the iterator is parked on the prompt stream.
    await iter.next();

    // Cue the user turn and pull events until turn.completed — then STOP.
    // This is the exact pattern AgentSession uses: break on `done`, never
    // pull again. The generator is left suspended at `yield`.
    cueResolve('hello');
    while (true) {
      const r = await iter.next();
      if (r.done) throw new Error('provider stream ended before turn.completed');
      if (r.value.type === 'turn.completed') break;
    }

    // With the fix, abortController has been eagerly nulled inside the
    // for-await loop body BEFORE the yield. compact() should now see a
    // clean state. History is too short to actually compact (only one
    // user/assistant pair plus keepLastN=2 keep window), so the expected
    // reason is `history-too-short` — the load-bearing assertion is that
    // it is NOT `turn-in-flight`.
    const result = await query.compact!();
    expect(result.reason).not.toBe('turn-in-flight');
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('history-too-short');

    hangResolve();
    query.close();
  });

  it('compact() is not blocked after a turn aborted via pendingAbortReason', async () => {
    // Regression: when `interrupt()` is called while idle (no controller
    // attached), it queues `pendingAbortReason`. The next turn enters the
    // outer while-loop, assigns `this.abortController = controller`, then
    // consumes the pending reason and immediately `return`s at the
    // controller.signal.aborted check — BEFORE entering the per-turn try
    // block that owns the cleanup finally.
    //
    // Before the fix, `this.abortController` was left pointing at the
    // aborted controller permanently, so every subsequent `/compact`
    // returned `turn-in-flight`. The fix clears the controller before the
    // early return on this path too.
    messagesCreateMock.mockImplementation(() =>
      fromArray(makeTextStream('unused')),
    );

    let cueResolve!: (c: string) => void;
    const cuePromise = new Promise<{ content: string }>((res) => {
      cueResolve = (c): void => res({ content: c });
    });
    let hangResolve!: () => void;
    const hangPromise = new Promise<void>((res) => {
      hangResolve = res;
    });
    async function* prompt(): AsyncIterable<{ content: string }> {
      yield await cuePromise;
      await hangPromise;
    }

    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      prompt: prompt(),
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
    });
    const iter = query[Symbol.asyncIterator]();

    // Drain session.init.
    await iter.next();

    // Interrupt while idle — sets pendingAbortReason since controller is null.
    await query.interrupt();

    // Cue a turn. The provider will enter the loop body, assign the
    // controller, consume the pending reason, abort, and return.
    cueResolve('hello');

    // Pull one more event — the generator should terminate cleanly via the
    // pendingAbort early-return path. We accept either `{ done: true }` or
    // a final error/turn event; the key invariant is that the generator
    // exits without throwing.
    const next = await iter.next();
    // If a value was yielded, it must not be a turn.completed (we returned
    // before any turn ran).
    if (!next.done) {
      expect(next.value.type).not.toBe('turn.completed');
    }

    // Confirm no real API call was made — the turn was aborted before
    // reaching messages.create.
    expect(messagesCreateMock).not.toHaveBeenCalled();

    // With the fix, compact() must NOT see a leaked controller.
    const result = await query.compact!();
    expect(result.reason).not.toBe('turn-in-flight');

    hangResolve();
    query.close();
  });

  it('supportedCommands() surfaces every registry skill so the REPL slash list is non-empty', async () => {
    // Regression: anthropic-direct previously returned `[]` here, which made
    // /reload-plugins report 0 and broke /<skill> autocomplete in the REPL,
    // even though the same skills were already injected into the system
    // prompt manifest. The fix wires `supportedCommands()` to
    // `collectSkillEntries()` — the same source of truth as the manifest.
    installFactory();
    const provider = new AnthropicDirectProvider();
    const query = provider.query({
      config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-fake' },
      prompt: singleInput('hi'),
    });
    const commands = await query.supportedCommands();
    expect(commands.length).toBeGreaterThan(0);
    // Each entry must carry the structural fields the REPL slash registry
    // reads (name + description; argumentHint is optional).
    for (const cmd of commands) {
      expect(typeof cmd.name).toBe('string');
      expect(cmd.name.length).toBeGreaterThan(0);
      expect(typeof cmd.description).toBe('string');
    }
    query.close();
  });

  describe('prompt caching', () => {
    const ENV_DISABLE = 'AFK_DISABLE_PROMPT_CACHE';
    const ENV_TTL = 'AFK_PROMPT_CACHE_TTL';
    function clearCacheEnv(): void {
      delete process.env[ENV_DISABLE];
      delete process.env[ENV_TTL];
    }
    beforeEach(clearCacheEnv);

    it('stamps cache_control on the last system block by default (1h ttl)', async () => {
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('hi'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
      });
      await collect(query);

      const [params] = messagesCreateMock.mock.calls[0] as CreateArgs;
      const sys = params['system'] as Array<Record<string, unknown>>;
      expect(Array.isArray(sys)).toBe(true);
      const last = sys[sys.length - 1] as { cache_control?: { type?: string; ttl?: string } };
      expect(last.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      // Earlier blocks (if any) carry no cache_control.
      for (const b of sys.slice(0, -1)) {
        expect((b as { cache_control?: unknown }).cache_control).toBeUndefined();
      }
    });

    it('stamps cache_control on the last messages tail block by default', async () => {
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('hello world'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
      });
      await collect(query);

      const [params] = messagesCreateMock.mock.calls[0] as CreateArgs;
      const msgs = params['messages'] as MessageParam[];
      expect(msgs.length).toBe(1);
      const tailContent = msgs[0]?.content as ContentBlockParam[];
      expect(Array.isArray(tailContent)).toBe(true);
      const last = tailContent[tailContent.length - 1] as { cache_control?: { ttl?: string } };
      expect(last.cache_control?.ttl).toBe('1h');
    });

    it('honors AFK_PROMPT_CACHE_TTL=5m', async () => {
      process.env[ENV_TTL] = '5m';
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('hi'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
      });
      await collect(query);

      const [params] = messagesCreateMock.mock.calls[0] as CreateArgs;
      const sys = params['system'] as Array<{ cache_control?: { ttl?: string } }>;
      expect(sys[sys.length - 1]?.cache_control?.ttl).toBe('5m');
    });

    it('disables stamping when AFK_DISABLE_PROMPT_CACHE=1', async () => {
      process.env[ENV_DISABLE] = '1';
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));
      const provider = new AnthropicDirectProvider();
      const query = provider.query({
        prompt: singleInput('hi'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
      });
      await collect(query);

      const [params] = messagesCreateMock.mock.calls[0] as CreateArgs;
      const sys = params['system'] as Array<Record<string, unknown>>;
      for (const b of sys) {
        expect((b as { cache_control?: unknown }).cache_control).toBeUndefined();
      }
      const msgs = params['messages'] as MessageParam[];
      const tailContent = msgs[0]?.content;
      // Either the original string, or content blocks with no cache_control.
      if (Array.isArray(tailContent)) {
        for (const b of tailContent) {
          expect((b as { cache_control?: unknown }).cache_control).toBeUndefined();
        }
      } else {
        expect(typeof tailContent).toBe('string');
      }
    });

    it('tool-use loop: each iteration stamps the freshly-appended tail; markers do not leak into history sent on later iterations', async () => {
      let callIdx = 0;
      messagesCreateMock.mockImplementation(() => {
        callIdx += 1;
        if (callIdx === 1) {
          return fromArray(makeToolUseStream('toolu_a', 'get_weather', '{"city":"NYC"}'));
        }
        if (callIdx === 2) {
          return fromArray(makeToolUseStream('toolu_b', 'get_weather', '{"city":"LA"}'));
        }
        return fromArray(makeTextStream('done'));
      });

      const dispatcher: ToolDispatcher = {
        async execute(): Promise<ToolResult> {
          return { content: 'cloudy' };
        },
      };
      const provider = new AnthropicDirectProvider({ tools: dispatcher });
      const query = provider.query({
        prompt: singleInput('weather?'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
      });
      await collect(query);

      expect(messagesCreateMock).toHaveBeenCalledTimes(3);

      // Iteration 1: only the user turn is in messages; its tail block is stamped.
      const call1Msgs = (messagesCreateMock.mock.calls[0]?.[0] as Record<string, unknown>)[
        'messages'
      ] as MessageParam[];
      expect(call1Msgs.length).toBe(1);
      const call1Tail = call1Msgs[0]?.content as ContentBlockParam[];
      expect((call1Tail[call1Tail.length - 1] as { cache_control?: unknown }).cache_control).toEqual(
        { type: 'ephemeral', ttl: '1h' },
      );

      // Iteration 2: messages = [user, assistant#1, tool_result#1].
      // The freshly-appended tool_result is stamped; earlier messages
      // including the iteration-1 user turn carry NO cache_control —
      // proving the marker did not leak back into stored history.
      const call2Msgs = (messagesCreateMock.mock.calls[1]?.[0] as Record<string, unknown>)[
        'messages'
      ] as MessageParam[];
      expect(call2Msgs.length).toBe(3);

      const call2User0Content = call2Msgs[0]?.content;
      // Original user turn must be string-content (untouched), or array with NO cache_control.
      if (Array.isArray(call2User0Content)) {
        for (const b of call2User0Content) {
          expect((b as { cache_control?: unknown }).cache_control).toBeUndefined();
        }
      } else {
        expect(typeof call2User0Content).toBe('string');
      }

      const call2AsstContent = call2Msgs[1]?.content as ContentBlockParam[];
      for (const b of call2AsstContent) {
        expect((b as { cache_control?: unknown }).cache_control).toBeUndefined();
      }

      const call2ToolResultContent = call2Msgs[2]?.content as ContentBlockParam[];
      const lastBlock = call2ToolResultContent[call2ToolResultContent.length - 1] as {
        cache_control?: unknown;
      };
      expect(lastBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

      // Iteration 3: messages = [user, asst#1, tool_result#1, asst#2, tool_result#2].
      // Same invariant: only the new tail carries cache_control.
      const call3Msgs = (messagesCreateMock.mock.calls[2]?.[0] as Record<string, unknown>)[
        'messages'
      ] as MessageParam[];
      expect(call3Msgs.length).toBe(5);
      const call3PrevToolResult = call3Msgs[2]?.content as ContentBlockParam[];
      for (const b of call3PrevToolResult) {
        expect((b as { cache_control?: unknown }).cache_control).toBeUndefined();
      }
      const call3NewToolResult = call3Msgs[4]?.content as ContentBlockParam[];
      expect(
        (call3NewToolResult[call3NewToolResult.length - 1] as { cache_control?: unknown })
          .cache_control,
      ).toEqual({ type: 'ephemeral', ttl: '1h' });
    });
  });

  // ---------------------------------------------------------------------------
  // Awareness layer reachability through externalTools (Phase 1 reach-test).
  //
  // External constraint: callers can inject a custom dispatcher via
  // `tools: dispatcher` (tests, the nesting fixture, embedders). When they do,
  // the provider bypasses `buildDispatcher` and routes tool calls directly to
  // the caller's executor. Without the awareness wrapper, `get_runtime_state`
  // would be invisible — schema unoffered, no handler registered, model would
  // see `Unknown tool` if it called it anyway.
  //
  // These tests pin two things:
  //   (1) The schema list sent to the SDK in the externalTools branch
  //       INCLUDES `get_runtime_state` (the model can see it).
  //   (2) The dispatcher wrapper INTERCEPTS the call — the inner dispatcher
  //       is never asked to execute `get_runtime_state`, and the model
  //       receives a valid snapshot in the tool_result.
  // ---------------------------------------------------------------------------
  describe('awareness layer reachability through externalTools', () => {
    it('offers get_runtime_state in the SDK schema list even when externalTools is set', async () => {
      messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('Hi')));

      const dispatcher: ToolDispatcher = {
        async execute(): Promise<ToolResult> {
          return { content: '' };
        },
      };
      const provider = new AnthropicDirectProvider({ tools: dispatcher });
      const query = provider.query({
        prompt: singleInput('hello'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
      });
      await collect(query);

      const params = messagesCreateMock.mock.calls[0]?.[0] as Record<string, unknown>;
      const tools = params['tools'] as Array<{ name: string }>;
      expect(tools).toBeDefined();
      expect(tools.map((t) => t.name)).toContain('get_runtime_state');
    });

    it('intercepts get_runtime_state: inner dispatcher is NOT called; tool_result carries a runtime snapshot', async () => {
      let callIdx = 0;
      messagesCreateMock.mockImplementation(() => {
        callIdx += 1;
        if (callIdx === 1) {
          return fromArray(
            makeToolUseStream('toolu_rs', 'get_runtime_state', '{"view":"self"}'),
          );
        }
        return fromArray(makeTextStream('Got it.'));
      });

      const innerExecute = vi.fn().mockResolvedValue({ content: 'inner-called' });
      const dispatcher: ToolDispatcher = { execute: innerExecute };

      const provider = new AnthropicDirectProvider({ tools: dispatcher });
      const query = provider.query({
        prompt: singleInput('what session am I in?'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
      });
      const events = await collect(query);

      // The inner dispatcher must NEVER have been called — the wrapper
      // short-circuits on `get_runtime_state` before delegation.
      expect(innerExecute).not.toHaveBeenCalled();

      // The follow-up turn's outbound messages include a tool_result whose
      // body is the JSON-serialised snapshot. Parse it and assert the shape
      // promised by the Phase 1 awareness contract: a `self` block with
      // model + provider + cwd at minimum.
      const secondCall = messagesCreateMock.mock.calls[1]?.[0] as Record<string, unknown>;
      const msgs = secondCall['messages'] as MessageParam[];
      const toolResultMsg = msgs[2];
      expect(toolResultMsg?.role).toBe('user');
      const blocks = toolResultMsg?.content as ContentBlockParam[];
      const toolResult = blocks.find(
        (b) => (b as { type: string }).type === 'tool_result',
      ) as { content: string } | undefined;
      expect(toolResult).toBeDefined();
      const snapshot = JSON.parse(toolResult!.content) as {
        self?: { model?: { provider?: string; name?: string }; cwd?: string };
      };
      expect(snapshot.self).toBeDefined();
      expect(snapshot.self?.model?.provider).toBe('anthropic-direct');
      expect(snapshot.self?.model?.name).toBe('claude-sonnet-5');
      expect(snapshot.self?.cwd).toBeDefined();

      // Tool-output event surfaced to the harness mirrors the snapshot.
      const toolOutput = events.find((e) => e.type === 'tool.output');
      expect(toolOutput).toBeDefined();
      if (toolOutput?.type === 'tool.output') {
        const parsed = JSON.parse(toolOutput.content) as { self?: unknown };
        expect(parsed.self).toBeDefined();
        expect(toolOutput.isError).toBeUndefined();
      }
    });

    it('non-awareness tool calls still delegate to the inner dispatcher verbatim', async () => {
      let callIdx = 0;
      messagesCreateMock.mockImplementation(() => {
        callIdx += 1;
        if (callIdx === 1) {
          return fromArray(makeToolUseStream('toolu_b', 'bash', '{"command":"ls"}'));
        }
        return fromArray(makeTextStream('done'));
      });

      const dispatched: ToolCall[] = [];
      const dispatcher: ToolDispatcher = {
        async execute(call: ToolCall): Promise<ToolResult> {
          dispatched.push(call);
          return { content: 'ls-output' };
        },
      };

      const provider = new AnthropicDirectProvider({ tools: dispatcher });
      const query = provider.query({
        prompt: singleInput('list files'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-ant-api03-test' },
      });
      await collect(query);

      // Inner dispatcher must see the bash call exactly once.
      expect(dispatched.length).toBe(1);
      expect(dispatched[0]?.name).toBe('bash');
      expect(dispatched[0]?.input).toEqual({ command: 'ls' });
    });
  });
});
