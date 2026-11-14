import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../agent/session.js';
import type { MemoryStore } from '../agent/memory/index.js';
import type { StateStore } from '../agent/state/state-store.js';
import type { TelegramSessionBuildContext } from './session-context.js';

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  disconnect: vi.fn(),
  workspaceClose: vi.fn(),
  workspaceThrow: false,
}));
vi.mock('../agent/workspace/workspace-store.js', () => ({
  WorkspaceStore: class {
    constructor() { if (mocks.workspaceThrow) throw new Error('sqlite open failed'); }
    close = mocks.workspaceClose;
  },
}));
vi.mock('./construct-session.js', () => ({ createTelegramTraceWriter: () => null }));
vi.mock('./mcp-session.js', () => ({
  loadTelegramMcpManager: async () => ({ disconnectAll: mocks.disconnect }),
}));
vi.mock('./session-anthropic.js', () => ({ buildAnthropicTelegramSession: mocks.build }));
vi.mock('./session-openai.js', () => ({ buildOpenAiTelegramSession: mocks.build }));
vi.mock('./session-xai.js', () => ({ buildXaiTelegramSession: mocks.build }));
import { createTelegramSessionFactory } from './create-session.js';

const memoryClose = vi.fn();
const stateClose = vi.fn();
const memoryStore = { close: memoryClose } as unknown as MemoryStore;
const stateStore = { close: stateClose } as unknown as StateStore;
function factory() {
  return createTelegramSessionFactory({
    config: {}, frameworkBase: undefined, telegramCwd: undefined,
    memoryStore, stateStore, log: () => {},
  });
}
beforeEach(() => { vi.clearAllMocks(); mocks.workspaceThrow = false; vi.stubEnv('AFK_WORKSPACE_DISABLED', '0'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('Telegram unattended limits', () => {
  it.each(['sonnet', 'gpt-4o', 'grok-4'])('uses finite defaults for %s', async (model) => {
    vi.stubEnv('AFK_MAX_BUDGET_USD', '');
    vi.stubEnv('AFK_MAX_TOOL_USE_ITERATIONS', '');
    mocks.build.mockResolvedValue({ close: async () => {} });
    await factory()({ model });
    expect(mocks.build.mock.calls[0]?.[0]).toMatchObject({ maxBudgetUsd: 5, maxToolUseIterations: 100 });
  });

  it('preserves explicit config over environment, including unlimited rounds', async () => {
    vi.stubEnv('AFK_MAX_BUDGET_USD', '3');
    vi.stubEnv('AFK_MAX_TOOL_USE_ITERATIONS', '20');
    mocks.build.mockResolvedValue({ close: async () => {} });
    await factory()({ model: 'sonnet', maxBudgetUsd: 8, maxToolUseIterations: 0 });
    expect(mocks.build.mock.calls[0]?.[0]).toMatchObject({ maxBudgetUsd: 8, maxToolUseIterations: 0 });
  });

  it('honors environment limits', async () => {
    vi.stubEnv('AFK_MAX_BUDGET_USD', '2');
    vi.stubEnv('AFK_MAX_TOOL_USE_ITERATIONS', '15');
    mocks.build.mockResolvedValue({ close: async () => {} });
    await factory()({ model: 'sonnet' });
    expect(mocks.build.mock.calls[0]?.[0]).toMatchObject({ maxBudgetUsd: 2, maxToolUseIterations: 15 });
  });
});

describe('Telegram store ownership', () => {
  it.each(['sonnet', 'gpt-4o', 'grok-4'])('forwards shared state and closes only owned workspace for %s', async (model) => {
    const close = vi.fn(async () => { expect(mocks.workspaceClose).not.toHaveBeenCalled(); });
    mocks.build.mockImplementation(async (ctx: TelegramSessionBuildContext) => {
      expect(ctx.stateStore).toBe(stateStore);
      const session = { close } as unknown as AgentSession;
      ctx.reportSession(session);
      return session;
    });
    const session = await factory()({ model });
    await Promise.all([session.close(), session.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClose).toHaveBeenCalledTimes(1);
    expect(memoryClose).not.toHaveBeenCalled();
    expect(stateClose).not.toHaveBeenCalled();
  });

  it('closes workspace even when session close rejects', async () => {
    mocks.build.mockImplementation(async (ctx: TelegramSessionBuildContext) => {
      const session = { close: async () => { throw new Error('close failed'); } } as unknown as AgentSession;
      ctx.reportSession(session);
      return session;
    });
    const session = await factory()({ model: 'sonnet' });
    await expect(session.close()).rejects.toThrow('close failed');
    await expect(session.close()).rejects.toThrow('close failed');
    expect(mocks.workspaceClose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('releases workspace on builder failure (session constructed: %s)', async (constructed) => {
    const close = vi.fn(async () => {});
    mocks.build.mockImplementation(async (ctx: TelegramSessionBuildContext) => {
      if (constructed) ctx.reportSession({ close } as unknown as AgentSession);
      throw new Error('build failed');
    });
    await expect(factory()({ model: 'sonnet' })).rejects.toThrow('build failed');
    expect(mocks.workspaceClose).toHaveBeenCalledTimes(1);
    expect(constructed ? close : mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(stateClose).not.toHaveBeenCalled();
  });

  it('does not create or close workspace when disabled', async () => {
    vi.stubEnv('AFK_WORKSPACE_DISABLED', '1');
    mocks.build.mockImplementation(async (ctx: TelegramSessionBuildContext) => {
      expect(ctx.workspaceStore).toBeUndefined();
      const session = { close: async () => {} } as unknown as AgentSession;
      ctx.reportSession(session);
      return session;
    });
    await (await factory()({ model: 'sonnet' })).close();
    expect(mocks.workspaceClose).not.toHaveBeenCalled();
  });

  it('calls disconnectAll when WorkspaceStore constructor throws (item 1 — #3588)', async () => {
    // WorkspaceStore open throws after MCP has connected; MCP must not leak.
    mocks.workspaceThrow = true;
    await expect(factory()({ model: 'sonnet' })).rejects.toThrow('sqlite open failed');
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClose).not.toHaveBeenCalled();
  });

  it('logs session-close failures during recovery instead of discarding them (item 2 — #3588)', async () => {
    const logged: string[] = [];
    function factoryWithLog() {
      return createTelegramSessionFactory({
        config: {}, frameworkBase: undefined, telegramCwd: undefined,
        memoryStore, stateStore, log: (msg: string) => { logged.push(msg); },
      });
    }
    mocks.build.mockImplementation(async (ctx: TelegramSessionBuildContext) => {
      const session = { close: async () => { throw new Error('close boom'); } } as unknown as AgentSession;
      ctx.reportSession(session);
      // Builder throws after reportSession so the catch path runs close()
      throw new Error('build failed');
    });
    await expect(factoryWithLog()({ model: 'sonnet' })).rejects.toThrow('build failed');
    expect(logged.some(m => m.includes('close boom'))).toBe(true);
  });
});
