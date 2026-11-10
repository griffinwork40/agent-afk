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

// ---------------------------------------------------------------------------
// Spy on injectEpisodeRecall — must be set up before importing acp.session
// ---------------------------------------------------------------------------

const mockInjectEpisodeRecall = vi.fn((config: unknown) => config);
const mockInjectHotMemory = vi.fn((config: unknown) => config);

vi.mock('../../agent/memory/index.js', () => {
  class MemoryStore {
    close = vi.fn();
  }
  return {
    MemoryStore,
    injectHotMemory: (...args: unknown[]) => mockInjectHotMemory(...args),
    injectEpisodeRecall: (...args: unknown[]) => mockInjectEpisodeRecall(...args),
  };
});

// ---------------------------------------------------------------------------
// Import SUT after all mocks are registered
// ---------------------------------------------------------------------------

import { buildAcpSession, closeAcpSession } from './acp.session.js';
import { MemoryStore } from '../../agent/memory/index.js';

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
    await buildAcpSession({ model: 'sonnet', maxTurns: 10 });

    // The 4th positional argument must be a MemoryStore instance (finding 1 fix).
    const [, , , storeArg] = mockInjectEpisodeRecall.mock.calls[0] as unknown[];
    expect(storeArg).toBeInstanceOf(MemoryStore);
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
});
