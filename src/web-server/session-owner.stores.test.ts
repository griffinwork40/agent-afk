import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{ close: () => Promise<void>; sessionId?: string }>,
  close: vi.fn(), init: vi.fn(), memoryClose: vi.fn(), workspaceClose: vi.fn(),
}));
vi.mock('../agent/session/agent-session.js', () => ({
  AgentSession: class {
    close = mocks.close;
    sessionId: string | undefined;
    constructor() { mocks.sessions.push(this); }
    getSessionMetadata() { return {}; }
    wireStopHook() {}
    waitForInitialization = mocks.init;
  },
}));
vi.mock('../cli/shared-helpers.js', () => ({
  getApiKeyForModel: () => undefined,
  resolveBaseSystemPrompt: () => ({}),
}));
vi.mock('../agent/default-hook-registry.js', () => ({ createDefaultHookRegistry: () => ({ registry: {} }) }));
vi.mock('../agent/permissions-store.js', () => ({ seedPersistedGrants: () => {} }));
vi.mock('../cli/session-autosave.js', () => ({ createSessionAutosaver: () => ({}) }));
vi.mock('./session-owner.wiring.js', () => ({ wireWebSession: async () => ({
  provider: {}, __bindSession: () => {},
  memoryStore: { close: mocks.memoryClose }, workspaceStore: { close: mocks.workspaceClose },
}) }));
import { SessionOwner } from './session-owner.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.length = 0;
  mocks.close.mockImplementation(async () => { expect(mocks.memoryClose).not.toHaveBeenCalled(); });
  mocks.init.mockResolvedValue({ sessionId: 'web-session' });
});
describe('Web session store ownership', () => {
  it('releases both stores after closeAll and makes repeated/direct close safe', async () => {
    const owner = new SessionOwner({ model: 'sonnet' });
    await owner.create();
    await Promise.all([owner.closeAll(), mocks.sessions[0]!.close()]);
    await owner.closeAll();
    await mocks.sessions[0]!.close();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.memoryClose).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClose).toHaveBeenCalledTimes(1);
  });

  it('releases both stores even when session teardown rejects', async () => {
    mocks.close.mockRejectedValue(new Error('close failed'));
    const owner = new SessionOwner({ model: 'sonnet' });
    await owner.create();
    await owner.closeAll();
    expect(mocks.memoryClose).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClose).toHaveBeenCalledTimes(1);
  });

  it.each(['missing-id', 'init-rejection'])('releases stores when initialization fails: %s', async (failure) => {
    if (failure === 'missing-id') mocks.init.mockResolvedValue({});
    else mocks.init.mockRejectedValue(new Error('initialization failed'));
    const owner = new SessionOwner({ model: 'sonnet' });
    await expect(owner.create()).rejects.toThrow();
    expect(owner.owned.size).toBe(0);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.memoryClose).toHaveBeenCalledTimes(1);
    expect(mocks.workspaceClose).toHaveBeenCalledTimes(1);
  });
});
