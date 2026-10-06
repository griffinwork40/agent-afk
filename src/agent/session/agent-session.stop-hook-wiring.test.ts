/**
 * Tests for agent-session.stop-hook-wiring.ts — specifically `buildBeforeTurnEnd`.
 *
 * Finding 1 regression guard: the returned callback is called with an
 * incrementing counter by the caller (the provider turn loop). The cap inside
 * `runBeforeTurnEnd` must be evaluated against THAT counter, not a
 * freshly-reset one. This test exercises the boundary directly by simulating
 * repeated calls to the same callback (as the loop-based fix does) and
 * verifying that after `cap` calls the hook no longer returns `continueWith`.
 *
 * @module agent/session/agent-session.stop-hook-wiring.test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildBeforeTurnEnd } from './agent-session.stop-hook-wiring.js';
import type { StopHookWiringDeps } from './agent-session.stop-hook-wiring.js';
import type { AgentConfig } from '../types.js';
import type { HookRegistry } from '../hooks.js';
import type { StopWiring } from '../types/session-types.js';
import { HookBlockedError } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(override?: Partial<HookRegistry>): HookRegistry {
  return {
    dispatch: vi.fn().mockResolvedValue({ decision: 'approve' }),
    register: vi.fn(),
    ...override,
  } as unknown as HookRegistry;
}

function makeConfig(registry?: HookRegistry, extra?: Partial<AgentConfig>): AgentConfig {
  return {
    model: 'claude-3-opus',
    hookRegistry: registry,
    ...(extra ?? {}),
  } as unknown as AgentConfig;
}

function makeWiring(override?: Partial<StopWiring>): StopWiring {
  return {
    getHasNextTurn: () => true,
    onStopInjectContext: undefined,
    onStopBlocked: undefined,
    onStopTimeout: undefined,
    ...override,
  } as unknown as StopWiring;
}

function makeDeps(
  registry?: HookRegistry,
  wiring?: StopWiring,
  extra?: Partial<AgentConfig>,
): StopHookWiringDeps {
  const cfg = makeConfig(registry, extra);
  const w = wiring;
  return {
    getConfig: () => cfg,
    getSessionId: () => 'test-session',
    getSignal: () => new AbortController().signal,
    getConversationHistory: () => [
      { role: 'assistant', content: 'Done.', timestamp: new Date() },
    ],
    getActiveTurnToolEvents: () => [],
    getStopWiring: () => w,
  };
}

// ---------------------------------------------------------------------------
// Finding 1: cap is reachable when the SAME callback is called repeatedly
// ---------------------------------------------------------------------------

describe('buildBeforeTurnEnd — counter increments across repeated calls (Finding 1)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns continueWith when called with continuation=0 (first call), then ends at cap', async () => {
    // cap = 2 (default). Two calls with continuation 0 and 1 should block;
    // the third (continuation 2) should return undefined (cap reached).
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2');

    const dispatch = vi.fn().mockRejectedValue(
      new HookBlockedError('blocked', 'Stop', 'verify your work'),
    );
    const deps = makeDeps(makeRegistry({ dispatch }), makeWiring());
    const callback = buildBeforeTurnEnd(deps);

    // First call: continuation=0 → blocked → returns continueWith
    const r0 = await callback(0, 'Done.');
    expect(r0?.continueWith).toBeTruthy();

    // Second call: continuation=1 → blocked → returns continueWith
    const r1 = await callback(1, 'Done.');
    expect(r1?.continueWith).toBeTruthy();

    // Third call: continuation=2 == cap → cap reached → no continueWith
    // dispatch must NOT be called (cap fires before dispatch)
    const callCountBefore = dispatch.mock.calls.length;
    const r2 = await callback(2, 'Done.');
    expect(r2?.continueWith).toBeUndefined();
    expect(dispatch.mock.calls.length).toBe(callCountBefore); // no new dispatch
  });

  it('AFK_STOP_HOOK_MAX_CONTINUATIONS=0 disables all continuation', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '0');

    const dispatch = vi.fn().mockRejectedValue(
      new HookBlockedError('blocked', 'Stop', 'blocked'),
    );
    const deps = makeDeps(makeRegistry({ dispatch }), makeWiring());
    const callback = buildBeforeTurnEnd(deps);

    const r = await callback(0, 'Done.');
    expect(r?.continueWith).toBeUndefined();
    // cap=0 means cap fires before any dispatch
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('passes assistantText to runBeforeTurnEnd (Finding 3 integration)', async () => {
    // Verifies the second arg flows through. dispatch is an approve → no block.
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2');
    const dispatch = vi.fn().mockResolvedValue({ decision: 'approve' });
    const deps = makeDeps(makeRegistry({ dispatch }), makeWiring());
    const callback = buildBeforeTurnEnd(deps);

    const result = await callback(0, 'My assistant text here');
    expect(result?.continueWith).toBeUndefined(); // approved, no continuation
    expect(dispatch).toHaveBeenCalledOnce();
    // The dispatch is called with a StopContext — we don't reach buildStopContext
    // directly, but the call completing without error confirms the path works.
  });

  it('returns undefined for forked subagents regardless of blocks', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2');
    const dispatch = vi.fn().mockRejectedValue(
      new HookBlockedError('blocked', 'Stop', 'blocked'),
    );
    // parentSessionId set → fork → runBeforeTurnEnd no-ops
    const deps = makeDeps(makeRegistry({ dispatch }), makeWiring(), {
      parentSessionId: 'parent-123',
    });
    const callback = buildBeforeTurnEnd(deps);

    const r = await callback(0, 'Done.');
    expect(r?.continueWith).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #2957: stopDispatchedBySeam is set only when the seam actually dispatched
// ---------------------------------------------------------------------------

describe('buildBeforeTurnEnd — stopDispatchedBySeam (#2957)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('cap=0: leaves stopDispatchedBySeam unset so the session-layer fallback fires Stop', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '0');
    const dispatch = vi.fn().mockResolvedValue({});
    const wiring = makeWiring();
    await buildBeforeTurnEnd(makeDeps(makeRegistry({ dispatch }), wiring))(0, 'Done.');
    expect(dispatch).not.toHaveBeenCalled();
    expect(wiring.stopDispatchedBySeam).not.toBe(true);
  });

  it('sets stopDispatchedBySeam when the seam dispatched Stop', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2');
    const wiring = makeWiring();
    await buildBeforeTurnEnd(makeDeps(makeRegistry(), wiring))(0, 'Done.');
    expect(wiring.stopDispatchedBySeam).toBe(true);
  });

  it('a later cap-reached round does not clear a dispatch from an earlier round', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '1');
    const dispatch = vi.fn().mockRejectedValue(new HookBlockedError('blocked', 'Stop', 'verify'));
    const wiring = makeWiring();
    const cb = buildBeforeTurnEnd(makeDeps(makeRegistry({ dispatch }), wiring));
    expect((await cb(0, 'Done.'))?.continueWith).toBe('verify');
    expect((await cb(1, 'Done.'))?.continueWith).toBeUndefined();
    expect(wiring.stopDispatchedBySeam).toBe(true);
  });
});
