/**
 * Tests for Telegram session manager
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from './session-manager';
import type { IAgentSession, AgentConfig, SessionState } from '../agent/types';
import { findSession, listSessions, loadSession } from '../cli/session-store';
import { promises as fs, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { useUnsetAfkHome } from '../__test-utils__/unset-afk-home.js';

// Mock agent session
class MockAgentSession implements IAgentSession {
  state: SessionState = 'idle';
  closed = false;

  async sendMessage(content: string) {
    return {
      role: 'assistant' as const,
      content: `Echo: ${content}`,
      timestamp: new Date(),
    };
  }

  async *getOutputStream() {
    yield { type: 'done' as const };
  }

  abort(_reason: string): void { /* IAgentSession mock no-op */ }
  async close() {
    this.closed = true;
  }

  async reset() {
    // no-op stub for IAgentSession contract
  }
}

describe('SessionManager', () => {
  const testDataDir = './test-data/sessions';
  let manager: SessionManager;

  beforeEach(async () => {
    // Clean test data directory
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore if doesn't exist
    }

    manager = new SessionManager({
      dataDir: testDataDir,
      apiKey: 'test-key',
      defaultModel: 'sonnet',
      createSession: async (config: AgentConfig) => new MockAgentSession(),
    });
  });

  afterEach(async () => {
    await manager.closeAll();
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore errors
    }
  });

  describe('getSession', () => {
    test('should create new session for new chat', async () => {
      const session = await manager.getSession(12345);
      expect(session).toBeInstanceOf(MockAgentSession);
    });

    test('should return existing session for same chat', async () => {
      const session1 = await manager.getSession(12345);
      const session2 = await manager.getSession(12345);
      expect(session1).toBe(session2);
    });

    test('concurrent calls for the same chatId produce exactly one session (race guard)', async () => {
      let createCallCount = 0;

      const racingManager = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        createSession: async (_config: AgentConfig) => {
          createCallCount++;
          // Simulate async work so the second call can arrive before the first resolves.
          await new Promise((r) => setTimeout(r, 5));
          return new MockAgentSession();
        },
      });

      // Fire two concurrent getSession calls before either resolves.
      const [s1, s2] = await Promise.all([
        racingManager.getSession(99999),
        racingManager.getSession(99999),
      ]);

      expect(createCallCount).toBe(1);
      expect(s1).toBe(s2);
      await racingManager.closeAll();
    });

    test('inflight rejection: _touchActivity still fires for concurrent caller', async () => {
      // Arrange: createSession rejects on the first call.
      let callCount = 0;
      const rejectingManager = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        createSession: async (_config: AgentConfig) => {
          callCount++;
          // Simulate async work so the second concurrent call hits the inflight path.
          await new Promise((r) => setTimeout(r, 5));
          throw new Error('creation failed');
        },
      });

      // Two concurrent getSession calls — the second one awaits the inflight promise.
      const [r1, r2] = await Promise.allSettled([
        rejectingManager.getSession(11111),
        rejectingManager.getSession(11111),
      ]);

      // Both callers should reject (creation failed).
      expect(r1.status).toBe('rejected');
      expect(r2.status).toBe('rejected');

      // createSession must have been called exactly once — no duplicate spawn.
      expect(callCount).toBe(1);

      // _touchActivity is a no-op when sessionData has no entry yet, so the
      // observable assertion is that it did NOT throw (the finally ran cleanly).
      // Confirm by checking that a subsequent successful creation works correctly,
      // i.e. the manager is in a clean state (pendingSessions cleared).
      let successCallCount = 0;
      const succeedingManager = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        createSession: async (_config: AgentConfig) => {
          successCallCount++;
          await new Promise((r) => setTimeout(r, 5));
          return new MockAgentSession();
        },
      });

      // Seed sessionData so _touchActivity has an entry to update on the inflight path.
      await succeedingManager.switchModel(22222, 'sonnet');
      const before = Date.now();

      // Fire two concurrent calls; the first creates, the second awaits inflight.
      const [s1, s2] = await Promise.all([
        succeedingManager.getSession(22222),
        succeedingManager.getSession(22222),
      ]);
      expect(s1).toBe(s2);
      expect(successCallCount).toBe(1);

      // lastActivity must have been refreshed (>= before timestamp).
      // sessionData is now keyed by routeKey (string); a General route for
      // chatId 22222 keys as "22222" (byte-identical to the legacy chatId key).
      const lastActivity = Date.parse(
        (succeedingManager as unknown as { sessionData: Map<string, { lastActivity: string }> })
          .sessionData.get('22222')!.lastActivity
      );
      expect(lastActivity).toBeGreaterThanOrEqual(before);

      await succeedingManager.closeAll();
    });

    test('should create different sessions for different chats', async () => {
      const session1 = await manager.getSession(12345);
      const session2 = await manager.getSession(67890);
      expect(session1).not.toBe(session2);
    });

    test('should use default model for new sessions', async () => {
      await manager.getSession(12345);
      const model = manager.getModel(12345);
      expect(model).toBe('sonnet');
    });

    test('should thread thinking config to session config', async () => {
      const thinkingConfig = { type: 'enabled' as const, budgetTokens: 5000 };
      const capturedConfigs: AgentConfig[] = [];

      const managerWithThinking = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        thinking: thinkingConfig,
        createSession: async (config: AgentConfig) => {
          capturedConfigs.push(config);
          return new MockAgentSession();
        },
      });

      await managerWithThinking.getSession(12345);
      expect(capturedConfigs[0]).toHaveProperty('thinking', thinkingConfig);
      await managerWithThinking.closeAll();
    });

    test('should thread effort level to session config', async () => {
      const capturedConfigs: AgentConfig[] = [];

      const managerWithEffort = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        effort: 'high',
        createSession: async (config: AgentConfig) => {
          capturedConfigs.push(config);
          return new MockAgentSession();
        },
      });

      await managerWithEffort.getSession(12345);
      expect(capturedConfigs[0]).toHaveProperty('effort', 'high');
      await managerWithEffort.closeAll();
    });

    test('should not include thinking and effort when unset', async () => {
      const capturedConfigs: AgentConfig[] = [];

      const managerBasic = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        createSession: async (config: AgentConfig) => {
          capturedConfigs.push(config);
          return new MockAgentSession();
        },
      });

      await managerBasic.getSession(12345);
      expect('thinking' in capturedConfigs[0]).toBe(false);
      expect('effort' in capturedConfigs[0]).toBe(false);
      await managerBasic.closeAll();
    });
  });

  describe('resetSession', () => {
    test('should close and remove session', async () => {
      const session = await manager.getSession(12345) as MockAgentSession;
      await manager.resetSession(12345);
      expect(session.closed).toBe(true);
    });

    test('should create new session after reset', async () => {
      const session1 = await manager.getSession(12345);
      await manager.resetSession(12345);
      const session2 = await manager.getSession(12345);
      expect(session1).not.toBe(session2);
    });

    test('should preserve model setting after reset', async () => {
      await manager.switchModel(12345, 'opus');
      await manager.getSession(12345);
      await manager.resetSession(12345);
      const model = manager.getModel(12345);
      expect(model).toBe('opus');
    });
  });

  describe('switchModel', () => {
    test('should update model', async () => {
      await manager.switchModel(12345, 'opus');
      const model = manager.getModel(12345);
      expect(model).toBe('opus');
    });

    test('should close existing session', async () => {
      const session = await manager.getSession(12345) as MockAgentSession;
      await manager.switchModel(12345, 'opus');
      expect(session.closed).toBe(true);
    });

    test('should create new session with new model', async () => {
      await manager.getSession(12345);
      await manager.switchModel(12345, 'haiku');
      const newSession = await manager.getSession(12345);
      expect(newSession).toBeInstanceOf(MockAgentSession);
    });

    test('should work for models: opus, sonnet, haiku', async () => {
      await manager.switchModel(12345, 'opus');
      expect(manager.getModel(12345)).toBe('opus');

      await manager.switchModel(12345, 'sonnet');
      expect(manager.getModel(12345)).toBe('sonnet');

      await manager.switchModel(12345, 'haiku');
      expect(manager.getModel(12345)).toBe('haiku');
    });
  });

  describe('setCwd / getCwd', () => {
    test('getCwd returns undefined when no override and no botCwd', () => {
      expect(manager.getCwd(12345)).toBeUndefined();
    });

    test('getCwd falls back to botCwd when no per-session override', () => {
      const managerWithBotCwd = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        botCwd: '/tmp/bot-default',
        createSession: async () => new MockAgentSession(),
      });
      expect(managerWithBotCwd.getCwd(12345)).toBe('/tmp/bot-default');
    });

    test('setCwd stores per-chat cwd and getCwd returns it', async () => {
      await manager.setCwd(12345, '/tmp/chat-specific');
      expect(manager.getCwd(12345)).toBe('/tmp/chat-specific');
    });

    test('per-session cwd overrides botCwd', async () => {
      const managerWithBotCwd = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        botCwd: '/tmp/bot-default',
        createSession: async () => new MockAgentSession(),
      });
      await managerWithBotCwd.setCwd(12345, '/tmp/chat-specific');
      expect(managerWithBotCwd.getCwd(12345)).toBe('/tmp/chat-specific');
      // Other chats still get the bot default.
      expect(managerWithBotCwd.getCwd(67890)).toBe('/tmp/bot-default');
      await managerWithBotCwd.closeAll();
    });

    test('setCwd closes existing session so next getSession rebuilds', async () => {
      const session = (await manager.getSession(12345)) as MockAgentSession;
      await manager.setCwd(12345, '/tmp/new-cwd');
      expect(session.closed).toBe(true);
      const fresh = await manager.getSession(12345);
      expect(fresh).not.toBe(session);
    });

    test('setCwd before any session creates data entry with cwd', async () => {
      await manager.setCwd(12345, '/tmp/never-touched');
      expect(manager.getCwd(12345)).toBe('/tmp/never-touched');
      // model defaults still apply
      expect(manager.getModel(12345)).toBe('sonnet');
    });

    test('cwd is threaded into AgentConfig on session creation', async () => {
      const capturedConfigs: AgentConfig[] = [];
      const capturingManager = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        createSession: async (config: AgentConfig) => {
          capturedConfigs.push(config);
          return new MockAgentSession();
        },
      });
      await capturingManager.setCwd(12345, '/tmp/threaded');
      await capturingManager.getSession(12345);
      expect(capturedConfigs[0]?.cwd).toBe('/tmp/threaded');
      await capturingManager.closeAll();
    });

    test('botCwd is threaded into AgentConfig when no per-session override', async () => {
      const capturedConfigs: AgentConfig[] = [];
      const capturingManager = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        botCwd: '/tmp/bot-fallback',
        createSession: async (config: AgentConfig) => {
          capturedConfigs.push(config);
          return new MockAgentSession();
        },
      });
      await capturingManager.getSession(12345);
      expect(capturedConfigs[0]?.cwd).toBe('/tmp/bot-fallback');
      await capturingManager.closeAll();
    });

    test('no cwd key when neither override nor botCwd set', async () => {
      const capturedConfigs: AgentConfig[] = [];
      const capturingManager = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        createSession: async (config: AgentConfig) => {
          capturedConfigs.push(config);
          return new MockAgentSession();
        },
      });
      await capturingManager.getSession(12345);
      // Absence — must not silently set cwd to undefined/null.
      expect('cwd' in (capturedConfigs[0] ?? {})).toBe(false);
      await capturingManager.closeAll();
    });

    test('cwd persists across save + load', async () => {
      await manager.setCwd(12345, '/tmp/persisted');
      await manager.saveSessions();

      const reloaded = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        createSession: async () => new MockAgentSession(),
      });
      await reloaded.loadSessions();
      expect(reloaded.getCwd(12345)).toBe('/tmp/persisted');
      await reloaded.closeAll();
    });
  });

  describe('persistence', () => {
    test('should save sessions to disk', async () => {
      await manager.getSession(12345);
      await manager.saveSessions();

      const filePath = join(testDataDir, '12345.json');
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    test('should load sessions from disk', async () => {
      await manager.switchModel(12345, 'opus');
      await manager.saveSessions();

      // Create new manager
      const newManager = new SessionManager({
        dataDir: testDataDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        createSession: async () => new MockAgentSession(),
      });

      await newManager.loadSessions();
      const model = newManager.getModel(12345);
      expect(model).toBe('opus');

      await newManager.closeAll();
    });

    test('should handle missing data directory', async () => {
      const nonExistentDir = './test-data/non-existent';
      const newManager = new SessionManager({
        dataDir: nonExistentDir,
        apiKey: 'test-key',
        defaultModel: 'sonnet',
        createSession: async () => new MockAgentSession(),
      });

      await expect(newManager.loadSessions()).resolves.not.toThrow();
      await newManager.closeAll();
    });
  });

  describe('stats', () => {
    test('should track session count', async () => {
      expect(manager.getSessionCount()).toBe(0);
      await manager.getSession(12345);
      expect(manager.getSessionCount()).toBe(1);
      await manager.getSession(67890);
      expect(manager.getSessionCount()).toBe(2);
    });

    test('should track chat count', async () => {
      expect(manager.getChatCount()).toBe(0);
      await manager.switchModel(12345, 'opus'); // Creates data without session
      expect(manager.getChatCount()).toBe(1);
      await manager.getSession(67890);
      expect(manager.getChatCount()).toBe(2);
    });

    test('getBusySessionCount counts only non-idle, non-closed sessions', async () => {
      // Idle sessions do not count as busy.
      const s1 = (await manager.getSession(12345)) as MockAgentSession;
      const s2 = (await manager.getSession(67890)) as MockAgentSession;
      expect(manager.getSessionCount()).toBe(2);
      expect(manager.getBusySessionCount()).toBe(0);

      // A streaming session counts as busy; the idle one does not.
      s1.state = 'streaming';
      expect(manager.getBusySessionCount()).toBe(1);

      // Other mid-turn states count too.
      s2.state = 'processing';
      expect(manager.getBusySessionCount()).toBe(2);
      s2.state = 'compacting';
      expect(manager.getBusySessionCount()).toBe(2);

      // Returning to idle / closed drops them from the busy count.
      s1.state = 'idle';
      s2.state = 'closed';
      expect(manager.getBusySessionCount()).toBe(0);
    });
  });

  describe('closeAll', () => {
    test('should close all sessions', async () => {
      const session1 = await manager.getSession(12345) as MockAgentSession;
      const session2 = await manager.getSession(67890) as MockAgentSession;

      await manager.closeAll();

      expect(session1.closed).toBe(true);
      expect(session2.closed).toBe(true);
    });

    test('should save sessions before closing', async () => {
      await manager.getSession(12345);
      await manager.closeAll();

      const filePath = join(testDataDir, '12345.json');
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    test('should clear session map', async () => {
      await manager.getSession(12345);
      await manager.getSession(67890);
      expect(manager.getSessionCount()).toBe(2);

      await manager.closeAll();
      expect(manager.getSessionCount()).toBe(0);
    });
  });
});

describe('SessionManager — recordTelegramTurn (shared session store)', () => {
  // saveSession()/findSession() resolve the store via the unset-AFK_HOME
  // fallback ($HOME/.afk) — drop the global sentinel AFK_HOME per test;
  // HOME is redirected to a tmp dir in this describe's beforeEach.
  useUnsetAfkHome();

  // Mock carrying a readonly SDK sessionId so we can exercise both the
  // metadata-supplied and live-session-captured sessionId paths.
  class MockSessionWithId implements IAgentSession {
    state: SessionState = 'idle';
    constructor(readonly sessionId?: string) {}
    async sendMessage(content: string) {
      return { role: 'assistant' as const, content: `Echo: ${content}`, timestamp: new Date() };
    }
    async *getOutputStream() { yield { type: 'done' as const }; }
    abort(_reason: string): void { /* no-op */ }
    async close() { /* no-op */ }
    async reset() { /* no-op */ }
  }

  const testDataDir = './test-data/sessions-rec';
  let tmpHome: string;
  let originalHome: string | undefined;
  let manager: SessionManager;

  function makeManager(sessionId?: string): SessionManager {
    return new SessionManager({
      dataDir: testDataDir,
      apiKey: 'test-key',
      defaultModel: 'sonnet',
      createSession: async () => new MockSessionWithId(sessionId),
    });
  }

  beforeEach(() => {
    // Isolate HOME so saveSession() writes into a throwaway ~/.afk store.
    originalHome = process.env['HOME'];
    tmpHome = join(tmpdir(), `afk-tg-rec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env['HOME'] = tmpHome;
    manager = makeManager('sdk-live-default');
  });

  afterEach(async () => {
    await manager.closeAll().catch(() => {});
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    if (existsSync(testDataDir)) rmSync(testDataDir, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
  });

  test('records a Telegram turn as a resumable, named, telegram-tagged sidecar', () => {
    manager.recordTelegramTurn(111, 'Help me fix the resume bug', 'sure', { sessionId: 'sdk-tg-1' });

    const found = findSession('help-me-fix-the-resume-bug');
    expect(found?.data.sessionId).toBe('sdk-tg-1');
    expect(found?.data.source).toBe('telegram');
    expect(found?.data.telegramChatId).toBe(111);
    expect(found?.data.turns).toHaveLength(1);
    expect(found?.data.turns[0]!.user).toBe('Help me fix the resume bug');
    expect(found?.data.turns[0]!.assistant).toBe('sure');
  });

  test('accumulates multiple turns into ONE sidecar (no duplicates)', () => {
    manager.recordTelegramTurn(222, 'first message here', 'a', { sessionId: 'sdk-tg-2' });
    manager.recordTelegramTurn(222, 'second message', 'b', { sessionId: 'sdk-tg-2' });

    const entries = listSessions().filter((e) => e.sessionId === 'sdk-tg-2');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.totalTurns).toBe(2);
    // Name comes from the FIRST message and does not change on later turns.
    expect(entries[0]!.name).toBe('first-message-here');
  });

  test('captures the sessionId from the live session when metadata omits it', async () => {
    const m = makeManager('sdk-from-live');
    await m.getSession(333); // populate this.sessions with a session that has a sessionId
    m.recordTelegramTurn(333, 'do a thing', 'done'); // no metadata
    expect(findSession('do-a-thing')?.data.sessionId).toBe('sdk-from-live');
    await m.closeAll().catch(() => {});
  });

  test('does not persist when no sessionId is available (stays in memory)', async () => {
    const m = makeManager(undefined);
    await m.getSession(444);
    m.recordTelegramTurn(444, 'no id here', 'ok'); // no metadata; live session has no id
    expect(loadSession('no-id-here')).toBeUndefined();
    expect(listSessions()).toEqual([]);
    await m.closeAll().catch(() => {});
  });

  test('resetSession starts a fresh sidecar (new name + sessionId)', async () => {
    manager.recordTelegramTurn(555, 'alpha conversation', 'a', { sessionId: 'sdk-old' });
    await manager.resetSession(555);
    manager.recordTelegramTurn(555, 'beta conversation', 'b', { sessionId: 'sdk-new' });

    // Two distinct sidecars — the reset did not append to the old conversation.
    expect(findSession('alpha-conversation')?.data.sessionId).toBe('sdk-old');
    expect(findSession('beta-conversation')?.data.sessionId).toBe('sdk-new');
    expect(findSession('alpha-conversation')?.data.turns).toHaveLength(1);
    expect(findSession('beta-conversation')?.data.turns).toHaveLength(1);
  });
});

describe('SessionManager — session naming (/name)', () => {
  // Same unset-fallback contract as the recordTelegramTurn suite above:
  // the shared session store must resolve under this suite's tmp HOME.
  useUnsetAfkHome();

  class MockSessionWithId implements IAgentSession {
    state: SessionState = 'idle';
    constructor(readonly sessionId?: string) {}
    async sendMessage(content: string) {
      return { role: 'assistant' as const, content: `Echo: ${content}`, timestamp: new Date() };
    }
    async *getOutputStream() { yield { type: 'done' as const }; }
    abort(_reason: string): void { /* no-op */ }
    async close() { /* no-op */ }
    async reset() { /* no-op */ }
  }

  // Per-test isolation: each test gets its own dataDir + tmpHome so concurrent
  // runs and successive tests never share on-disk state.
  let testDataDir: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let manager: SessionManager;

  function makeManager(sessionId?: string, dataDir?: string): SessionManager {
    return new SessionManager({
      dataDir: dataDir ?? testDataDir,
      apiKey: 'test-key',
      defaultModel: 'sonnet',
      createSession: async () => new MockSessionWithId(sessionId),
    });
  }

  beforeEach(() => {
    // Fresh dataDir and HOME for every test — no shared on-disk state.
    const entropy = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    testDataDir = join(tmpdir(), `afk-tg-name-data-${entropy}`);
    // Isolate HOME so saveSession() writes into a throwaway ~/.afk store.
    originalHome = process.env['HOME'];
    tmpHome = join(tmpdir(), `afk-tg-name-home-${entropy}`);
    process.env['HOME'] = tmpHome;
    manager = makeManager('sdk-name-default');
  });

  afterEach(async () => {
    await manager.closeAll().catch(() => {});
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    if (existsSync(testDataDir)) rmSync(testDataDir, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
  });

  test('getSessionName returns undefined before any name is set', () => {
    expect(manager.getSessionName(700)).toBeUndefined();
  });

  test('setSessionName before any turn sets the name in memory but does not persist', () => {
    const { persisted } = manager.setSessionName(701, 'my-handle');
    expect(persisted).toBe(false);
    expect(manager.getSessionName(701)).toBe('my-handle');
    // Nothing written to the shared store yet — no turns to resume.
    expect(listSessions()).toEqual([]);
  });

  test('a name set before the first turn rides along on the first per-turn autosave', () => {
    manager.setSessionName(702, 'pre-named');
    expect(manager.getSessionName(702)).toBe('pre-named');

    manager.recordTelegramTurn(702, 'first message here', 'ok', { sessionId: 'sdk-702' });

    // The explicit name wins over auto-naming and the sidecar is now resumable.
    const found = findSession('pre-named');
    expect(found?.data.sessionId).toBe('sdk-702');
    expect(found?.data.turns).toHaveLength(1);
    // The auto-derived name from the first message must NOT have been applied.
    expect(findSession('first-message-here')).toBeUndefined();
  });

  test('setSessionName after a recorded turn persists immediately and is resumable by name', () => {
    manager.recordTelegramTurn(703, 'do the thing', 'sure', { sessionId: 'sdk-703' });

    const { persisted } = manager.setSessionName(703, 'renamed-session');
    expect(persisted).toBe(true);

    const found = findSession('renamed-session');
    expect(found?.data.sessionId).toBe('sdk-703');
    expect(found?.data.source).toBe('telegram');
    expect(found?.data.telegramChatId).toBe(703);
  });

  test('renaming overrides an auto-derived name without forking a duplicate sidecar', () => {
    // First turn auto-names from the message text.
    manager.recordTelegramTurn(704, 'investigate the bug', 'a', { sessionId: 'sdk-704' });
    expect(findSession('investigate-the-bug')?.data.sessionId).toBe('sdk-704');

    // Renaming updates the SAME sidecar (keyed by sessionId), not a new file.
    manager.setSessionName(704, 'custom-label');

    expect(findSession('custom-label')?.data.sessionId).toBe('sdk-704');
    // Old auto-name no longer resolves — the name field was overwritten in place.
    expect(findSession('investigate-the-bug')).toBeUndefined();
    expect(listSessions().filter((e) => e.sessionId === 'sdk-704')).toHaveLength(1);
  });

  test('captures the sessionId from the live session when stats lack one', async () => {
    const m = makeManager('sdk-from-live-name');
    // Seed a stats entry with a turn but no sessionId in metadata; the live
    // session supplies it so the immediate persist can key the sidecar.
    await m.getSession(705);
    m.recordTelegramTurn(705, 'a turn', 'done'); // no metadata sessionId
    const { persisted } = m.setSessionName(705, 'live-captured');
    expect(persisted).toBe(true);
    expect(findSession('live-captured')?.data.sessionId).toBe('sdk-from-live-name');
    await m.closeAll().catch(() => {});
  });

  test('after restart, setSessionName persists in place (no deferral), preserves turns, no duplicate sidecar', async () => {
    const CHAT = 800;
    // Phase 1: record a turn and flush to disk, simulating a pre-restart session.
    const m1 = makeManager('sdk-restart', testDataDir);
    await m1.getSession(CHAT);
    m1.recordTelegramTurn(CHAT, 'hello before restart', 'hi', { sessionId: 'sdk-restart' });
    await m1.closeAll(); // flushes {dataDir}/{CHAT}.json with the sessionId

    // Phase 2: simulate a bot restart — new manager, same dataDir and HOME.
    const m2 = makeManager('sdk-restart-new', testDataDir);
    await m2.loadSessions(); // rehydrates sessionData (incl. sessionId) but NOT sessionStats

    // The rename must persist immediately (persisted:true) because the stats
    // are hydrated from the sidecar and totalTurns > 0.
    const { persisted } = m2.setSessionName(CHAT, 'renamed-after-restart');
    expect(persisted).toBe(true);

    // The sidecar is still keyed by the ORIGINAL sessionId (no fork).
    const found = findSession('renamed-after-restart');
    expect(found?.data.sessionId).toBe('sdk-restart');

    // Turns from before the restart are preserved.
    expect(found?.data.turns).toHaveLength(1);

    // Exactly one sidecar with that sessionId — no duplicate.
    expect(listSessions().filter((e) => e.sessionId === 'sdk-restart')).toHaveLength(1);

    await m2.closeAll().catch(() => {});
  });

  test('after restart, getSessionName returns the persisted name', async () => {
    const CHAT = 801;
    // Phase 1: name the session before a restart.
    const m1 = makeManager('sdk-named-restart', testDataDir);
    await m1.getSession(CHAT);
    m1.recordTelegramTurn(CHAT, 'named session turn', 'ok', { sessionId: 'sdk-named-restart' });
    m1.setSessionName(CHAT, 'persisted-name');
    await m1.closeAll();

    // Phase 2: new manager with same dataDir + HOME — sessionStats starts empty.
    const m2 = makeManager('sdk-named-restart-new', testDataDir);
    await m2.loadSessions();

    // getSessionName must return the persisted name, not undefined.
    expect(m2.getSessionName(CHAT)).toBe('persisted-name');

    await m2.closeAll().catch(() => {});
  });
});

describe('SessionManager — session switcher (/sessions, /switch, /new)', () => {
  // Same unset-AFK_HOME contract as the recordTelegramTurn suite: the shared
  // sidecar store (listSessions/loadSession) resolves under this suite's tmp HOME.
  useUnsetAfkHome();

  class MockSessionWithId implements IAgentSession {
    state: SessionState = 'idle';
    constructor(readonly sessionId?: string) {}
    async sendMessage(content: string) {
      return { role: 'assistant' as const, content: `Echo: ${content}`, timestamp: new Date() };
    }
    async *getOutputStream() { yield { type: 'done' as const }; }
    abort(_reason: string): void { /* no-op */ }
    async close() { /* no-op */ }
    async reset() { /* no-op */ }
  }

  let testDataDir: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let lastConfig: AgentConfig | undefined;
  let manager: SessionManager;

  function makeManager(sessionId?: string): SessionManager {
    return new SessionManager({
      dataDir: testDataDir,
      apiKey: 'test-key',
      defaultModel: 'sonnet',
      createSession: async (config: AgentConfig) => {
        lastConfig = config;
        return new MockSessionWithId(sessionId);
      },
    });
  }

  beforeEach(() => {
    const entropy = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    testDataDir = join(tmpdir(), `afk-tg-sw-data-${entropy}`);
    originalHome = process.env['HOME'];
    tmpHome = join(tmpdir(), `afk-tg-sw-home-${entropy}`);
    process.env['HOME'] = tmpHome;
    lastConfig = undefined;
    manager = makeManager('sdk-live-default');
  });

  afterEach(async () => {
    await manager.closeAll().catch(() => {});
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    if (existsSync(testDataDir)) rmSync(testDataDir, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
  });

  test('listChatSessions lists this chat\'s telegram sidecars, excluding other chats', async () => {
    // Two distinct conversations for chat 800 (reset between so each gets its own sidecar).
    manager.recordTelegramTurn(800, 'alpha work', 'a', { sessionId: 'sdk-A' });
    await manager.resetSession(800);
    manager.recordTelegramTurn(800, 'beta work', 'b', { sessionId: 'sdk-B' });
    // A different chat's sidecar must NOT leak into 800's list.
    manager.recordTelegramTurn(999, 'other chat', 'x', { sessionId: 'sdk-other' });

    const list = manager.listChatSessions(800);
    expect(list.map((s) => s.sessionId).sort()).toEqual(['sdk-A', 'sdk-B']);
    // No live/active session was established for 800 → nothing flagged active.
    expect(list.every((s) => s.active === false)).toBe(true);
    const alpha = list.find((s) => s.sessionId === 'sdk-A');
    expect(alpha?.name).toBe('alpha-work');
    expect(alpha?.turns).toBe(1);
    expect(alpha?.model).toBe('sonnet');
  });

  test('switchToSession stages resume, marks the target active, and the next getSession resumes it', async () => {
    manager.recordTelegramTurn(801, 'first convo', 'a', { sessionId: 'sdk-1' });
    await manager.resetSession(801);
    manager.recordTelegramTurn(801, 'second convo', 'b', { sessionId: 'sdk-2' });

    const res = await manager.switchToSession(801, 'sdk-1');
    expect(res).toEqual({ ok: true });
    expect(manager.listChatSessions(801).find((s) => s.sessionId === 'sdk-1')?.active).toBe(true);

    // The rebuilt session continues the chosen conversation: config.resume === target.
    await manager.getSession(801);
    expect(lastConfig?.resume).toBe('sdk-1');

    // A subsequent /clear starts fresh — the staged resume is dropped.
    await manager.resetSession(801);
    lastConfig = undefined;
    await manager.getSession(801);
    expect(lastConfig?.resume).toBeUndefined();
  });

  test('switchToSession rejects an unknown or cross-chat target', async () => {
    manager.recordTelegramTurn(802, 'my convo', 'a', { sessionId: 'sdk-802' });

    expect(await manager.switchToSession(802, 'does-not-exist')).toEqual({ ok: false, reason: 'not-found' });
    // sdk-802 belongs to chat 802, so switching chat 803 to it must be refused.
    expect(await manager.switchToSession(803, 'sdk-802')).toEqual({ ok: false, reason: 'not-found' });
  });

  test('switchToSession no-ops when the target is already the live active session', async () => {
    await manager.getSession(804);
    manager.recordTelegramTurn(804, 'hi', 'yo', { sessionId: 'sdk-live-default' });
    const res = await manager.switchToSession(804, 'sdk-live-default');
    expect(res).toEqual({ ok: false, reason: 'already-active' });
  });

  test('newSession preserves the previous conversation as resumable and starts fresh', async () => {
    manager.recordTelegramTurn(805, 'old convo', 'a', { sessionId: 'sdk-old' });
    await manager.newSession(805);
    manager.recordTelegramTurn(805, 'new convo', 'b', { sessionId: 'sdk-fresh' });

    expect(manager.listChatSessions(805).map((s) => s.sessionId).sort()).toEqual(['sdk-fresh', 'sdk-old']);
  });
});

describe('SessionManager — per-route isolation (native topics)', () => {
  // Step 6: two topics in one chat are concurrent, fully-isolated sessions.
  // RouteTarget = TelegramRoute | number; a bare number === General topic, so
  // General must stay byte-identical to the pre-topics behavior.
  useUnsetAfkHome();

  class MockSessionWithId implements IAgentSession {
    state: SessionState = 'idle';
    constructor(readonly sessionId?: string) {}
    async sendMessage(content: string) {
      return { role: 'assistant' as const, content: `Echo: ${content}`, timestamp: new Date() };
    }
    async *getOutputStream() { yield { type: 'done' as const }; }
    abort(_reason: string): void { /* no-op */ }
    async close() { /* no-op */ }
    async reset() { /* no-op */ }
  }

  let testDataDir: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let manager: SessionManager;

  beforeEach(() => {
    const entropy = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    testDataDir = join(tmpdir(), `afk-tg-iso-data-${entropy}`);
    originalHome = process.env['HOME'];
    tmpHome = join(tmpdir(), `afk-tg-iso-home-${entropy}`);
    process.env['HOME'] = tmpHome;
    let n = 0;
    manager = new SessionManager({
      dataDir: testDataDir,
      apiKey: 'test-key',
      defaultModel: 'sonnet',
      createSession: async () => new MockSessionWithId(`sdk-live-${n++}`),
    });
  });

  afterEach(async () => {
    await manager.closeAll().catch(() => {});
    if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    if (existsSync(testDataDir)) rmSync(testDataDir, { recursive: true, force: true });
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
  });

  test('two topics in one chat get distinct, concurrent sessions', async () => {
    const general = { chatId: 900 };
    const topic = { chatId: 900, threadId: 7 };

    const sGeneral = await manager.getSession(general);
    const sTopic = await manager.getSession(topic);

    // Distinct live sessions coexist for the same chat — no cross-topic sharing.
    expect(sGeneral).not.toBe(sTopic);
    // Both stay live simultaneously (opening the topic did not tear down General).
    expect(await manager.getSession(general)).toBe(sGeneral);
    expect(manager.getSessionIfExists(topic)).toBe(sTopic);
  });

  test('per-route turns persist as separate resumable sidecars under the same chat', () => {
    manager.recordTelegramTurn({ chatId: 900 }, 'general work', 'a', { sessionId: 'sdk-gen' });
    manager.recordTelegramTurn({ chatId: 900, threadId: 7 }, 'topic work', 'b', { sessionId: 'sdk-top' });

    // Both belong to chat 900 (listed together) but are distinct conversations.
    expect(manager.listChatSessions(900).map((s) => s.sessionId).sort()).toEqual(['sdk-gen', 'sdk-top']);
  });

  test('General route is back-compat with the bare chatId (number === { chatId })', () => {
    manager.recordTelegramTurn(901, 'hello', 'hi', { sessionId: 'sdk-901' });
    // The explicit General route resolves the same chat's sessions as the bare number.
    expect(manager.listChatSessions({ chatId: 901 }).map((s) => s.sessionId)).toEqual(['sdk-901']);
  });
});
