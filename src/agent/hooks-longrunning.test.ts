/**
 * Tests for the `longRunning` per-handler registration option added to
 * {@link HookRegistry}.
 *
 * Invariant: a handler registered with `longRunning: true` does NOT race
 * against the per-handler timeout. This is the load-bearing escape hatch
 * for the path-approval hook, which awaits `elicitationRouter.route()`
 * (a 5-minute human-input window) and would otherwise be killed by the
 * default 30s timeout in the dispatch loop.
 *
 * The corresponding default-timeout behavior is already covered by
 * `hooks.test.ts`. This file pins ONLY the new opt-out path.
 */

import { describe, expect, it, vi } from 'vitest';
import { createHookRegistry } from './hooks.js';
import type { HookHandler, SessionStartContext } from './hooks.js';

function ctx(): SessionStartContext {
  return { event: 'SessionStart', sessionId: 'sess-1' };
}

describe('HookRegistry — longRunning opt-out', () => {
  it('longRunning handler is not killed by the per-handler timeout', async () => {
    const registry = createHookRegistry();
    // Handler resolves after 50ms — but we pass a 10ms timeout. Without
    // `longRunning`, this would throw `HookHandlerTimeoutError`. With it,
    // we expect the dispatch to wait the full 50ms.
    const slow: HookHandler = async () => {
      await new Promise((res) => setTimeout(res, 50));
      return { reason: 'completed-after-timeout' };
    };
    registry.register('SessionStart', slow, { longRunning: true });

    const decision = await registry.dispatch(ctx(), undefined, 10);
    expect(decision.reason).toBe('completed-after-timeout');
  });

  it('default-registered handler IS killed by the timeout (sanity)', async () => {
    const registry = createHookRegistry();
    const slow: HookHandler = async () => {
      await new Promise((res) => setTimeout(res, 50));
      return {};
    };
    registry.register('SessionStart', slow);

    await expect(registry.dispatch(ctx(), undefined, 10)).rejects.toMatchObject({
      code: 'HOOK_HANDLER_TIMEOUT',
    });
  });

  it('register returns an unsubscribe that removes the longRunning entry', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn(async () => ({}));
    const off = registry.register('SessionStart', handler, { longRunning: true });
    expect(registry.count('SessionStart')).toBe(1);
    off();
    expect(registry.count('SessionStart')).toBe(0);
    await registry.dispatch(ctx());
    expect(handler).not.toHaveBeenCalled();
  });

  it('mixing longRunning and bounded handlers in one event works', async () => {
    const registry = createHookRegistry();
    const bounded = vi.fn<HookHandler>(async () => ({}));
    const slow: HookHandler = async () => {
      await new Promise((res) => setTimeout(res, 50));
      return {};
    };
    registry.register('SessionStart', bounded);
    registry.register('SessionStart', slow, { longRunning: true });

    // 10ms timeout would kill the slow handler if it were bounded; here it
    // shouldn't. The bounded one runs first.
    const decision = await registry.dispatch(ctx(), undefined, 10);
    expect(bounded).toHaveBeenCalledTimes(1);
    expect(decision).toBeDefined();
  });
});
