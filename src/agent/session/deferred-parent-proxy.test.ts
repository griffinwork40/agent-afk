/**
 * Unit tests for {@link makeDeferredParentProxy}.
 *
 * Verifies stub behaviour before `bind` is called and live-session
 * pass-through after `bind` is called.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeDeferredParentProxy } from './deferred-parent-proxy.js';
import type { AgentSession } from './agent-session.js';

// ---------------------------------------------------------------------------
// Minimal AgentSession stub — only the fields the proxy reads.
// ---------------------------------------------------------------------------
function makeSessionStub(overrides: Partial<{
  sessionId: string;
  abortSignal: AbortSignal;
  hookRegistry: object;
  messageJournal: object;
  pushUserMessage: (m: string) => void;
}>): AgentSession {
  const push = overrides.pushUserMessage ?? vi.fn();
  return {
    sessionId: overrides.sessionId ?? 'test-session-id',
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    hookRegistry: overrides.hookRegistry as AgentSession['hookRegistry'],
    messageJournal: overrides.messageJournal as AgentSession['messageJournal'],
    getInputStreamRef: () => ({ pushUserMessage: push }),
  } as unknown as AgentSession;
}

// ---------------------------------------------------------------------------
// Before bind — stub values
// ---------------------------------------------------------------------------

describe('makeDeferredParentProxy — before bind', () => {
  it('sessionId is undefined', () => {
    const { proxy } = makeDeferredParentProxy();
    expect(proxy.sessionId).toBeUndefined();
  });

  it('abortSignal returns a fresh (non-aborted) signal', () => {
    const { proxy } = makeDeferredParentProxy();
    expect(proxy.abortSignal).toBeInstanceOf(AbortSignal);
    expect(proxy.abortSignal.aborted).toBe(false);
  });

  it('hookRegistry is undefined', () => {
    const { proxy } = makeDeferredParentProxy();
    expect(proxy.hookRegistry).toBeUndefined();
  });

  it('messageJournal is undefined', () => {
    const { proxy } = makeDeferredParentProxy();
    expect(proxy.messageJournal).toBeUndefined();
  });

  it('getInputStreamRef returns a no-op pushUserMessage that does not throw', () => {
    const { proxy } = makeDeferredParentProxy();
    const ref = proxy.getInputStreamRef();
    expect(() => ref.pushUserMessage('hello')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// After bind — live session pass-through
// ---------------------------------------------------------------------------

describe('makeDeferredParentProxy — after bind', () => {
  it('sessionId resolves to the bound session value', () => {
    const { proxy, bind } = makeDeferredParentProxy();
    bind(makeSessionStub({ sessionId: 'live-id' }));
    expect(proxy.sessionId).toBe('live-id');
  });

  it('abortSignal resolves to the bound session signal', () => {
    const ctrl = new AbortController();
    const { proxy, bind } = makeDeferredParentProxy();
    bind(makeSessionStub({ abortSignal: ctrl.signal }));
    expect(proxy.abortSignal).toBe(ctrl.signal);
  });

  it('abortSignal reflects abort on the bound session signal', () => {
    const ctrl = new AbortController();
    const { proxy, bind } = makeDeferredParentProxy();
    bind(makeSessionStub({ abortSignal: ctrl.signal }));
    ctrl.abort();
    expect(proxy.abortSignal.aborted).toBe(true);
  });

  it('hookRegistry resolves to the bound session value', () => {
    const registry = { fake: 'registry' };
    const { proxy, bind } = makeDeferredParentProxy();
    bind(makeSessionStub({ hookRegistry: registry }));
    expect(proxy.hookRegistry).toBe(registry);
  });

  it('messageJournal resolves to the bound session value', () => {
    const journal = { fake: 'journal' };
    const { proxy, bind } = makeDeferredParentProxy();
    bind(makeSessionStub({ messageJournal: journal }));
    expect(proxy.messageJournal).toBe(journal);
  });

  it('getInputStreamRef delegates pushUserMessage to the bound session', () => {
    const push = vi.fn();
    const { proxy, bind } = makeDeferredParentProxy();
    bind(makeSessionStub({ pushUserMessage: push }));
    proxy.getInputStreamRef().pushUserMessage('hi');
    expect(push).toHaveBeenCalledWith('hi');
  });

  it('proxy reads lazily — calling bind after reading does not cache the stub value', () => {
    const { proxy, bind } = makeDeferredParentProxy();
    // Read before bind — stub value
    expect(proxy.sessionId).toBeUndefined();
    // Now bind
    bind(makeSessionStub({ sessionId: 'post-bind-id' }));
    // Same proxy object now returns the live value
    expect(proxy.sessionId).toBe('post-bind-id');
  });

  it('each makeDeferredParentProxy call is independent', () => {
    const { proxy: p1, bind: b1 } = makeDeferredParentProxy();
    const { proxy: p2, bind: b2 } = makeDeferredParentProxy();
    b1(makeSessionStub({ sessionId: 'alpha' }));
    b2(makeSessionStub({ sessionId: 'beta' }));
    expect(p1.sessionId).toBe('alpha');
    expect(p2.sessionId).toBe('beta');
  });
});
