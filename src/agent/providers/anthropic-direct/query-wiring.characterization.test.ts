/**
 * Characterization tests for `AnthropicDirectProvider.query()` wiring (#824).
 *
 * Written BEFORE the index.ts decomposition and required to stay green
 * verbatim afterwards.
 *
 * THE HAZARD THIS FILE EXISTS FOR
 * -------------------------------
 * `query()` contains a deliberate late-binding cycle:
 *
 *   1. `let queryDispatcher` is DECLARED (no initializer).
 *   2. `runtimeStateSource` is BUILT, capturing `queryDispatcher` inside the
 *      `getEnabledToolNames` closure — which reads the binding lazily.
 *   3. `runtimeStateSource` is PASSED INTO `buildDispatcher(...)`, whose return
 *      value is ASSIGNED to `queryDispatcher`.
 *
 * So the source is constructed before the dispatcher exists, and the dispatcher
 * is constructed with a reference to that source. The only thing keeping this
 * correct is that `getEnabledToolNames` defers its read to call time.
 *
 * If an extraction reorders these three steps — e.g. snapshots the tool names
 * eagerly, or builds a second source AFTER the dispatcher and hands the
 * dispatcher the stale first one — `get_runtime_state` silently reports the
 * WRONG tool list. No throw, no type error, no failing assertion anywhere else
 * in the suite. The `tools.enabled` assertions below are the tripwire: they
 * drive a real `get_runtime_state` call through the real dispatcher and require
 * the answer to reflect the dispatcher that was actually installed.
 *
 * Observation strategy: mock Anthropic client (the established idiom from
 * `output-cap-wiring.test.ts:33-58`), a scripted tool_use round calling
 * `get_runtime_state`, then parse the `tool.output` event's JSON payload.
 *
 * @module agent/providers/anthropic-direct/query-wiring.characterization.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import type { RuntimeSnapshot } from '../../awareness/index.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import { tool } from '../../tools/custom-tool.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

function installFactory(): void {
  __setAnthropicClientFactory(() => new MockAnthropic() as unknown as Anthropic);
}

async function* singleInput(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function collect(query: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of query) out.push(ev);
  return out;
}

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
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_done',
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
    { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Script: round 1 calls `get_runtime_state`, round 2 ends the turn. */
function scriptRuntimeStateCall(view: string): void {
  let callIdx = 0;
  messagesCreateMock.mockImplementation(() => {
    callIdx += 1;
    if (callIdx === 1) {
      return fromArray(
        makeToolUseStream('toolu_rs', 'get_runtime_state', JSON.stringify({ view })),
      );
    }
    return fromArray(makeTextStream('done'));
  });
}

function snapshotFrom(events: ProviderEvent[]): Partial<RuntimeSnapshot> {
  const ev = events.find((e) => e.type === 'tool.output');
  if (!ev || ev.type !== 'tool.output') throw new Error('expected a tool.output event');
  return JSON.parse(ev.content) as Partial<RuntimeSnapshot>;
}

const BASE_CONFIG = { model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' } as const;

describe('query() characterization (#824) — queryDispatcher / getEnabledToolNames ordering', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
  });

  it('get_runtime_state reports the LIVE dispatcher tool list (the late-binding tripwire)', async () => {
    scriptRuntimeStateCall('tools');
    const provider = new AnthropicDirectProvider();
    const events = await collect(
      provider.query({ prompt: singleInput('orient'), config: { ...BASE_CONFIG } }),
    );

    const enabled = snapshotFrom(events).tools?.enabled ?? [];
    // A non-empty list is the whole point: if the closure read `queryDispatcher`
    // before assignment (or an extraction snapshotted names eagerly), the
    // `instanceof SessionToolDispatcher` guard fails and this is `[]`.
    expect(enabled.length).toBeGreaterThan(0);
    expect(enabled).toContain('bash');
    expect(enabled).toContain('get_runtime_state');
  });

  it('reflects a CUSTOM tool registered on the dispatcher built inside the same query()', async () => {
    // Strongest form of the ordering assertion: this name exists only on the
    // dispatcher that `query()` constructs. Seeing it proves the closure read
    // the POST-assignment binding, not a pre-built or default tool list.
    scriptRuntimeStateCall('tools');
    const marker = tool('char_late_bound_marker', 'marker', z.object({}), async () => ({
      content: 'x',
    }));
    const provider = new AnthropicDirectProvider({ customTools: [marker] });
    const events = await collect(
      provider.query({ prompt: singleInput('orient'), config: { ...BASE_CONFIG } }),
    );

    expect(snapshotFrom(events).tools?.enabled).toContain('char_late_bound_marker');
  });

  it('reports the enabled list even when the caller injects an EXTERNAL dispatcher', async () => {
    // The `externalTools` branch takes the other path (wrapDispatcherWithRuntimeState).
    // The wrapper is NOT a SessionToolDispatcher, so `getEnabledToolNames`
    // returns [] by design — pinned here so an extraction cannot quietly
    // change which branch feeds the awareness layer.
    scriptRuntimeStateCall('tools');
    const external = {
      execute: async () => ({ content: 'external' }),
      toolDefs: [],
    };
    const provider = new AnthropicDirectProvider({ tools: external as never });
    const events = await collect(
      provider.query({ prompt: singleInput('orient'), config: { ...BASE_CONFIG } }),
    );

    expect(snapshotFrom(events).tools?.enabled).toEqual([]);
  });

  it('exposes get_runtime_state to the model on the external-dispatcher path', async () => {
    // Companion to the above: even though the enabled list is empty, the tool
    // SCHEMA must still be advertised or the awareness layer is unreachable.
    scriptRuntimeStateCall('tools');
    const external = {
      execute: async () => ({ content: 'external' }),
      toolDefs: [],
    };
    const provider = new AnthropicDirectProvider({ tools: external as never });
    await collect(
      provider.query({ prompt: singleInput('orient'), config: { ...BASE_CONFIG } }),
    );

    const sent = messagesCreateMock.mock.calls[0]?.[0] as { tools: { name: string }[] };
    expect(sent.tools.map((t) => t.name)).toContain('get_runtime_state');
  });
});

describe('query() characterization (#824) — runtime-state identity fields', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
  });

  it('threads model, permission mode and identity from the query config into the source', async () => {
    scriptRuntimeStateCall('self');
    const provider = new AnthropicDirectProvider({ surface: 'daemon' });
    const events = await collect(
      provider.query({
        prompt: singleInput('orient'),
        config: {
          ...BASE_CONFIG,
          permissionMode: 'bypassPermissions',
          sessionId: 'sid-char-1',
          parentSessionId: 'pid-char-1',
          depth: 2,
          maxDepth: 3,
        },
      }),
    );

    const self = snapshotFrom(events).self;
    expect(self?.sessionId).toBe('sid-char-1');
    expect(self?.parentSessionId).toBe('pid-char-1');
    expect(self?.depth).toBe(2);
    expect(self?.maxDepth).toBe(3);
    expect(self?.surface).toBe('daemon');
    expect(self?.model.provider).toBe('anthropic-direct');
    expect(self?.model.name).toBe('claude-sonnet-5');
    // Deliberately BUCKETED, not passed through: the awareness layer reports a
    // coarse 'elevated' | 'default' so the raw mode is not surfaced to the
    // model (anti-injection). `bypassPermissions` buckets to 'elevated'.
    expect(self?.permissionMode).toBe('elevated');
  });

  it('buckets a restrictive mode to default rather than reporting it verbatim', async () => {
    scriptRuntimeStateCall('self');
    const provider = new AnthropicDirectProvider();
    const events = await collect(
      provider.query({
        prompt: singleInput('orient'),
        config: { ...BASE_CONFIG, permissionMode: 'plan' },
      }),
    );
    // plan / autonomous are RESTRICTIVE, so they must not read as 'elevated'.
    expect(snapshotFrom(events).self?.permissionMode).toBe('default');
  });
});

describe('query() characterization (#824) — tool-def filtering', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
  });

  function toolsSent(): string[] {
    const sent = messagesCreateMock.mock.calls[0]?.[0] as { tools: { name: string }[] };
    return sent.tools.map((t) => t.name);
  }

  it('advertises ask_question and terminal_font_size on a normal session', async () => {
    const provider = new AnthropicDirectProvider();
    await collect(provider.query({ prompt: singleInput('hi'), config: { ...BASE_CONFIG } }));
    const names = toolsSent();
    expect(names).toContain('ask_question');
    expect(names).toContain('terminal_font_size');
  });

  it('strips BOTH ask_question and terminal_font_size for a skill dispatch', async () => {
    const provider = new AnthropicDirectProvider();
    await collect(
      provider.query({
        prompt: singleInput('hi'),
        config: { ...BASE_CONFIG, isSkillDispatch: true },
      }),
    );
    const names = toolsSent();
    expect(names).not.toContain('ask_question');
    expect(names).not.toContain('terminal_font_size');
  });

  it('strips ONLY ask_question on a non-interactive surface', async () => {
    const provider = new AnthropicDirectProvider();
    await collect(
      provider.query({
        prompt: singleInput('hi'),
        config: { ...BASE_CONFIG, isNonInteractive: true },
      }),
    );
    const names = toolsSent();
    expect(names).not.toContain('ask_question');
    expect(names).toContain('terminal_font_size');
  });
});

describe('query() characterization (#824) — skill manifest / skill-tool lockstep', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
  });

  // Invariant: the constructor gates the `skill` TOOL on `if (opts.skillExecutor)`
  // (truthiness) and query() gates the skill MANIFEST on the same executor.
  // The two gates must agree, or the system prompt advertises skills the model
  // has no tool to invoke. Pinned with a falsy-but-present value because that
  // is the only input that can separate `Boolean(x)` from `x !== undefined`.
  it('advertises neither the skill tool nor a manifest when no executor is wired', async () => {
    const provider = new AnthropicDirectProvider();
    await collect(provider.query({ prompt: singleInput('hi'), config: { ...BASE_CONFIG } }));

    const sent = messagesCreateMock.mock.calls[0]?.[0] as {
      tools: { name: string }[];
      system: { text: string }[];
    };
    expect(sent.tools.map((t) => t.name)).not.toContain('skill');
    expect(sent.system.map((s) => s.text).join('\n')).not.toContain('Available skills');
  });

  it('keeps manifest and skill-tool gates in lockstep for a falsy executor', async () => {
    // `null` is falsy but NOT undefined: the constructor skips the skill tool,
    // so query() must also skip the manifest.
    const provider = new AnthropicDirectProvider({ skillExecutor: null as never });
    await collect(provider.query({ prompt: singleInput('hi'), config: { ...BASE_CONFIG } }));

    const sent = messagesCreateMock.mock.calls[0]?.[0] as {
      tools: { name: string }[];
      system: { text: string }[];
    };
    const hasSkillTool = sent.tools.some((t) => t.name === 'skill');
    const hasManifest = sent.system.map((s) => s.text).join('\n').includes('Available skills');
    expect(hasSkillTool).toBe(false);
    expect(hasManifest).toBe(hasSkillTool);
  });
});

describe('query() characterization (#824) — token + client construction', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
  });

  it('throws when no token can be resolved', () => {
    installFactory();
    const provider = new AnthropicDirectProvider();
    expect(() =>
      provider.query({ prompt: singleInput('hi'), config: { model: 'claude-sonnet-5' } }),
    ).toThrow(/requires config\.apiKey/);
  });

  it('prefers the per-instance clientFactory over the module-scope hook', async () => {
    let moduleHookCalls = 0;
    let instanceFactoryCalls = 0;
    __setAnthropicClientFactory(() => {
      moduleHookCalls += 1;
      return new MockAnthropic() as unknown as Anthropic;
    });
    const provider = new AnthropicDirectProvider({
      clientFactory: () => {
        instanceFactoryCalls += 1;
        return new MockAnthropic() as unknown as Anthropic;
      },
    });
    await collect(provider.query({ prompt: singleInput('hi'), config: { ...BASE_CONFIG } }));

    expect(instanceFactoryCalls).toBe(1);
    expect(moduleHookCalls).toBe(0);
  });

  it('sends the OAuth billing-header system prefix FIRST for an sk-ant-oat01 token', async () => {
    installFactory();
    const provider = new AnthropicDirectProvider();
    await collect(provider.query({ prompt: singleInput('hi'), config: { ...BASE_CONFIG } }));

    const sent = messagesCreateMock.mock.calls[0]?.[0] as {
      system: { type: string; text: string }[];
    };
    // The OAuth billing header must lead the system array — the API keys
    // subscription billing off this block's position.
    expect(sent.system[0]?.text).toContain('x-anthropic-billing-header');
    expect(sent.system.length).toBeGreaterThan(1);
  });

  it('omits the OAuth billing prefix for a plain api-key token', async () => {
    installFactory();
    const provider = new AnthropicDirectProvider();
    await collect(
      provider.query({
        prompt: singleInput('hi'),
        config: { model: 'claude-sonnet-5', apiKey: 'sk-plain-api-key' },
      }),
    );

    const sent = messagesCreateMock.mock.calls[0]?.[0] as {
      system: { type: string; text: string }[];
    };
    expect(sent.system[0]?.text).not.toContain('x-anthropic-billing-header');
  });

  it('resolves maxTokens and passes the resolved model id to the wire', async () => {
    installFactory();
    const provider = new AnthropicDirectProvider();
    await collect(provider.query({ prompt: singleInput('hi'), config: { ...BASE_CONFIG } }));

    const sent = messagesCreateMock.mock.calls[0]?.[0] as {
      model: string;
      max_tokens: number;
    };
    expect(typeof sent.model).toBe('string');
    expect(sent.model.length).toBeGreaterThan(0);
    expect(sent.max_tokens).toBeGreaterThan(0);
  });
});

describe('query() characterization (#824) — shared roots and grants', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
  });

  it('adopts caller-supplied roots on first query and keeps array identity across turns', async () => {
    const provider = new AnthropicDirectProvider();
    await collect(
      provider.query({
        prompt: singleInput('hi'),
        config: { ...BASE_CONFIG, cwd: '/work', readRoots: ['/work', '/extra'], writeRoots: ['/work'] },
      }),
    );

    const firstRead = (provider as any)._sharedReadRoots;
    expect(firstRead).toEqual(['/work', '/extra']);
    expect(provider.getGrants().readRoots).toEqual(['/work', '/extra']);

    await collect(
      provider.query({ prompt: singleInput('again'), config: { ...BASE_CONFIG, cwd: '/work' } }),
    );
    // Same array instance across turns — grants must survive by reference.
    expect((provider as any)._sharedReadRoots).toBe(firstRead);
  });

  it('tracks the permission mode for getGrants().allowAll', async () => {
    const provider = new AnthropicDirectProvider();
    await collect(
      provider.query({
        prompt: singleInput('hi'),
        config: { ...BASE_CONFIG, cwd: '/work', permissionMode: 'bypassPermissions' },
      }),
    );
    expect(provider.getGrants().allowAll).toBe(true);
  });

  it('pins the initial cwd as the non-revocable grant anchor', async () => {
    const provider = new AnthropicDirectProvider();
    await collect(
      provider.query({ prompt: singleInput('hi'), config: { ...BASE_CONFIG, cwd: '/work' } }),
    );
    expect(provider.getGrants().resolveBase).toBe('/work');
  });
});
