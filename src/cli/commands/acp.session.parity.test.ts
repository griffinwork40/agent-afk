import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  config: vi.fn(), provider: vi.fn(), wire: vi.fn(), hooks: vi.fn(),
  memoryClose: vi.fn(), stateClose: vi.fn(), traceClose: vi.fn(), disconnect: vi.fn(),
  sessionClose: vi.fn(), providerClose: vi.fn(), plugins: vi.fn(), drain: vi.fn(), dispose: vi.fn(),
  trace: { write: vi.fn(), getTracePath: () => 'trace', close: vi.fn() },
  manager: { getMcpToolWireNames: () => ['mcp__gui__lookup'], disconnectAll: vi.fn() },
}));
vi.mock('./acp.server.js', () => ({ runAcpServer: vi.fn() }));
vi.mock('../../agent/providers/anthropic-direct/index.js', () => ({ AnthropicDirectProvider: class {} }));
vi.mock('../../agent/tools/top-level-allowlist.js', () => ({ topLevelSurfaceAllowedTools: () => [] }));
vi.mock('../../agent/session.js', () => ({ AgentSession: class {
  constructor(config: unknown, writer: unknown) { f.config(config, writer); }
  close = f.sessionClose;
} }));
vi.mock('../../agent/session/wire-executors.js', () => ({ wireExecutors: f.wire }));
vi.mock('../../agent/session/deferred-parent-proxy.js', () => ({
  makeDeferredParentProxy: () => ({ proxy: {}, bind: vi.fn() }),
}));
vi.mock('../../agent/session/manager-shutdown-config.js', () => ({
  managerShutdownConfig: () => ({ drainSubagents: f.drain }),
}));
vi.mock('../../agent/tools/skill-bridge.js', () => ({ ensurePluginEntrypointsLoaded: f.plugins }));
vi.mock('../../agent/default-hook-registry.js', () => ({ createDefaultHookRegistry: () => ({ registry: {} }) }));
vi.mock('../../agent/hooks/config-loader.js', () => ({ loadHooksConfig: f.hooks }));
vi.mock('../../agent/memory/index.js', () => ({
  MemoryStore: class { close = f.memoryClose; },
  injectHotMemory: (c: unknown) => c, injectEpisodeRecall: (c: unknown) => c,
}));
vi.mock('../../agent/state/state-store.js', () => ({ StateStore: class { close = f.stateClose; } }));
vi.mock('../../paths.js', () => ({ getStateDatabasePath: () => ':memory:' }));
vi.mock('../../agent/trace/factory.js', () => ({
  createDefaultTraceWriter: () => ({ writer: f.trace, sessionLabel: 'trace-id', tracePath: 'trace' }),
}));
vi.mock('../system-prompt.js', () => ({
  resolveBaseSystemPrompt: vi.fn(() => ({ prompt: 'framework + operator', overlay: 'operator', source: 'framework+AFK.md' })),
}));
vi.mock('../config.js', () => ({ loadConfig: () => ({ autoRouting: { interactive: true } }) }));
vi.mock('../provider-parser.js', () => ({ parseProvider: f.provider }));
vi.mock('../shared-helpers.js', () => ({
  getApiKeyForModel: () => 'key', getModel: () => 'sonnet', getDefaultSubagentModel: () => 'sonnet',
}));
vi.mock('../../agent/mcp/index.js', () => ({
  loadMcpConfig: vi.fn(() => ({
    mcpServers: { disk: { command: 'disk' } }, sources: [], warnings: [],
    serverLayers: { disk: 'user-global' }, userAllowSecretEnv: {},
  })),
}));
vi.mock('../../agent/mcp/connect-traced.js', () => ({ connectMcpTraced: vi.fn(async () => f.manager) }));
vi.mock('../../config/import-sources.js', () => ({
  loadImportFromConfig: () => [], resolveImportedRoots: () => ({ mcpConfigs: [] }),
}));

import { buildAcpSession, closeAcpSession } from './acp.session.js';
import { assembleSystemPrompt } from '../../agent/routing-directive.js';
import { connectMcpTraced } from '../../agent/mcp/connect-traced.js';
import { loadMcpConfig } from '../../agent/mcp/index.js';
import { resolveBaseSystemPrompt } from '../system-prompt.js';
import { registerAcpCommand } from './acp.js';
import { Command } from 'commander';

beforeEach(() => {
  vi.clearAllMocks();
  f.trace.close.mockResolvedValue(undefined);
  f.manager.disconnectAll.mockResolvedValue(undefined);
  f.sessionClose.mockResolvedValue(undefined);
  f.plugins.mockResolvedValue(undefined);
  f.provider.mockReturnValue({ name: 'test-provider', close: f.providerClose });
  f.wire.mockReturnValue({
    rootManager: {}, subagentExecutor: {}, skillExecutor: {}, composeExecutor: {},
    continuationRegistry: { dispose: f.dispose },
  });
});

describe('ACP bootstrap parity', () => {
  it('threads trace, interactive prompt, overlay and cwd to root and children', async () => {
    const handle = await buildAcpSession({ model: 'gpt-4.1', maxTurns: 0, cwd: '/workspace' });
    expect(f.wire).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace', nestedCwd: '/workspace', traceWriter: f.trace, skillTraceWriter: f.trace,
      systemPrompt: 'framework + operator', operatorOverlay: 'operator',
    }));
    expect(resolveBaseSystemPrompt).toHaveBeenCalledWith('/workspace');
    expect(f.config).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace', traceWriter: f.trace, systemPromptSource: 'framework+AFK.md',
      systemPrompt: assembleSystemPrompt('framework + operator', true, 'repl'),
    }), f.trace);
    expect(f.hooks).toHaveBeenCalledWith({ cwd: '/workspace' });
    await closeAcpSession(handle);
  });

  it('appends client systemPrompt after the resolved operator prompt', async () => {
    const clientPrompt = '# Project context\nThis repo uses pnpm.';
    const handle = await buildAcpSession({
      model: 'gpt-4.1', maxTurns: 0, cwd: '/workspace', systemPrompt: clientPrompt,
    });
    const resolvedBase = assembleSystemPrompt('framework + operator', true, 'repl');
    expect(f.config).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: `${resolvedBase}\n\n${clientPrompt}`,
    }), f.trace);
    await closeAcpSession(handle);
  });

  it('uses client systemPrompt alone when no operator overlay is configured', async () => {
    const { resolveBaseSystemPrompt } = await import('../system-prompt.js');
    vi.mocked(resolveBaseSystemPrompt).mockReturnValueOnce({ prompt: undefined, source: 'none' });
    const clientPrompt = 'Only client context.';
    const handle = await buildAcpSession({
      model: 'gpt-4.1', maxTurns: 0, cwd: '/workspace', systemPrompt: clientPrompt,
    });
    // assembleSystemPrompt(undefined, ...) returns undefined — the client prompt stands alone
    expect(f.config).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: clientPrompt,
    }), f.trace);
    await closeAcpSession(handle);
  });

  it('appends +client to systemPromptSource when a client prompt is present', async () => {
    const clientPrompt = '# Project context\nThis repo uses pnpm.';
    const handle = await buildAcpSession({
      model: 'gpt-4.1', maxTurns: 0, cwd: '/workspace', systemPrompt: clientPrompt,
    });
    expect(f.config).toHaveBeenCalledWith(expect.objectContaining({
      systemPromptSource: 'framework+AFK.md+client',
    }), f.trace);
    await closeAcpSession(handle);
  });

  it('does not append +client to systemPromptSource when no client prompt is provided', async () => {
    const handle = await buildAcpSession({ model: 'gpt-4.1', maxTurns: 0, cwd: '/workspace' });
    expect(f.config).toHaveBeenCalledWith(expect.objectContaining({
      systemPromptSource: 'framework+AFK.md',
    }), f.trace);
    await closeAcpSession(handle);
  });

  it('ignores a whitespace-only client systemPrompt', async () => {
    const handle = await buildAcpSession({
      model: 'gpt-4.1', maxTurns: 0, cwd: '/workspace', systemPrompt: '   ',
    });
    const resolvedBase = assembleSystemPrompt('framework + operator', true, 'repl');
    expect(f.config).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: resolvedBase,
    }), f.trace);
    await closeAcpSession(handle);
  });

  it('merges configured and client MCP before provider construction and passes approval', async () => {
    const canUseTool = vi.fn();
    const gui = { type: 'stdio' as const, command: 'gui-server' };
    const handle = await buildAcpSession({ model: 'gpt-4.1', maxTurns: 0, cwd: '/workspace',
      mcpServers: { gui }, canUseTool });
    expect(loadMcpConfig).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace' }));
    expect(connectMcpTraced).toHaveBeenCalledWith(expect.objectContaining({
      mcpServers: { disk: { command: 'disk' }, gui },
      serverLayers: { disk: 'user-global', gui: 'cli' },
    }), f.trace);
    expect(f.provider).toHaveBeenCalledWith(undefined, expect.objectContaining({
      model: 'gpt-4.1', canUseTool, mcpManager: f.manager,
    }));
    // Do not connect a second, invisible manager via AgentConfig.mcpServers.
    expect(f.config.mock.calls[0]?.[0]).not.toHaveProperty('mcpServers');
    await closeAcpSession(handle);
    expect(f.manager.disconnectAll).toHaveBeenCalledOnce();
    expect(f.trace.close).toHaveBeenCalledOnce();
  });

  it('releases all resources even when session close fails', async () => {
    const handle = await buildAcpSession({ model: 'sonnet', maxTurns: 0 });
    f.sessionClose.mockRejectedValueOnce(new Error('close failed'));
    await expect(closeAcpSession(handle)).rejects.toThrow('close failed');
    expect(f.providerClose).toHaveBeenCalledOnce();
    expect(f.manager.disconnectAll).toHaveBeenCalledOnce();
    expect(f.memoryClose).toHaveBeenCalledOnce();
    expect(f.stateClose).toHaveBeenCalledOnce();
    expect(f.trace.close).toHaveBeenCalledOnce();
  });

  it('drains executors and releases acquired resources on partial construction failure', async () => {
    f.plugins.mockRejectedValueOnce(new Error('plugins failed'));
    await expect(buildAcpSession({ model: 'sonnet', maxTurns: 0 })).rejects.toThrow('plugins failed');
    expect(f.drain).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.manager.disconnectAll).toHaveBeenCalledOnce();
    expect(f.memoryClose).toHaveBeenCalledOnce();
    expect(f.stateClose).toHaveBeenCalledOnce();
    expect(f.trace.close).toHaveBeenCalledOnce();
  });

  it('releases stores and trace if MCP connection fails before executor construction', async () => {
    vi.mocked(connectMcpTraced).mockRejectedValueOnce(new Error('MCP failed'));
    await expect(buildAcpSession({ model: 'sonnet', maxTurns: 0 })).rejects.toThrow('MCP failed');
    expect(f.wire).not.toHaveBeenCalled();
    expect(f.memoryClose).toHaveBeenCalledOnce();
    expect(f.stateClose).toHaveBeenCalledOnce();
    expect(f.trace.close).toHaveBeenCalledOnce();
  });

  it('defaults to uncapped conversations and explains what the cap counts', () => {
    const program = new Command();
    registerAcpCommand(program);
    const option = program.commands[0]?.options.find((o) => o.long === '--max-turns');
    expect(option?.defaultValue).toBe('0');
    expect(option?.description).toMatch(/messages.*session.*0.*uncapped/i);
  });
});
