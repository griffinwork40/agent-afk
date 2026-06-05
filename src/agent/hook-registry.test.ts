/**
 * Tests for HookRegistryImpl and dispatchSubagentStop timeout behaviour.
 *
 * R3 regression: a user-registered SubagentStop handler that never resolves
 * must not hang dispatchSubagentStop forever. The dispatch must complete within
 * the per-handler timeout window and surface a timeout-tagged hook_decision
 * event so the timeout is observable (not silently swallowed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHookRegistryImpl, HookHandlerTimeoutError, HOOK_HANDLER_TIMEOUT_MS } from './hook-registry.js';

describe('HookRegistryImpl.dispatch — basic', () => {
  it('returns empty decision when no handlers are registered', async () => {
    const registry = createHookRegistryImpl();
    const decision = await registry.dispatch({ event: 'SubagentStop', subagentId: 'x' });
    expect(decision).toEqual({});
  });

  it('returns the handler decision on normal resolution', async () => {
    const registry = createHookRegistryImpl();
    registry.register('SubagentStop', async () => ({ injectContext: 'hello' }));
    const decision = await registry.dispatch({ event: 'SubagentStop', subagentId: 'x' });
    expect(decision.injectContext).toBe('hello');
  });

  it('throws HookBlockedError when handler returns block decision', async () => {
    const registry = createHookRegistryImpl();
    registry.register('SubagentStart', async () => ({ decision: 'block', reason: 'policy' }));
    await expect(registry.dispatch({ event: 'SubagentStart', subagentId: 'x' })).rejects.toThrow(
      /block/i,
    );
  });

  it('count() reflects registration', () => {
    const registry = createHookRegistryImpl();
    expect(registry.count('SubagentStop')).toBe(0);
    registry.register('SubagentStop', async () => ({}));
    expect(registry.count('SubagentStop')).toBe(1);
  });

  it('unregister removes the handler', () => {
    const registry = createHookRegistryImpl();
    const remove = registry.register('SubagentStop', async () => ({}));
    remove();
    expect(registry.count('SubagentStop')).toBe(0);
  });
});

describe('[R3] dispatchSubagentStop — per-handler timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves within the timeout window even when a handler never settles', async () => {
    // External constraint: daemon teardown via cancel() → dispatchStopAndRelease()
    // must complete in bounded time; a never-resolving SubagentStop handler must
    // not block BackgroundAgentRegistry.cancelAll() forever.
    const { dispatchSubagentStop } = await import('./subagent-hooks.js');
    const { createHookRegistryImpl: makeRegistry } = await import('./hook-registry.js');

    const registry = makeRegistry();
    // Register a handler that never resolves — simulates a hook hitting a slow
    // remote API (the primary real-world failure mode for this bug).
    registry.register('SubagentStop', () => new Promise<never>(() => {}));

    const dispatchPromise = dispatchSubagentStop(
      registry,
      { event: 'SubagentStop', subagentId: 'hung-subagent' },
      {},
    );

    // Advance past the 30-second HOOK_HANDLER_TIMEOUT_MS constant.
    await vi.advanceTimersByTimeAsync(31_000);

    // Must resolve (not hang) after the timeout fires.
    const decision = await dispatchPromise;

    // Non-blocking semantics preserved — returns empty decision, not throws.
    expect(decision).toBeDefined();
    expect(typeof decision).toBe('object');
  });

  it('emits a console.warn when a handler times out (timeout is observable in production)', async () => {
    // The timeout must not be silent — it must surface via console.warn so
    // daemon operators running headless (no AFK_DEBUG=1) can still discover
    // a 30s teardown stall. The production-visible contract is owned by
    // dispatchSubagentStop, not the inner registry race.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { dispatchSubagentStop } = await import('./subagent-hooks.js');
    const { createHookRegistryImpl: makeRegistry } = await import('./hook-registry.js');

    const registry = makeRegistry();
    registry.register('SubagentStop', () => new Promise<never>(() => {}));

    const dispatchPromise = dispatchSubagentStop(
      registry,
      { event: 'SubagentStop', subagentId: 'hung-subagent-2' },
      {},
    );

    await vi.advanceTimersByTimeAsync(31_000);
    await dispatchPromise;

    const calls = warnSpy.mock.calls.map((args) => args.join(' '));
    const hasTimeoutEntry = calls.some(
      (msg) => msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('timed out'),
    );
    expect(hasTimeoutEntry).toBe(true);

    warnSpy.mockRestore();
  });

  it('does not time out a handler that resolves within the window', async () => {
    const { dispatchSubagentStop } = await import('./subagent-hooks.js');
    const { createHookRegistryImpl: makeRegistry } = await import('./hook-registry.js');

    const registry = makeRegistry();
    // Resolves quickly (before the 30s timeout).
    registry.register('SubagentStop', async () => ({ injectContext: 'fast' }));

    const dispatchPromise = dispatchSubagentStop(
      registry,
      { event: 'SubagentStop', subagentId: 'fast-subagent' },
      {},
    );

    // Advance only a little — should have already resolved.
    await vi.advanceTimersByTimeAsync(100);
    const decision = await dispatchPromise;

    expect(decision.injectContext).toBe('fast');
  });
});

// ---------------------------------------------------------------------------
// [R3 follow-up] Aggregate timeout — N handlers cannot compound to N × ceiling.
// ---------------------------------------------------------------------------
//
// External constraint: BackgroundAgentRegistry.cancelAll() must complete
// in bounded time. The per-handler timeout alone is insufficient — with N
// handlers each hanging, the dispatch loop would block for N ×
// HOOK_HANDLER_TIMEOUT_MS sequentially. dispatchSubagentStop wraps the whole
// call in an aggregate timeout to enforce the actual whole-teardown bound.
describe('[R3 follow-up] dispatchSubagentStop — aggregate timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds total dispatch time even when multiple handlers hang sequentially', async () => {
    const { dispatchSubagentStop } = await import('./subagent-hooks.js');
    const { createHookRegistryImpl: makeRegistry } = await import('./hook-registry.js');

    const registry = makeRegistry();
    // Register THREE never-resolving handlers. With per-handler-only bounds,
    // this would block for 3 × 30s = 90s. With the aggregate bound, it must
    // resolve within ~30s.
    registry.register('SubagentStop', () => new Promise<never>(() => {}));
    registry.register('SubagentStop', () => new Promise<never>(() => {}));
    registry.register('SubagentStop', () => new Promise<never>(() => {}));

    const dispatchPromise = dispatchSubagentStop(
      registry,
      { event: 'SubagentStop', subagentId: 'multi-hang' },
      {},
    );

    // Advance just past one timeout window — aggregate ceiling should fire.
    // (If only the per-handler timeout existed, we'd need 90s to clear.)
    await vi.advanceTimersByTimeAsync(31_000);

    const decision = await dispatchPromise;
    expect(decision).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// [R3 follow-up] Production observability — timeouts must surface without AFK_DEBUG.
// ---------------------------------------------------------------------------
//
// External constraint: daemon operators running headless can't enable
// AFK_DEBUG=1 retroactively after a stall happens. The timeout must surface
// to stderr unconditionally so a 30s teardown stall is always discoverable.
describe('[R3 follow-up] dispatchSubagentStop — production-visible timeout warn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a console.warn on timeout regardless of AFK_DEBUG state', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { dispatchSubagentStop } = await import('./subagent-hooks.js');
    const { createHookRegistryImpl: makeRegistry } = await import('./hook-registry.js');

    const registry = makeRegistry();
    registry.register('SubagentStop', () => new Promise<never>(() => {}));

    // Explicitly ensure AFK_DEBUG is OFF — the warning must fire anyway.
    const originalDebug = process.env['AFK_DEBUG'];
    delete process.env['AFK_DEBUG'];

    try {
      const dispatchPromise = dispatchSubagentStop(
        registry,
        { event: 'SubagentStop', subagentId: 'visible-timeout' },
        {},
      );

      await vi.advanceTimersByTimeAsync(31_000);
      await dispatchPromise;

      // Production-visible: at least one warn line referencing the timeout.
      const calls = warnSpy.mock.calls.map((args) => args.join(' '));
      const hasTimeoutWarn = calls.some(
        (msg) => msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('timed out'),
      );
      expect(hasTimeoutWarn).toBe(true);

      // And the subagent id must appear in the warn payload (operator
      // diagnostic — they need to know *which* subagent stalled).
      const hasSubagentId = calls.some((msg) => msg.includes('visible-timeout'));
      expect(hasSubagentId).toBe(true);
    } finally {
      if (originalDebug !== undefined) process.env['AFK_DEBUG'] = originalDebug;
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// [R3 follow-up] dispatch() defaults handlerTimeoutMs to HOOK_HANDLER_TIMEOUT_MS.
// ---------------------------------------------------------------------------
//
// Callers that omit the optional parameter must not silently get unbounded
// execution — the default must engage so any caller path through dispatch()
// is bounded by the documented ceiling.
describe('[R3 follow-up] dispatch() default handlerTimeoutMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies HOOK_HANDLER_TIMEOUT_MS when the caller omits handlerTimeoutMs', async () => {
    const registry = createHookRegistryImpl();
    registry.register('SubagentStop', () => new Promise<never>(() => {}));

    // Call dispatch() WITHOUT passing handlerTimeoutMs — must still be bounded.
    const dispatchPromise = registry
      .dispatch({ event: 'SubagentStop', subagentId: 'default-timeout' })
      .catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(HOOK_HANDLER_TIMEOUT_MS + 1_000);

    const result = await dispatchPromise;
    expect(result).toBeInstanceOf(HookHandlerTimeoutError);
  });

  it('supports Infinity to opt out of the per-handler bound (test/edge-case escape hatch)', async () => {
    const registry = createHookRegistryImpl();
    registry.register('SubagentStop', async () => ({ injectContext: 'unbounded' }));

    const decision = await registry.dispatch(
      { event: 'SubagentStop', subagentId: 'opt-out' },
      undefined,
      Infinity,
    );
    expect(decision.injectContext).toBe('unbounded');
  });
});

// ---------------------------------------------------------------------------
// [R3 follow-up] HookHandlerTimeoutError has a machine-readable `code`.
// ---------------------------------------------------------------------------
//
// `instanceof` checks fail under ESM/CJS dual-package hazard where the class
// identity differs between imports. The `code` property gives callers a
// string discriminator that survives the hazard.
describe('[R3 follow-up] HookHandlerTimeoutError discriminator', () => {
  it('exposes a stable `code` property for cross-module discrimination', () => {
    const err = new HookHandlerTimeoutError('SubagentStop', 30_000);
    expect(err.code).toBe('HOOK_HANDLER_TIMEOUT');
    // Survives an unknown-typed catch in callers that can't trust instanceof.
    const caught: unknown = err;
    if (caught && typeof caught === 'object' && 'code' in caught) {
      expect((caught as { code: string }).code).toBe('HOOK_HANDLER_TIMEOUT');
    } else {
      throw new Error('code discriminator missing on caught error');
    }
  });
});

// ---------------------------------------------------------------------------
// [R3 follow-up] dispatchSubagentStop swallows AbortError without throwing.
// ---------------------------------------------------------------------------
//
// External constraint: SubagentStop is non-blocking by contract. If the
// signal aborts mid-dispatch (e.g. parent shutdown racing the teardown
// hook), the dispatcher must still return cleanly — it must not propagate
// the AbortError up to BackgroundAgentRegistry.cancelAll() and stall the
// shutdown chain.
describe('[R3 follow-up] dispatchSubagentStop — abort mid-dispatch', () => {
  it('returns {} when the signal is already aborted before dispatch', async () => {
    const { dispatchSubagentStop } = await import('./subagent-hooks.js');
    const { createHookRegistryImpl: makeRegistry } = await import('./hook-registry.js');

    const registry = makeRegistry();
    let handlerRan = false;
    registry.register('SubagentStop', async () => {
      handlerRan = true;
      return {};
    });

    const ac = new AbortController();
    ac.abort(new Error('parent shutdown'));

    const decision = await dispatchSubagentStop(
      registry,
      { event: 'SubagentStop', subagentId: 'pre-aborted' },
      { signal: ac.signal },
    );

    expect(decision).toEqual({});
    // Pre-abort short-circuits before any handler runs.
    expect(handlerRan).toBe(false);
  });

  it('returns {} when the signal aborts while a handler is awaiting', async () => {
    vi.useFakeTimers();
    try {
      const { dispatchSubagentStop } = await import('./subagent-hooks.js');
      const { createHookRegistryImpl: makeRegistry } = await import('./hook-registry.js');

      const registry = makeRegistry();
      // Handler waits long enough that we can abort mid-flight.
      registry.register(
        'SubagentStop',
        () =>
          new Promise<{ injectContext: string }>((resolve) => {
            setTimeout(() => resolve({ injectContext: 'should-not-be-returned' }), 5_000);
          }),
      );

      const ac = new AbortController();
      const onError = vi.fn();
      const dispatchPromise = dispatchSubagentStop(
        registry,
        { event: 'SubagentStop', subagentId: 'mid-abort' },
        { signal: ac.signal, onError },
      );

      // Abort while the handler is awaiting.
      await vi.advanceTimersByTimeAsync(100);
      ac.abort(new Error('parent shutdown'));
      // Let the handler resolve so the abort check on the next iteration fires.
      await vi.advanceTimersByTimeAsync(5_000);

      const decision = await dispatchPromise;
      expect(decision).toEqual({});
      // The AbortError must be reported via onError, not swallowed silently.
      expect(onError).toHaveBeenCalled();
      const reportedErr = onError.mock.calls[0]?.[0];
      expect(reportedErr).toBeDefined();
      expect((reportedErr as Error).name).toBe('AbortError');
    } finally {
      vi.useRealTimers();
    }
  });
});
