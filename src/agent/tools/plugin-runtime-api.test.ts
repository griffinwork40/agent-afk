/**
 * Tests for plugin-runtime-api.ts: state-store singleton + peer-messaging closures.
 *
 * Strategy:
 *   - State methods: inject a mock factory into buildStateApiClosures; assert
 *     the factory is called exactly once (singleton) and each of the 6 methods
 *     delegates to the store instance (call count 0 before first call, 1 after).
 *   - Peer methods: mock presence + send transport; assert from-overwrite, self-
 *     exclusion, fail-closed outside ALS, and that a nested missing-context hook
 *     (runWithPluginSessionContext(undefined, ...)) clears outer ALS so it cannot
 *     inherit an ancestor session id.
 *   - Integration: installPluginHooks wires a real hook that calls listSessions
 *     via actual API send path with mock transport.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StateStore } from '../state/state-store.js';
import {
  buildStateApiClosures,
  buildPeerApiClosures,
  _resetDefaultStateStore,
} from '../plugins/plugin-runtime-api.js';
import { runWithPluginSessionContext } from '../plugins/plugin-session-context.js';

// ---------------------------------------------------------------------------
// Mock transport for peer tests
// ---------------------------------------------------------------------------

const mockSendImpl = vi.fn().mockResolvedValue({ status: 'queued', messageId: 'mid-1' });

vi.mock('../peer/send.js', () => ({
  sendToSession: (...args: unknown[]) => mockSendImpl(...args),
}));

const presenceRecords = [
  { sessionId: 'session-self', name: 'self' },
  { sessionId: 'session-peer', name: 'peer' },
];

vi.mock('../awareness/presence.js', () => ({
  readLivePresenceFiles: () => Promise.resolve([...presenceRecords]),
}));

// ---------------------------------------------------------------------------
// Helper: build a fully-instrumented mock StateStore
// ---------------------------------------------------------------------------

function makeMockStore(): StateStore & { _calls: Record<string, number> } {
  const counts: Record<string, number> = {
    get: 0, put: 0, cas: 0, del: 0, insertIfAbsent: 0, query: 0,
  };
  return {
    _calls: counts,
    get: vi.fn(async () => { counts['get']!++; return undefined; }),
    put: vi.fn(async () => { counts['put']!++; return { version: 1 }; }),
    cas: vi.fn(async () => { counts['cas']!++; return { matched: true, newVersion: 2 }; }),
    del: vi.fn(async () => { counts['del']!++; return { deleted: true }; }),
    insertIfAbsent: vi.fn(async () => { counts['insertIfAbsent']!++; return { inserted: true, version: 1 }; }),
    query: vi.fn(async () => { counts['query']!++; return []; }),
  } as unknown as StateStore & { _calls: Record<string, number> };
}

// ---------------------------------------------------------------------------
// State API: singleton factory + 6 method delegation
// ---------------------------------------------------------------------------

describe('buildStateApiClosures — factory called exactly once (singleton)', () => {
  beforeEach(() => _resetDefaultStateStore());
  afterEach(() => _resetDefaultStateStore());

  it('factory is called 0 times before any state method is invoked', () => {
    const factory = vi.fn(() => makeMockStore());
    buildStateApiClosures(undefined, factory);
    expect(factory).toHaveBeenCalledTimes(0);
  });

  it('factory is called exactly 1 time on first state method invocation', async () => {
    const factory = vi.fn(() => makeMockStore());
    const api = buildStateApiClosures(undefined, factory);
    await api.stateGet('ns', 'k');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('factory is NOT called again on subsequent calls (singleton reuse)', async () => {
    const factory = vi.fn(() => makeMockStore());
    const api = buildStateApiClosures(undefined, factory);
    await api.stateGet('ns', 'k1');
    await api.statePut('ns', 'k2', 'v');
    await api.stateDel('ns', 'k3');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('factory is NOT called again after re-registration (same process singleton)', async () => {
    const factory = vi.fn(() => makeMockStore());
    const api1 = buildStateApiClosures(undefined, factory);
    await api1.stateGet('ns', 'k');
    const api2 = buildStateApiClosures(undefined, factory);
    await api2.statePut('ns', 'k2', 'v');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('each of the 6 state methods delegates to the store (call count 0 → 1)', async () => {
    const store = makeMockStore();
    const factory = vi.fn(() => store);
    const api = buildStateApiClosures(undefined, factory);

    expect(store._calls['get']).toBe(0);
    await api.stateGet('ns', 'k');
    expect(store._calls['get']).toBe(1);

    expect(store._calls['put']).toBe(0);
    await api.statePut('ns', 'k', 'v');
    expect(store._calls['put']).toBe(1);

    expect(store._calls['cas']).toBe(0);
    await api.stateCas('ns', 'k', 1, 'v');
    expect(store._calls['cas']).toBe(1);

    expect(store._calls['del']).toBe(0);
    await api.stateDel('ns', 'k');
    expect(store._calls['del']).toBe(1);

    expect(store._calls['insertIfAbsent']).toBe(0);
    await api.stateInsertIfAbsent('ns', 'k', 'v');
    expect(store._calls['insertIfAbsent']).toBe(1);

    expect(store._calls['query']).toBe(0);
    await api.stateQuery('ns');
    expect(store._calls['query']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// S-2: namespace sandboxing — plugin:<id>: prefix applied at closure boundary
// ---------------------------------------------------------------------------

describe('buildStateApiClosures — namespace sandboxing (S-2)', () => {
  beforeEach(() => _resetDefaultStateStore());
  afterEach(() => _resetDefaultStateStore());

  it('prefixes all 6 state methods with plugin:<pluginId>: when pluginId is given', async () => {
    const store = makeMockStore();
    const factory = vi.fn(() => store);
    const api = buildStateApiClosures('my-plugin', factory);

    await api.stateGet('config', 'k');
    expect((store.get as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('plugin:my-plugin:config');

    await api.statePut('data', 'k', 'v');
    expect((store.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('plugin:my-plugin:data');

    await api.stateCas('data', 'k', 1, 'v');
    expect((store.cas as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('plugin:my-plugin:data');

    await api.stateDel('cache', 'k');
    expect((store.del as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('plugin:my-plugin:cache');

    await api.stateInsertIfAbsent('locks', 'k', 'v');
    expect((store.insertIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('plugin:my-plugin:locks');

    await api.stateQuery('results');
    expect((store.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('plugin:my-plugin:results');
  });

  it('passes namespace verbatim when pluginId is undefined (no prefix)', async () => {
    const store = makeMockStore();
    const factory = vi.fn(() => store);
    const api = buildStateApiClosures(undefined, factory);

    await api.stateGet('my-ns', 'k');
    expect((store.get as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('my-ns');
  });

  it('a plugin cannot read a host-owned namespace (plugin: prefix prevents collision)', async () => {
    // A plugin using ns='usage' must reach 'plugin:my-plugin:usage', never 'usage'.
    const store = makeMockStore();
    const factory = vi.fn(() => store);
    const api = buildStateApiClosures('my-plugin', factory);

    await api.stateGet('usage', 'k');
    const calledNs = (store.get as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(calledNs).not.toBe('usage');
    expect(calledNs).toBe('plugin:my-plugin:usage');
  });
});

// ---------------------------------------------------------------------------
// Peer API: sendToSession from-overwrite + fail-closed
// ---------------------------------------------------------------------------

describe('buildPeerApiClosures — sendToSession', () => {
  beforeEach(() => mockSendImpl.mockClear());

  it('overwrites any plugin-supplied from with the ALS session id', async () => {
    const { sendToSession } = buildPeerApiClosures();
    const forgedInput = { to: 'session-peer', message: 'hello', from: { id: 'forged-sender' } };
    await runWithPluginSessionContext('session-self', () => sendToSession(forgedInput));
    expect(mockSendImpl).toHaveBeenCalledOnce();
    const arg = mockSendImpl.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg['from']).toEqual({ id: 'session-self' });
    expect(arg['to']).toBe('session-peer');
  });

  it('fails closed (throws) outside ALS context', async () => {
    const { sendToSession } = buildPeerApiClosures();
    await expect(
      sendToSession({ to: 'session-peer', message: 'spoofed' }),
    ).rejects.toThrow(/trustworthy caller context/);
    expect(mockSendImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Peer API: listSessions self-exclusion + fail-closed
// ---------------------------------------------------------------------------

describe('buildPeerApiClosures — listSessions', () => {
  it('excludes the calling session from results', async () => {
    const { listSessions } = buildPeerApiClosures();
    const result = await runWithPluginSessionContext('session-self', () => listSessions());
    const ids = result.map((r) => r.sessionId);
    expect(ids).not.toContain('session-self');
    expect(ids).toContain('session-peer');
  });

  it('fails closed (throws) outside ALS context', async () => {
    const { listSessions } = buildPeerApiClosures();
    await expect(listSessions()).rejects.toThrow(/trustworthy caller context/);
  });

  it('distinct concurrent ALS contexts produce distinct self-exclusions', async () => {
    const { listSessions } = buildPeerApiClosures();
    const [a, b] = await Promise.all([
      runWithPluginSessionContext('session-self', () => listSessions()),
      runWithPluginSessionContext('session-peer', () => listSessions()),
    ]);
    expect(a.map((r) => r.sessionId)).not.toContain('session-self');
    expect(a.map((r) => r.sessionId)).toContain('session-peer');
    expect(b.map((r) => r.sessionId)).not.toContain('session-peer');
    expect(b.map((r) => r.sessionId)).toContain('session-self');
  });
});

// ---------------------------------------------------------------------------
// Missing-context nested: runWithPluginSessionContext(undefined) clears outer ALS
// ---------------------------------------------------------------------------

describe('runWithPluginSessionContext(undefined) — clears outer inherited context', () => {
  it('nested undefined context cannot read outer session id', async () => {
    const { listSessions } = buildPeerApiClosures();

    // Outer context has a valid session id.
    await runWithPluginSessionContext('session-self', async () => {
      // Inner context with undefined — simulates legacy hook with no sessionId.
      // Must fail closed, not inherit 'session-self'.
      await expect(
        runWithPluginSessionContext(undefined, () => listSessions()),
      ).rejects.toThrow(/trustworthy caller context/);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: installPluginHooks wires real hook → listSessions via mock transport
// ---------------------------------------------------------------------------

describe('integration — installPluginHooks wraps hook in ALS context', () => {
  it('hook can call listSessions and receives correct self-exclusion', async () => {
    const { installPluginHooks, registerPluginHook, _resetLoadedEntrypoints } =
      await import('../plugins/load-entrypoints.js');

    _resetLoadedEntrypoints();

    let capturedIds: string[] = [];
    const { listSessions } = buildPeerApiClosures();

    const removeHook = registerPluginHook('PreToolUse', async (ctx) => {
      // listSessions reads ALS — installPluginHooks must have set it from ctx.sessionId
      const records = await listSessions();
      capturedIds = records.map((r) => r.sessionId);
      return {};
    });

    // Build a minimal fake HookRegistry
    type HookFn = (ctx: unknown, signal: AbortSignal) => Promise<unknown>;
    const handlers: HookFn[] = [];
    const fakeRegistry = {
      register: (_event: string, fn: HookFn) => { handlers.push(fn); },
    };

    installPluginHooks(fakeRegistry as Parameters<typeof installPluginHooks>[0]);

    // Fire the installed hook with a context that carries sessionId
    const signal = new AbortController().signal;
    await handlers[0]!({ sessionId: 'session-self', toolName: 'bash' }, signal);

    // Hook ran inside ALS for 'session-self' → 'session-self' must be excluded
    expect(capturedIds).not.toContain('session-self');
    expect(capturedIds).toContain('session-peer');

    removeHook();
    _resetLoadedEntrypoints();
  });
});
