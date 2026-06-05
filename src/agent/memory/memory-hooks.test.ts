/**
 * Unit tests for the memory SessionEnd hook, focused on the subagent guard.
 *
 * The hook is registered on the default registry, which forked subagents
 * inherit via their child config (subagent.ts). Without the parentSessionId
 * guard, every subagent teardown would write a start/end session pair to the
 * store — polluting it with worker sessions the user never started.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionEndContext } from '../hooks.js';
import { createMemorySessionEndHook } from './memory-hooks.js';
import type { MemoryStore } from './memory-store.js';

function makeStoreSpy() {
  const startSession = vi.fn();
  const endSession = vi.fn();
  // Only the two methods the hook touches are needed.
  const store = { startSession, endSession } as unknown as MemoryStore;
  return { store, startSession, endSession };
}

function endCtx(over: Partial<SessionEndContext> = {}): SessionEndContext {
  return { event: 'SessionEnd', sessionId: 'sess-1', ...over };
}

describe('createMemorySessionEndHook', () => {
  it('writes a session record for a top-level session (no parentSessionId)', () => {
    const { store, startSession, endSession } = makeStoreSpy();
    const hook = createMemorySessionEndHook(store, 'cli');

    hook(endCtx({ sessionId: 'top-level', reason: 'closed' }));

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith({ session_id: 'top-level', surface: 'cli' });
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it('skips forked subagent sessions (parentSessionId set)', () => {
    const { store, startSession, endSession } = makeStoreSpy();
    const hook = createMemorySessionEndHook(store, 'cli');

    hook(endCtx({ sessionId: 'child-1', parentSessionId: 'parent-1' }));

    expect(startSession).not.toHaveBeenCalled();
    expect(endSession).not.toHaveBeenCalled();
  });

  it('returns {} for non-SessionEnd events', () => {
    const { store, startSession } = makeStoreSpy();
    const hook = createMemorySessionEndHook(store, 'cli');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(hook({ event: 'SessionStart', sessionId: 'x' } as any)).toEqual({});
    expect(startSession).not.toHaveBeenCalled();
  });
});
