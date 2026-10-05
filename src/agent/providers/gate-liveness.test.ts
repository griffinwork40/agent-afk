/**
 * Gate LIVENESS tests – gate 1 & 4.
 *
 * Gate 1: CAN_USE_TOOL_PROVIDER_WIRING
 *   Proves that a `canUseTool` deny callback wired through the real Anthropic
 *   and OpenAI-compatible providers (the `...(deps.canUseTool !== undefined ?
 *   { canUseTool: deps.canUseTool } : {})` spread at build-dispatcher.ts:316
 *   and openai-compatible/index.ts:562-563) reaches the dispatcher's
 *   `runCanUseTool` gate and prevents the handler from running.
 *
 *   Mutation probe target: build-dispatcher.ts line ~316 — remove the optional
 *   spread so `canUseTool` is never forwarded to the dispatcher.
 *
 * Gate 4: WEB_REQUEST_DOMAIN_POLICY_PROD_PATH
 *   Proves that `createWebRequestHandler()` called with NO `domainCheck` opt
 *   (the production default) still refuses requests to a blocked domain when
 *   `AFK_BROWSER_BLOCKED_DOMAINS` is set via `vi.stubEnv`. This exercises the
 *   lazy `resolveDomainCheck()` path that imports browser/config.js at runtime.
 *
 *   Mutation probe target: web-request.ts resolveDomainCheck() — make it always
 *   return undefined (discarding the env-loaded config).
 *
 * NOTE on the fail-open fallback: when `browser/config.js` fails to import
 * (e.g. missing dep) `resolveDomainCheck` swallows the error and returns
 * `undefined`, allowing the request through. This file does NOT change that
 * behaviour — we merely prove the HAPPY path (successful import + env block)
 * works end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderEvent, ProviderUserTurn } from '../provider.js';
import type { AgentConfig } from '../types/config-types.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './anthropic-direct/index.js';
import { OpenAICompatibleProvider, __setOpenAIClientFactory } from './openai-compatible/index.js';
import type { OpenAIChunk } from './openai-compatible/translate.js';
import { createWebRequestHandler } from '../tools/handlers/web-request.js';

// ============================================================================
// Shared streaming helpers (mirrors hook-registry-contract.test.ts patterns)
// ============================================================================

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

// ============================================================================
// Scripted Anthropic stream helpers
// ============================================================================

const anthropicMessagesCreate = vi.fn();

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
    { type: 'message_start', message: { id: 'msg_t', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null, usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputJson } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ];
}

function anthropicTextStream(text: string): unknown[] {
  return [
    { type: 'message_start', message: { id: 'msg_done', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
}

// ============================================================================
// Scripted OpenAI stream helpers
// ============================================================================

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
          return (async function* () { for (const c of chunks) yield c; })();
        },
      },
    },
  };
  __setOpenAIClientFactory((() => mockClient) as unknown as Parameters<typeof __setOpenAIClientFactory>[0]);
}

// ============================================================================
// Gate 1: CAN_USE_TOOL_PROVIDER_WIRING
//
// Both providers are scripted to emit a `read_file` tool call on turn 1 then a
// text "done" on turn 2. The providers are constructed with:
//   - `allowedTools: ['read_file']` (static allowlist permits the tool)
//   - `canUseTool` that DENIES `read_file`
//
// Assertion: the tool.output carries `isError: true` and a permission-denied
// message, proving the canUseTool callback reached the dispatcher and the
// handler never ran. If the spread at build-dispatcher.ts:316 (or
// openai/index.ts:562-563) is deleted, canUseTool is undefined in the
// dispatcher, `runCanUseTool` returns null immediately (allow-all), and the
// handler runs — the test then fails because `isError` is undefined.
// ============================================================================

const READ_FILE_INPUT = JSON.stringify({ file_path: '/nonexistent/gate-liveness' });

describe('Gate 1 — CAN_USE_TOOL_PROVIDER_WIRING', () => {
  afterEach(() => {
    __setAnthropicClientFactory(null);
    anthropicMessagesCreate.mockReset();
    __setOpenAIClientFactory(null);
    openaiScript = [];
    openaiTurnIndex = 0;
  });

  it('AnthropicDirectProvider: canUseTool deny blocks read_file before handler runs', async () => {
    // Script: turn 1 = read_file call, turn 2 = text "done"
    anthropicMessagesCreate.mockReset();
    let callIdx = 0;
    anthropicMessagesCreate.mockImplementation(() => {
      callIdx += 1;
      return callIdx === 1
        ? fromArray(anthropicToolUseStream('toolu_rf', 'read_file', READ_FILE_INPUT))
        : fromArray(anthropicTextStream('done'));
    });
    __setAnthropicClientFactory(
      (() => ({ messages: { create: anthropicMessagesCreate } })) as unknown as Parameters<typeof __setAnthropicClientFactory>[0],
    );

    // Build provider with canUseTool that denies read_file
    const provider = new AnthropicDirectProvider({
      permissions: { allowedTools: ['read_file'] },
      canUseTool: async (toolName) => ({
        behavior: 'deny',
        message: `gate-liveness: canUseTool denied ${toolName}`,
      }),
    });

    const config: AgentConfig = {
      model: 'claude-sonnet-5',
      apiKey: 'sk-ant-oat01-test',
    } as AgentConfig;

    const events = await collect(provider.query({ prompt: singleInput('read the file'), config }));
    const out = toolOutputOf(events);

    expect(out.isError).toBe(true);
    expect(out.content).toContain('gate-liveness: canUseTool denied read_file');
  });

  it('OpenAICompatibleProvider: canUseTool deny blocks read_file before handler runs', async () => {
    openaiScript = [
      {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_rf', type: 'function', function: { name: 'read_file', arguments: READ_FILE_INPUT } },
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
          { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
        ] as unknown as OpenAIChunk[],
      },
    ];
    installOpenAIScriptedClient();

    const provider = new OpenAICompatibleProvider({
      permissions: { allowedTools: ['read_file'] },
      canUseTool: async (toolName) => ({
        behavior: 'deny',
        message: `gate-liveness: canUseTool denied ${toolName}`,
      }),
    });

    const config: AgentConfig = {
      model: 'gpt-4o-mini',
      apiKey: 'sk-test-key',
    } as AgentConfig;

    const events = await collect(provider.query({ prompt: singleInput('read the file'), config }));
    const out = toolOutputOf(events);

    expect(out.isError).toBe(true);
    expect(out.content).toContain('gate-liveness: canUseTool denied read_file');
  });
});

// ============================================================================
// Gate 4: WEB_REQUEST_DOMAIN_POLICY_PROD_PATH
//
// createWebRequestHandler() is called with NO domainCheck opt (the prod path).
// AFK_BROWSER_BLOCKED_DOMAINS is set via vi.stubEnv so loadBrowserConfig() reads
// it through the `env` lazy-getter (process.env-backed) proxy.
// A spy fetchFn asserts it is never called — domain check fires before fetch.
//
// NOTE: resolveDomainCheck() does a dynamic import of browser/config.js. Since
// vitest runs with the same Node module cache this import succeeds in tests.
// The function catches import failures → undefined → fail-open (documented; not
// tested here — a separate concern).
//
// Mutation probe target: in resolveDomainCheck(), replace the try block body
// with `return undefined` — the test then fails because fetchFn IS called and
// the request is NOT refused.
// ============================================================================

describe('Gate 4 — WEB_REQUEST_DOMAIN_POLICY_PROD_PATH', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('blocks request to domain in AFK_BROWSER_BLOCKED_DOMAINS without calling fetchFn', async () => {
    vi.stubEnv('AFK_BROWSER_BLOCKED_DOMAINS', 'blocked-gate-liveness.example.com');

    const fetchSpy = vi.fn(async () => {
      throw new Error('fetchFn must not be called for a blocked domain');
    });

    // DNS lookup seam: resolves to a public IP so the SSRF guard would pass.
    // This ensures any failure is from the domain policy, not the SSRF guard.
    const publicLookup = async (): Promise<readonly { address: string }[]> => [
      { address: '93.184.216.34' },
    ];

    // NO domainCheck opt — exercises the lazy resolveDomainCheck() production path.
    // readFileSyncFn: () => undefined suppresses any real browser.json read so the
    // test is isolated from whatever browser.json the developer may have configured.
    const handler = createWebRequestHandler({
      fetchFn: fetchSpy as typeof fetch,
      lookupFn: publicLookup,
      readFileSyncFn: () => undefined,
      // domainCheck intentionally omitted — this is the production default path
    });

    const result = await handler(
      { url: 'https://blocked-gate-liveness.example.com/path', method: 'GET' },
      new AbortController().signal,
    );

    // Domain policy must have blocked the request
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/blocked/i);

    // fetchFn must NOT have been called — the domain check fires before fetch
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows request to a non-blocked domain (positive control)', async () => {
    vi.stubEnv('AFK_BROWSER_BLOCKED_DOMAINS', 'other-blocked.example.com');

    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    const publicLookup = async (): Promise<readonly { address: string }[]> => [
      { address: '93.184.216.34' },
    ];

    const handler = createWebRequestHandler({
      fetchFn: fetchSpy as typeof fetch,
      lookupFn: publicLookup,
      readFileSyncFn: () => undefined,
    });

    const result = await handler(
      { url: 'https://allowed-gate-liveness.example.com/path', method: 'GET' },
      new AbortController().signal,
    );

    // Request should succeed (not blocked by domain policy)
    expect(result.isError).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
