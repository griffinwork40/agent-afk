/**
 * Unit tests for acp.session.ts — injection chain wiring.
 *
 * These tests verify that the session-building helpers wire the memory
 * injection functions correctly without making real Anthropic API calls.
 *
 * @module cli/commands/acp.session.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock heavy dependencies before importing acp.session
// ---------------------------------------------------------------------------

vi.mock('../../agent/session.js', () => {
  class AgentSession {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(_config: unknown, _parent: unknown) {}
  }
  return { AgentSession };
});

vi.mock('../../agent/session/deferred-parent-proxy.js', () => ({
  makeDeferredParentProxy: vi.fn(() => ({
    proxy: {},
    bind: vi.fn(),
  })),
}));

vi.mock('../../agent/session/manager-shutdown-config.js', () => ({
  managerShutdownConfig: vi.fn(() => ({})),
}));

vi.mock('../../agent/session/wire-executors.js', () => ({
  wireExecutors: vi.fn(() => ({
    rootManager: {},
    subagentExecutor: {},
    skillExecutor: {},
    composeExecutor: {},
  })),
}));

vi.mock('../../agent/tools/skill-bridge.js', () => ({
  ensurePluginEntrypointsLoaded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../agent/providers/anthropic-direct/index.js', () => {
  class AnthropicDirectProvider {
    constructor(_opts: unknown) {}
  }
  return { AnthropicDirectProvider };
});

vi.mock('../../agent/default-hook-registry.js', () => ({
  createDefaultHookRegistry: vi.fn(() => ({ registry: {} })),
}));

vi.mock('../../agent/hooks/config-loader.js', () => ({
  loadHooksConfig: vi.fn(() => ({})),
}));

vi.mock('../../agent/state/state-store.js', () => {
  class StateStore {
    close = vi.fn();
    constructor(_path: string) {}
  }
  return { StateStore };
});

vi.mock('../../paths.js', () => ({
  getStateDatabasePath: vi.fn(() => ':memory:'),
}));

vi.mock('../shared-helpers.js', () => ({
  getApiKeyForModel: vi.fn(() => 'test-key'),
  getModel: vi.fn(() => 'sonnet'),
  getDefaultSubagentModel: vi.fn(() => 'sonnet'),
}));

vi.mock('../../agent/tools/top-level-allowlist.js', () => ({
  topLevelSurfaceAllowedTools: vi.fn(() => []),
}));

vi.mock('./acp.session.provider.js', () => ({ createAcpProvider: vi.fn(() => ({})) }));
vi.mock('./acp.session.mcp.js', () => ({ connectAcpMcp: vi.fn(async () => undefined) }));
vi.mock('./acp.session.prompt.js', () => ({ resolveAcpPrompt: vi.fn(() => ({ systemPromptSource: 'none' })) }));
vi.mock('../../agent/trace/factory.js', () => ({ createDefaultTraceWriter: vi.fn(() => null) }));

// ---------------------------------------------------------------------------
// Spy on injectEpisodeRecall — must be set up before importing acp.session
// ---------------------------------------------------------------------------

const mockInjectEpisodeRecall = vi.fn((...args: unknown[]) => args[0]);
const mockInjectHotMemory = vi.fn((...args: unknown[]) => args[0]);

vi.mock('../../agent/memory/index.js', () => {
  class MemoryStore {
    close = vi.fn();
  }
  return {
    MemoryStore,
    injectHotMemory: (config: unknown) => mockInjectHotMemory(config),
    injectEpisodeRecall: (config: unknown, memoryDir?: unknown, cwd?: unknown, store?: unknown, opts?: unknown) =>
      mockInjectEpisodeRecall(config, memoryDir, cwd, store, opts),
  };
});

// ---------------------------------------------------------------------------
// Import SUT after all mocks are registered
// ---------------------------------------------------------------------------

import { buildAcpSession, closeAcpSession } from './acp.session.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default pass-through behaviour
  mockInjectHotMemory.mockImplementation((config: unknown) => config);
  mockInjectEpisodeRecall.mockImplementation((config: unknown) => config);
});

describe('buildAcpSession — injection chain', () => {
  it('calls injectEpisodeRecall during session construction', async () => {
    await buildAcpSession({ model: 'sonnet', maxTurns: 10 });
    expect(mockInjectEpisodeRecall).toHaveBeenCalledOnce();
  });

  it('passes the session-scoped MemoryStore instance as the 4th arg to injectEpisodeRecall', async () => {
    const handle = await buildAcpSession({ model: 'sonnet', maxTurns: 10 });

    // The 4th positional argument must be the exact same MemoryStore instance
    // returned by the handle — reference equality, not just type check.
    const [, , , storeArg] = mockInjectEpisodeRecall.mock.calls[0] as unknown[];
    expect(storeArg).toBe(handle.memoryStore);
  });

  it('calls injectHotMemory during session construction', async () => {
    await buildAcpSession({ model: 'sonnet', maxTurns: 10 });
    expect(mockInjectHotMemory).toHaveBeenCalledOnce();
  });

  it('wraps injectHotMemory output with injectEpisodeRecall', async () => {
    // Verify call ordering: injectHotMemory fires first, its result is passed
    // to injectEpisodeRecall (i.e. injectEpisodeRecall wraps injectHotMemory).
    const hotResult = { _tag: 'hot-memory-result' };
    mockInjectHotMemory.mockReturnValue(hotResult);

    await buildAcpSession({ model: 'sonnet', maxTurns: 10 });

    // injectEpisodeRecall's first arg should be what injectHotMemory returned.
    const [firstArg] = mockInjectEpisodeRecall.mock.calls[0] as unknown[];
    expect(firstArg).toBe(hotResult);
  });
});

describe('buildAcpSession — approvals (D8, D9)', () => {
  it('always runs bypassPermissions; the skip flag only controls the bridge', async () => {
    const { wireExecutors } = await import('../../agent/session/wire-executors.js');
    for (const skip of [false, true, undefined]) {
      mockInjectHotMemory.mockClear();
      await buildAcpSession({ model: 'sonnet', maxTurns: 10, ...(skip !== undefined ? { dangerouslySkipPermissions: skip } : {}) });
      const [config] = mockInjectHotMemory.mock.calls[0] as [{ permissionMode: string }];
      expect(config.permissionMode).toBe('bypassPermissions');
    }
    expect(vi.mocked(wireExecutors).mock.calls.every(([o]) => !('childCanUseTool' in o))).toBe(true);
  });

  it('passes the child approval factory to executor wiring', async () => {
    const { wireExecutors } = await import('../../agent/session/wire-executors.js');
    const childCanUseTool = vi.fn();
    await buildAcpSession({ model: 'sonnet', maxTurns: 10, childCanUseTool });
    expect(vi.mocked(wireExecutors).mock.calls.at(-1)?.[0]).toMatchObject({ childCanUseTool });
  });
});

describe('buildAcpSession — hook registry cwd (T1)', () => {
  it('hands the session cwd and id, not the process directory, to the hook registry', async () => {
    const { createDefaultHookRegistry } = await import('../../agent/default-hook-registry.js');
    const { loadHooksConfig } = await import('../../agent/hooks/config-loader.js');
    const sessionCwd = process.platform === 'win32' ? 'C:\\client\\project' : '/client/project';
    expect(sessionCwd).not.toBe(process.cwd());
    await buildAcpSession({ model: 'sonnet', maxTurns: 10, cwd: sessionCwd, sessionId: 'acp-1' });
    const call = vi.mocked(createDefaultHookRegistry).mock.calls.at(-1);
    expect(call?.[5]).toMatchObject({ cwd: sessionCwd, sessionId: 'acp-1' });
    expect(vi.mocked(loadHooksConfig)).toHaveBeenLastCalledWith({ cwd: sessionCwd });
  });
});

describe('closeAcpSession — double-drain invariant [C3]', () => {
  it('a double close calls the underlying drain exactly once', async () => {
    // closeAcpSession calls session.close() (which drains subagents) and then
    // resources.release() (which calls the same drainSubagents via a disposer).
    // onceAcpShutdown makes the drain idempotent, so the underlying function
    // must be invoked only once regardless of how many times the wrapper is called.
    const { onceAcpShutdown } = await import('./acp.session.resources.js');
    const underlying = vi.fn(async (_reason: string) => {});
    const drain = onceAcpShutdown(underlying);
    await drain('close');
    await drain('close');
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('a double release of AcpSessionResources calls each disposer exactly once', async () => {
    const { AcpSessionResources } = await import('./acp.session.resources.js');
    const resources = new AcpSessionResources();
    const disposer = vi.fn();
    resources.add(disposer);
    await resources.release();
    await resources.release();
    expect(disposer).toHaveBeenCalledTimes(1);
  });
});

describe('closeAcpSession', () => {
  it('closes the session and stores', async () => {
    const handle = await buildAcpSession({ model: 'sonnet', maxTurns: 10 });
    const sessionCloseSpy = vi.spyOn(handle.session, 'close').mockResolvedValue(undefined);
    const memoryCloseSpy = vi.spyOn(handle.memoryStore, 'close');
    const stateCloseSpy = vi.spyOn(handle.stateStore, 'close');

    await closeAcpSession(handle);

    expect(sessionCloseSpy).toHaveBeenCalledOnce();
    expect(memoryCloseSpy).toHaveBeenCalledOnce();
    expect(stateCloseSpy).toHaveBeenCalledOnce();
  });

  it('still closes stores when session.close() throws', async () => {
    // The finally block in closeAcpSession must close memoryStore and stateStore
    // even when session.close() rejects — resource-leak guard.
    const handle = await buildAcpSession({ model: 'sonnet', maxTurns: 10 });
    const sessionError = new Error('session close failed');
    vi.spyOn(handle.session, 'close').mockRejectedValue(sessionError);
    const memoryCloseSpy = vi.spyOn(handle.memoryStore, 'close');
    const stateCloseSpy = vi.spyOn(handle.stateStore, 'close');

    await expect(closeAcpSession(handle)).rejects.toThrow('session close failed');

    expect(memoryCloseSpy).toHaveBeenCalledOnce();
    expect(stateCloseSpy).toHaveBeenCalledOnce();
  });
});
