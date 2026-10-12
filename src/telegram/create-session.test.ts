import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../agent/session.js';
import type { MemoryStore } from '../agent/memory/index.js';
import type { StateStore } from '../agent/state/state-store.js';
import type { TelegramSessionBuildContext } from './session-context.js';

const mocks = vi.hoisted(() => ({ build: vi.fn(), disconnect: vi.fn(), workspaceClose: vi.fn() }));
vi.mock('../agent/workspace/workspace-store.js', () => ({
  WorkspaceStore: class { close = mocks.workspaceClose; },
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
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('AFK_WORKSPACE_DISABLED', '0'); });
afterEach(() => { vi.unstubAllEnvs(); });

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
});
