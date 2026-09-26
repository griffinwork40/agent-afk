/**
 * Unit tests for the memory hooks:
 * - createChildMemoryHotBlockHook: blocks target:"hot" writes from subagents
 * - createMemorySessionEndHook: guarded against forked subagent noise
 *
 * The hooks are registered on a real HookRegistry so we verify that the
 * returned decision actually causes registry dispatch to throw HookBlockedError
 * — not just that the hook function returns a particular shape.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PreToolUseContext, SessionEndContext } from '../hooks.js';
import { createHookRegistry } from '../hooks.js';
import { createChildMemoryHotBlockHook, createMemorySessionEndHook } from './memory-hooks.js';
import type { MemoryStore } from './memory-store.js';
import { HookBlockedError } from '../../utils/errors.js';

function preToolCtx(over: Partial<PreToolUseContext> = {}): PreToolUseContext {
  return { event: 'PreToolUse', toolName: 'memory_update', ...over };
}

describe('createChildMemoryHotBlockHook — via registry dispatch', () => {
  it("blocks subagent + target:'hot' — registry throws HookBlockedError", async () => {
    const registry = createHookRegistry();
    registry.register('PreToolUse', createChildMemoryHotBlockHook());

    await expect(
      registry.dispatch(
        preToolCtx({
          toolName: 'memory_update',
          input: { target: 'hot' },
          parentSessionId: 'parent-1',
          sessionId: 'child-1',
        }),
      ),
    ).rejects.toBeInstanceOf(HookBlockedError);
  });

  it("allows subagent + target:'fact' — registry resolves without throwing", async () => {
    const registry = createHookRegistry();
    registry.register('PreToolUse', createChildMemoryHotBlockHook());

    await expect(
      registry.dispatch(
        preToolCtx({
          toolName: 'memory_update',
          input: { target: 'fact' },
          parentSessionId: 'parent-1',
          sessionId: 'child-1',
        }),
      ),
    ).resolves.not.toBeInstanceOf(HookBlockedError);
  });

  it("allows top-level + target:'hot' — registry resolves without throwing", async () => {
    const registry = createHookRegistry();
    registry.register('PreToolUse', createChildMemoryHotBlockHook());

    // No parentSessionId → top-level session; must NOT be blocked.
    await expect(
      registry.dispatch(
        preToolCtx({
          toolName: 'memory_update',
          input: { target: 'hot' },
          sessionId: 'top-level-1',
        }),
      ),
    ).resolves.not.toBeInstanceOf(HookBlockedError);
  });

  it("allows non-memory_update tools from subagent", async () => {
    const registry = createHookRegistry();
    registry.register('PreToolUse', createChildMemoryHotBlockHook());

    await expect(
      registry.dispatch(
        preToolCtx({
          toolName: 'bash',
          input: { command: 'ls' },
          parentSessionId: 'parent-1',
          sessionId: 'child-1',
        }),
      ),
    ).resolves.not.toBeInstanceOf(HookBlockedError);
  });

  it("injectContext in HookBlockedError explains target:'fact' alternative", async () => {
    const registry = createHookRegistry();
    registry.register('PreToolUse', createChildMemoryHotBlockHook());

    const err = await registry
      .dispatch(
        preToolCtx({
          toolName: 'memory_update',
          input: { target: 'hot' },
          parentSessionId: 'parent-1',
          sessionId: 'child-1',
        }),
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(HookBlockedError);
    expect((err as HookBlockedError).injectContext).toContain('target:"hot"');
  });
});

// ---------------------------------------------------------------------------

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
    // actor is derived from the (absent) parentSessionId → 'main' for a
    // top-level session.
    expect(startSession).toHaveBeenCalledWith({ session_id: 'top-level', surface: 'cli', actor: 'main' });
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
