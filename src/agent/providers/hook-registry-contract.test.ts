/**
 * Provider CONTRACT test — the session-scoped hook registry must reach the
 * dispatcher across EVERY provider.
 *
 * Invariant under test: a provider built WITHOUT a constructor-time
 * `hookRegistry` (the production shape — REPL/chat/daemon/telegram) must still
 * fire `PreToolUse` gates supplied on `AgentConfig.hookRegistry`. The canonical
 * example is the plan-mode write gate: in `'plan'` mode a write-class tool
 * (`edit_file`) must be REFUSED before its handler runs.
 *
 * This is the cross-provider regression guard for c6892c6 (`config.hookRegistry`
 * dropped on the internal dispatcher path → write tools ran unblocked in plan
 * mode). The per-provider wiring tests
 * (`anthropic-direct/plan-mode-gate-wiring.test.ts` and the plan-mode block in
 * `openai-compatible/query.test.ts`) each cover one backend; this file asserts
 * the SAME invariant uniformly. Adding a new `ModelProvider` = add one
 * `ProviderContractCase` to `PROVIDER_CASES`, and the contract is enforced for
 * it automatically.
 *
 * Structural backstop: `resolveSessionHookRegistry` is the one canonical merge
 * point both providers use, and `SessionToolDispatcherOptions.hookRegistry` is a
 * required key — so a provider that forgets to thread the registry is a compile
 * error, not a silent runtime gap. The runtime tests below prove the wiring is
 * not just present but correct.
 *
 * No `@anthropic-ai/sdk` / `openai` imports: mock backends are plain objects,
 * keeping this test out of the SDK dependency-lock surface.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ModelProvider, ProviderEvent, ProviderUserTurn } from '../provider.js';
import type { AgentConfig } from '../types/config-types.js';
import { createHookRegistry, resolveSessionHookRegistry, type HookRegistry } from '../hooks.js';
import { createPlanModeGate } from '../plan-mode-gate.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './anthropic-direct/index.js';
import { OpenAICompatibleProvider, __setOpenAIClientFactory } from './openai-compatible/index.js';
import type { OpenAIChunk } from './openai-compatible/translate.js';

// --- shared fixtures -------------------------------------------------------

/** Targets a path that does not exist: if the gate does NOT fire, the real
 *  edit_file handler runs and returns a "not found" error — never the
 *  plan-mode refusal — so the negative assertions stay unambiguous. */
const EDIT_FILE_INPUT = JSON.stringify({
  file_path: '/tmp/afk-hook-registry-contract-nonexistent.txt',
  old_string: 'a',
  new_string: 'b',
});

/** A registry carrying ONLY the plan-mode gate, in the requested mode. */
function planGateRegistry(mode: 'plan' | 'default'): HookRegistry {
  const registry = createHookRegistry();
  registry.register('PreToolUse', createPlanModeGate(() => mode));
  return registry;
}

async function* singleInput(content: string): AsyncIterable<ProviderUserTurn> {
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

function toolOutputOf(events: ProviderEvent[]): { content: string; isError?: boolean } {
  const ev = events.find((e) => e.type === 'tool.output');
  if (!ev || ev.type !== 'tool.output') throw new Error('expected a tool.output event');
  return { content: ev.content, ...(ev.isError !== undefined ? { isError: ev.isError } : {}) };
}

// --- provider adapters -----------------------------------------------------

interface ProviderContractCase {
  readonly name: string;
  /** Install a mock backend that emits an `edit_file` tool call, then a text turn. */
  installEditThenDone(): void;
  /** Tear down the mock backend client factory. */
  resetClient(): void;
  /** Construct the provider WITHOUT a constructor-time registry, allowing `edit_file`. */
  makeProvider(): ModelProvider;
  /** Build a query config in the given mode (+ optional parent session / registry). */
  makeConfig(opts: {
    permissionMode: 'plan' | 'default';
    parentSessionId?: string;
    hookRegistry?: HookRegistry;
  }): AgentConfig;
}

// ---- Anthropic adapter (plain-object Messages-API stream) ----

const anthropicMessagesCreate = vi.fn();

function anthropicEvent(obj: Record<string, unknown>): unknown {
  return obj;
}

function anthropicToolUseStream(toolId: string, toolName: string, inputJson: string): unknown[] {
  const usage = {
    input_tokens: 7,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: null,
    service_tier: null,
  };
  return [
    anthropicEvent({
      type: 'message_start',
      message: {
        id: 'msg_t',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    }),
    anthropicEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    }),
    anthropicEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    }),
    anthropicEvent({ type: 'content_block_stop', index: 0 }),
    anthropicEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
    anthropicEvent({ type: 'message_stop' }),
  ];
}

function anthropicTextStream(text: string): unknown[] {
  return [
    anthropicEvent({
      type: 'message_start',
      message: {
        id: 'msg_done',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-5-20250929',
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
    }),
    anthropicEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    }),
    anthropicEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    anthropicEvent({ type: 'content_block_stop', index: 0 }),
    anthropicEvent({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    }),
    anthropicEvent({ type: 'message_stop' }),
  ];
}

const anthropicCase: ProviderContractCase = {
  name: 'AnthropicDirectProvider',
  installEditThenDone() {
    anthropicMessagesCreate.mockReset();
    let callIdx = 0;
    anthropicMessagesCreate.mockImplementation(() => {
      callIdx += 1;
      return callIdx === 1
        ? fromArray(anthropicToolUseStream('toolu_edit', 'edit_file', EDIT_FILE_INPUT))
        : fromArray(anthropicTextStream('done'));
    });
    const mockClient = { messages: { create: anthropicMessagesCreate } };
    __setAnthropicClientFactory(
      (() => mockClient) as unknown as Parameters<typeof __setAnthropicClientFactory>[0],
    );
  },
  resetClient() {
    __setAnthropicClientFactory(null);
    anthropicMessagesCreate.mockReset();
  },
  makeProvider() {
    return new AnthropicDirectProvider({ permissions: { allowedTools: ['edit_file'] } });
  },
  makeConfig({ permissionMode, parentSessionId, hookRegistry }) {
    return {
      model: 'claude-sonnet-4-5-20250929',
      apiKey: 'sk-ant-oat01-test',
      permissionMode,
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(hookRegistry !== undefined ? { hookRegistry } : {}),
    } as AgentConfig;
  },
};

// ---- OpenAI-compatible adapter (plain-object Chat-Completions stream) ----

let openaiScript: Array<{ chunks: OpenAIChunk[] }> = [];
let openaiTurnIndex = 0;

function installOpenAIScriptedClient(): void {
  openaiTurnIndex = 0;
  const mockClient = {
    chat: {
      completions: {
        create: async (args: { stream?: boolean }) => {
          if (!args.stream) throw new Error('contract mock only supports streaming');
          const turn = openaiScript[openaiTurnIndex++];
          if (!turn) throw new Error(`openai scripted turn ${openaiTurnIndex - 1} not defined`);
          const chunks = turn.chunks.slice();
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
  __setOpenAIClientFactory(
    (() => mockClient) as unknown as Parameters<typeof __setOpenAIClientFactory>[0],
  );
}

const openaiCase: ProviderContractCase = {
  name: 'OpenAICompatibleProvider',
  installEditThenDone() {
    openaiScript = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_edit',
                      type: 'function',
                      function: { name: 'edit_file', arguments: EDIT_FILE_INPUT },
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
        ] as unknown as OpenAIChunk[],
      },
      {
        chunks: [
          {
            choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          },
        ] as unknown as OpenAIChunk[],
      },
    ];
    installOpenAIScriptedClient();
  },
  resetClient() {
    __setOpenAIClientFactory(null);
    openaiScript = [];
    openaiTurnIndex = 0;
  },
  makeProvider() {
    return new OpenAICompatibleProvider({ permissions: { allowedTools: ['edit_file'] } });
  },
  makeConfig({ permissionMode, parentSessionId, hookRegistry }) {
    return {
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-key',
      permissionMode,
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(hookRegistry !== undefined ? { hookRegistry } : {}),
    } as AgentConfig;
  },
};

const PROVIDER_CASES: ProviderContractCase[] = [anthropicCase, openaiCase];

// --- the contract ----------------------------------------------------------

describe('canonical hook-registry resolver', () => {
  const a = createHookRegistry();
  const b = createHookRegistry();

  it('prefers the query-scoped (config) registry over the constructor-scoped one', () => {
    expect(resolveSessionHookRegistry(a, b)).toBe(a);
  });

  it('falls back to the constructor-scoped registry when the query one is absent', () => {
    expect(resolveSessionHookRegistry(undefined, b)).toBe(b);
  });

  it('returns undefined when neither is set', () => {
    expect(resolveSessionHookRegistry(undefined, undefined)).toBeUndefined();
  });
});

describe.each(PROVIDER_CASES)(
  'provider contract: $name threads config.hookRegistry to the dispatcher',
  (providerCase) => {
    beforeEach(() => {
      providerCase.installEditThenDone();
    });

    afterEach(() => {
      providerCase.resetClient();
    });

    it('BLOCKS edit_file in plan mode (gate supplied on config.hookRegistry)', async () => {
      const provider = providerCase.makeProvider();
      const query = provider.query({
        prompt: singleInput('edit the file'),
        config: providerCase.makeConfig({
          permissionMode: 'plan',
          hookRegistry: planGateRegistry('plan'),
        }),
      });

      const out = toolOutputOf(await collect(query));

      // The session registry reached the dispatcher and the gate fired.
      expect(out.isError).toBe(true);
      expect(out.content).toContain('plan mode');
    });

    it('does NOT block edit_file in default mode', async () => {
      const provider = providerCase.makeProvider();
      const query = provider.query({
        prompt: singleInput('edit the file'),
        config: providerCase.makeConfig({
          permissionMode: 'default',
          hookRegistry: planGateRegistry('default'),
        }),
      });

      const out = toolOutputOf(await collect(query));

      expect(out.content).not.toContain('plan mode');
      expect(out.content).not.toContain('blocked by PreToolUse hook');
    });

    it('does NOT block edit_file for a forked subagent (parentSessionId self-skip)', async () => {
      const provider = providerCase.makeProvider();
      const query = provider.query({
        prompt: singleInput('edit the file'),
        config: providerCase.makeConfig({
          permissionMode: 'plan',
          parentSessionId: 'parent-session-123',
          hookRegistry: planGateRegistry('plan'),
        }),
      });

      const out = toolOutputOf(await collect(query));

      // The registry is still threaded — the gate just self-skips for subagents,
      // proving the wiring is present without over-blocking task output.
      expect(out.content).not.toContain('plan mode');
      expect(out.content).not.toContain('blocked by PreToolUse hook');
    });
  },
);
