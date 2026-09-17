/**
 * Direct unit tests for the evict-idle module.
 *
 * These cover the extracted helpers directly — without constructing a full
 * SessionManager — so each skip condition and error branch is isolated and
 * exercised at the unit boundary.
 *
 * Integration coverage (idle-session eviction wired through SessionManager)
 * lives in session-manager.test.ts.
 *
 * @module telegram/session-manager.evict-idle.test
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { evictIdleSessions, evictStaleSessionData, clearElicitationRouteForKey } from './session-manager.evict-idle.js';
import type { IAgentSession, SessionState } from '../agent/types.js';
import type { SessionData } from './session-manager.js';
import type { SessionStats } from '../cli/slash/types.js';
import { setElicitationRoute, getElicitationRoute } from './elicitation-route-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_AGE_MS = 60_000; // 1 minute for test clarity

/** Build a minimal SessionData object. */
function makeData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    chatId: 1,
    model: 'claude-sonnet-4-5',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a stale lastActivity timestamp (well beyond maxAgeMs). */
function staleActivity(): string {
  return new Date(Date.now() - MAX_AGE_MS * 2).toISOString();
}

/** Build a fresh lastActivity timestamp (within maxAgeMs). */
function freshActivity(): string {
  return new Date().toISOString();
}

/** Minimal IAgentSession stub. */
function makeSession(state: SessionState = 'idle'): IAgentSession & { closed: boolean } {
  return {
    state,
    closed: false,
    sessionId: undefined,
    async sendMessage() {
      return { role: 'assistant' as const, content: '', timestamp: new Date() };
    },
    async *getOutputStream() { yield { type: 'done' as const }; },
    abort() { /* no-op */ },
    async close() { this.closed = true; },
    async reset() { /* no-op */ },
  };
}

// ---------------------------------------------------------------------------
// evictIdleSessions — skip conditions
// ---------------------------------------------------------------------------

describe('evictIdleSessions', () => {
  test('skip condition: no sessionData entry — session is not evicted', async () => {
    const session = makeSession('idle');
    const sessions = new Map([['key1', session as IAgentSession]]);
    const sessionData = new Map<string, SessionData>(); // no entry for 'key1'

    const evicted = await evictIdleSessions(sessions, sessionData, MAX_AGE_MS);

    expect(evicted).toBe(0);
    expect(sessions.has('key1')).toBe(true);
    expect(session.closed).toBe(false);
  });

  test('skip condition: lastActivity within maxAgeMs — session is not evicted', async () => {
    const session = makeSession('idle');
    const sessions = new Map([['key1', session as IAgentSession]]);
    const sessionData = new Map([['key1', makeData({ lastActivity: freshActivity() })]]);

    const evicted = await evictIdleSessions(sessions, sessionData, MAX_AGE_MS);

    expect(evicted).toBe(0);
    expect(sessions.has('key1')).toBe(true);
    expect(session.closed).toBe(false);
  });

  test('skip condition: non-idle state — stale processing session is not evicted', async () => {
    const session = makeSession('processing');
    const sessions = new Map([['key1', session as IAgentSession]]);
    const sessionData = new Map([['key1', makeData({ lastActivity: staleActivity() })]]);

    const evicted = await evictIdleSessions(sessions, sessionData, MAX_AGE_MS);

    expect(evicted).toBe(0);
    expect(sessions.has('key1')).toBe(true);
    expect(session.closed).toBe(false);
  });

  test('happy path: stale idle session is closed and removed', async () => {
    const session = makeSession('idle');
    const sessions = new Map([['key1', session as IAgentSession]]);
    const sessionData = new Map([['key1', makeData({ lastActivity: staleActivity() })]]);

    const evicted = await evictIdleSessions(sessions, sessionData, MAX_AGE_MS);

    expect(evicted).toBe(1);
    expect(sessions.has('key1')).toBe(false);
    expect(session.closed).toBe(true);
  });

  test('error branch: throwing close() logs error and still removes the session', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* suppress */ });

    const badSession: IAgentSession = {
      state: 'idle',
      sessionId: undefined,
      async sendMessage() { return { role: 'assistant' as const, content: '', timestamp: new Date() }; },
      async *getOutputStream() { yield { type: 'done' as const }; },
      abort() { /* no-op */ },
      async close() { throw new Error('close failed'); },
      async reset() { /* no-op */ },
    };

    const sessions = new Map([['key1', badSession]]);
    const sessionData = new Map([['key1', makeData({ lastActivity: staleActivity() })]]);

    const evicted = await evictIdleSessions(sessions, sessionData, MAX_AGE_MS);

    // Session is removed despite the throw.
    expect(evicted).toBe(1);
    expect(sessions.has('key1')).toBe(false);
    // Error was logged.
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[session-manager] idle-evict close error for'),
      'key1',
      expect.any(Error),
    );

    consoleError.mockRestore();
  });

  test('session in sessions but no matching sessionData is skipped without error', async () => {
    // A session that appears only in `sessions` — no stats, no data.
    const session = makeSession('idle');
    const sessions = new Map([['orphan', session as IAgentSession]]);
    const sessionData = new Map<string, SessionData>();

    const evicted = await evictIdleSessions(sessions, sessionData, MAX_AGE_MS);

    expect(evicted).toBe(0);
    expect(sessions.has('orphan')).toBe(true);
    expect(session.closed).toBe(false);
  });

  test('boundary: lastActivity exactly at maxAgeMs is NOT evicted (> not >=)', async () => {
    // Freeze the clock so Date.now() cannot advance between setup and the function under test.
    const frozenNow = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(frozenNow);
    try {
      const session = makeSession('idle');
      const sessions = new Map([['key1', session as IAgentSession]]);
      // Exactly at the boundary — age === maxAgeMs, condition is > so this should be skipped.
      const sessionData = new Map([
        ['key1', makeData({ lastActivity: new Date(Date.now() - MAX_AGE_MS).toISOString() })],
      ]);

      const evicted = await evictIdleSessions(sessions, sessionData, MAX_AGE_MS);

      // At exactly maxAgeMs the condition `<= maxAgeMs` is true, so skip fires.
      expect(evicted).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// evictStaleSessionData — skip conditions
// ---------------------------------------------------------------------------

describe('evictStaleSessionData', () => {
  test('skip condition: no sessionData entry — nothing to evict', () => {
    const sessions = new Map<string, IAgentSession>();
    const sessionData = new Map<string, SessionData>();
    const sessionStats = new Map<string, SessionStats>();

    evictStaleSessionData(sessions, sessionData, sessionStats, MAX_AGE_MS);

    expect(sessionData.size).toBe(0);
  });

  test('skip condition: live session guard — stale entry with a live session is kept', () => {
    const session = makeSession('idle');
    const sessions = new Map([['key1', session as IAgentSession]]);
    const sessionData = new Map([['key1', makeData({ lastActivity: staleActivity() })]]);
    const sessionStats = new Map<string, SessionStats>();

    evictStaleSessionData(sessions, sessionData, sessionStats, MAX_AGE_MS);

    // Protected by the sessions.has(key) guard.
    expect(sessionData.has('key1')).toBe(true);
  });

  test('skip condition: age within maxAgeMs — entry is kept', () => {
    const sessions = new Map<string, IAgentSession>();
    const sessionData = new Map([['key1', makeData({ lastActivity: freshActivity() })]]);
    const sessionStats = new Map<string, SessionStats>();

    evictStaleSessionData(sessions, sessionData, sessionStats, MAX_AGE_MS);

    expect(sessionData.has('key1')).toBe(true);
  });

  test('happy path: stale entry without live session is evicted', () => {
    const sessions = new Map<string, IAgentSession>();
    const sessionData = new Map([['key1', makeData({ lastActivity: staleActivity() })]]);
    const sessionStats = new Map<string, SessionStats>();

    evictStaleSessionData(sessions, sessionData, sessionStats, MAX_AGE_MS);

    expect(sessionData.has('key1')).toBe(false);
  });

  test('clears elicitation route registry entry before evicting', () => {
    const sessions = new Map<string, IAgentSession>();
    const sessionData = new Map([
      ['key1', makeData({ lastActivity: staleActivity(), sessionId: 'evict-sid' })],
    ]);
    const sessionStats = new Map<string, SessionStats>();

    // Register the sessionId in the elicitation registry.
    setElicitationRoute('evict-sid', { chatId: 1 });
    expect(getElicitationRoute('evict-sid')).toBeDefined();

    evictStaleSessionData(sessions, sessionData, sessionStats, MAX_AGE_MS);

    expect(sessionData.has('key1')).toBe(false);
    expect(getElicitationRoute('evict-sid')).toBeUndefined();
  });

  test('session that appears only in sessions (no stats, no data) is not evicted by evictStaleSessionData', () => {
    // A route present only in sessions is never touched by evictStaleSessionData
    // (it iterates sessionData, not sessions).
    const session = makeSession('idle');
    const sessions = new Map([['orphan', session as IAgentSession]]);
    const sessionData = new Map<string, SessionData>(); // no entry for 'orphan'
    const sessionStats = new Map<string, SessionStats>();

    evictStaleSessionData(sessions, sessionData, sessionStats, MAX_AGE_MS);

    // Nothing to delete; sessions map is untouched.
    expect(sessions.has('orphan')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clearElicitationRouteForKey
// ---------------------------------------------------------------------------

describe('clearElicitationRouteForKey', () => {
  beforeEach(() => {
    // Ensure a clean registry state before each test.
    // We use setElicitationRoute to populate, so just make sure we clean up.
  });

  afterEach(() => {
    // Tests that register entries clean them up via the function under test or
    // by verifying it was cleared; no global teardown needed here.
  });

  test('clears via sessionStats.sessionId when stats entry exists', () => {
    setElicitationRoute('stats-sid', { chatId: 10 });
    expect(getElicitationRoute('stats-sid')).toBeDefined();

    const sessionStats = new Map([['key1', { sessionId: 'stats-sid' } as unknown as SessionStats]]);
    const sessionData = new Map<string, SessionData>();

    clearElicitationRouteForKey('key1', sessionStats, sessionData);

    expect(getElicitationRoute('stats-sid')).toBeUndefined();
  });

  test('clears via sessionData.sessionId when stats entry is absent', () => {
    setElicitationRoute('data-sid', { chatId: 11 });
    expect(getElicitationRoute('data-sid')).toBeDefined();

    const sessionStats = new Map<string, SessionStats>();
    const sessionData = new Map([['key1', makeData({ sessionId: 'data-sid' })]]);

    clearElicitationRouteForKey('key1', sessionStats, sessionData);

    expect(getElicitationRoute('data-sid')).toBeUndefined();
  });

  test('no-op when neither stats nor data carry a sessionId', () => {
    // Should not throw.
    const sessionStats = new Map<string, SessionStats>();
    const sessionData = new Map([['key1', makeData()]]);

    expect(() => clearElicitationRouteForKey('key1', sessionStats, sessionData)).not.toThrow();
  });
});
