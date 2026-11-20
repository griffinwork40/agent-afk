import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webProviderWiring } from './session-owner.provider.js';
import { FastModeController } from '../agent/fast-mode.js';
import { OpenAICompatibleProvider } from '../agent/providers/index.js';
import type { WiredExecutors } from '../agent/session/wire-executors.js';
import type { McpManager } from '../agent/mcp/index.js';
import type { WorkspaceStore } from '../agent/workspace/index.js';

const mocks = vi.hoisted(() => ({ seed: vi.fn() }));
vi.mock('../agent/permissions-store.js', () => ({ seedPersistedGrants: mocks.seed }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

function options() {
  return {
    model: 'claude-sonnet-4-6',
    executors: { subagentExecutor: {}, skillExecutor: {}, composeExecutor: {} } as WiredExecutors,
    mcpManager: { getMcpToolWireNames: () => ['mcp__test__read'] } as unknown as McpManager,
    workspaceStore: {} as WorkspaceStore,
    fastModeController: new FastModeController(),
  };
}

describe('web fallback provider wiring', () => {
  it('keeps the primary, memoizes providers per family, and scopes the cache per session', () => {
    const wiring = webProviderWiring(options());
    expect(wiring.providerFactory?.('claude-haiku-5-5')).toBe(wiring.provider);
    const fallback = wiring.providerFactory?.('gpt-4o');
    expect(fallback).toBeInstanceOf(OpenAICompatibleProvider);
    expect(wiring.providerFactory?.('gpt-4o')).toBe(fallback);
    expect(webProviderWiring(options()).providerFactory?.('gpt-4o')).not.toBe(fallback);
  });

  it('retains web surface, executors, workspace, MCP, tool allowlist and fast controller', () => {
    const opts = options();
    const provider = webProviderWiring(opts).providerFactory?.('gpt-4o');
    const internals = provider as unknown as { providerOpts: Record<string, unknown> };
    expect(internals.providerOpts).toMatchObject({
      surface: 'web', subagentExecutor: opts.executors.subagentExecutor,
      skillExecutor: opts.executors.skillExecutor, composeExecutor: opts.executors.composeExecutor,
      workspaceStore: opts.workspaceStore, mcpManager: opts.mcpManager,
      fastModeController: opts.fastModeController,
      permissions: { allowedTools: expect.arrayContaining(['mcp__test__read']) },
    });
  });

  it('seeds persisted grants after the fallback query initializes cwd roots', () => {
    const order: string[] = [];
    const inner = {};
    vi.spyOn(OpenAICompatibleProvider.prototype, 'query').mockImplementation(() => { order.push('query'); return inner as never; });
    mocks.seed.mockImplementation(() => { order.push('seed'); });
    const provider = webProviderWiring(options()).providerFactory?.('gpt-4o');
    expect(mocks.seed).not.toHaveBeenCalled();
    expect(provider?.query({ config: { model: 'gpt-4o', cwd: path.join(os.tmpdir(), 'workspace') }, prompt: (async function* () {})() })).toBe(inner);
    expect(order).toEqual(['query', 'seed']);
    expect(mocks.seed).toHaveBeenCalledWith(provider);
  });

  it('omits the fallback factory when the operator pinned a provider', () => {
    vi.stubEnv('AFK_PROVIDER', 'anthropic');
    const wiring = webProviderWiring(options());
    expect(wiring.provider.name).toBe('anthropic-direct');
    expect(wiring.providerFactory).toBeUndefined();
  });
});
