import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelProvider } from '../agent/provider.js';
import type { TelegramSessionBuildContext } from './session-context.js';

const mocks = vi.hoisted(() => ({ finalize: vi.fn(), seed: vi.fn() }));
vi.mock('./session-lifecycle.js', () => ({ finalizeTelegramSession: mocks.finalize }));
vi.mock('../agent/permissions-store.js', () => ({ seedPersistedGrants: mocks.seed }));
vi.mock('./wire-telegram-executors.js', () => ({
  wireTelegramExecutors: () => ({ executors: { subagentExecutor: {}, skillExecutor: {}, composeExecutor: {} } }),
}));
import { buildTelegramSession } from './session-builder.js';
import { buildTelegramProvider } from './session-provider.js';
import { useTmpAfkHome } from '../agent/journal/__test-utils__/helpers.js';
import { AnthropicDirectProvider, OpenAICompatibleProvider } from '../agent/providers/index.js';

useTmpAfkHome();
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

function context(model: string): TelegramSessionBuildContext {
  return {
    sessionConfig: { model, openaiBaseUrl: 'http://session-openai.test/v1', xaiBaseUrl: 'http://xai.test/v1' },
    config: { baseUrl: 'http://anthropic.test', openaiBaseUrl: 'http://global-openai.test/v1' },
    sessionCwd: path.join(os.tmpdir(), 'workspace'), traceWriter: null,
    mcpManager: { getMcpToolWireNames: () => ['mcp__test__read'] },
    workspaceStore: {}, stateStore: {},
  } as unknown as TelegramSessionBuildContext;
}

function build(ctx: TelegramSessionBuildContext) {
  buildTelegramSession({
    ctx, providerConfig: {},
    providerFactory: ({ executors }) => buildTelegramProvider(ctx, executors),
  });
  const [primary, endpoints, , , factory] = mocks.finalize.mock.calls.at(-1)!;
  return {
    primary: primary as ModelProvider,
    endpoints,
    factory: factory as (model: string) => AnthropicDirectProvider | OpenAICompatibleProvider,
  };
}

describe('Telegram fallback provider wiring', () => {
  it('keeps family-specific destination endpoints and session endpoint precedence', () => {
    const result = build(context('claude-sonnet-4-6'));
    expect(result.endpoints).toEqual({
      baseUrl: 'http://anthropic.test', openaiBaseUrl: 'http://session-openai.test/v1', xaiBaseUrl: 'http://xai.test/v1',
    });
    expect(result.factory('claude-haiku-5-5')).toBe(result.primary);
    expect(result.factory('gpt-4o')).toBe(result.factory('gpt-4o'));
  });

  it('uses the global OpenAI endpoint when the session has no override', () => {
    const ctx = context('claude-sonnet-4-6');
    delete ctx.sessionConfig.openaiBaseUrl;
    expect(build(ctx).endpoints.openaiBaseUrl).toBe('http://global-openai.test/v1');
  });

  it.each(['claude-sonnet-4-6', 'gpt-4o'])('retains executors, MCP, shared stores and Telegram surface from %s', model => {
    const ctx = context(model);
    const { factory } = build(ctx);
    const fallback = factory(model === 'gpt-4o' ? 'claude-haiku-5-5' : 'gpt-4o');
    // Both provider implementations expose these same options (Anthropic copies
    // the keys to the instance, OpenAI retains its providerOpts object).
    const internals = fallback as unknown as Record<string, unknown> & { providerOpts?: Record<string, unknown> };
    const opts = internals.providerOpts ?? internals;
    expect(opts['stateStore']).toBe(ctx.stateStore);
    expect(opts['workspaceStore']).toBe(ctx.workspaceStore);
    expect(opts['mcpManager']).toBe(ctx.mcpManager);
    expect(opts['subagentExecutor']).toBeDefined();
    expect(opts['skillExecutor']).toBeDefined();
    expect(opts['composeExecutor']).toBeDefined();
  });

  it('omits the fallback factory when the provider is pinned', () => {
    vi.stubEnv('AFK_PROVIDER', 'anthropic');
    expect(build(context('claude-sonnet-4-6')).factory).toBeUndefined();
  });

  it.each(['claude-sonnet-4-6', 'gpt-4o'])('preserves cwd roots alongside persisted fallback grants from %s', model => {
    const ctx = context(model);
    ctx.mcpManager = undefined;
    ctx.stateStore = undefined;
    ctx.workspaceStore = undefined;
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const provider = build(ctx).factory(model === 'gpt-4o' ? 'claude-haiku-5-5' : 'gpt-4o');
    const persistedRead = path.join(os.tmpdir(), 'persisted-read');
    const persistedWrite = path.join(os.tmpdir(), 'persisted-write');
    const workspace = path.join(os.tmpdir(), 'workspace');
    mocks.seed.mockImplementation((grants: AnthropicDirectProvider) => {
      grants.addReadRoot(persistedRead, 'tool');
      grants.addWriteRoot(persistedWrite, 'tool');
    });
    const query = provider.query({
      config: { model, cwd: workspace }, prompt: (async function* () {})(),
    });
    expect(provider.getGrants()).toMatchObject({
      readRoots: expect.arrayContaining([workspace, persistedRead, persistedWrite]),
      writeRoots: expect.arrayContaining([workspace, persistedWrite]),
    });
    void query.close();
  });

  it.each(['claude-sonnet-4-6', 'gpt-4o'])('seeds persisted grants only after query initialized cwd roots from %s', model => {
    const ctx = context(model);
    const destination = model === 'gpt-4o' ? AnthropicDirectProvider : OpenAICompatibleProvider;
    const order: string[] = [];
    const inner = {};
    vi.spyOn(destination.prototype, 'query').mockImplementation(() => { order.push('query'); return inner as never; });
    mocks.seed.mockImplementation(() => { order.push('seed'); });
    const provider = build(ctx).factory(model === 'gpt-4o' ? 'claude-haiku-5-5' : 'gpt-4o');
    expect(mocks.seed).not.toHaveBeenCalled();
    expect(provider.query({ config: { model, cwd: path.join(os.tmpdir(), 'workspace') }, prompt: (async function* () {})() })).toBe(inner);
    expect(order).toEqual(['query', 'seed']);
  });
});
