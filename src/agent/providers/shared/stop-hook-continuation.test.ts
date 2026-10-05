/**
 * Tests for stop-hook-continuation.ts — the provider-side seam that turns
 * a blocking Stop hook into a same-turn continuation (issue #2714).
 *
 * Coverage:
 *   - A block returns `continueWith` and increments the counter.
 *   - Reaching the cap returns undefined and does NOT call dispatch.
 *   - AFK_STOP_HOOK_MAX_CONTINUATIONS=0 disables continuation entirely.
 *   - A non-blocking Stop pass-through returns undefined.
 *   - injectContext from a passing Stop hook is delivered via wiring.
 *   - `stopHookActive: true` appears on StopContext from the second dispatch.
 *   - `continuation` field increments correctly on StopContext.
 *   - AbortError propagates.
 *
 * @module agent/providers/shared/stop-hook-continuation.test
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runBeforeTurnEnd, resolveMaxContinuations } from './stop-hook-continuation.js';
import type { BeforeTurnEndContext } from './stop-hook-continuation.js';
import type { AgentConfig } from '../../types.js';
import type { HookRegistry } from '../../hooks.js';
import { HookBlockedError, AbortError } from '../../../utils/errors.js';

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
    // no parentSessionId → top-level session
    ...(extra ?? {}),
  } as unknown as AgentConfig;
}

function makeCtx(overrides?: Partial<BeforeTurnEndContext>): BeforeTurnEndContext {
  return {
    config: makeConfig(makeRegistry()),
    sessionId: 'test-session',
    signal: new AbortController().signal,
    messages: [{ role: 'assistant', content: 'Done.', timestamp: new Date() }],
    toolEvents: [],
    hasNextTurn: true,
    wiring: undefined,
    continuation: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveMaxContinuations
// ---------------------------------------------------------------------------

describe('resolveMaxContinuations', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('defaults to 2 when var is unset', () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', undefined as unknown as string);
    expect(resolveMaxContinuations()).toBe(2);
  });

  it('returns 0 when set to 0 (disable)', () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '0');
    expect(resolveMaxContinuations()).toBe(0);
  });

  it('parses positive integers', () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '5');
    expect(resolveMaxContinuations()).toBe(5);
  });

  it('falls back to default on non-numeric value', () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', 'banana');
    expect(resolveMaxContinuations()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runBeforeTurnEnd — non-blocking pass-through
// ---------------------------------------------------------------------------

describe('runBeforeTurnEnd — pass-through', () => {
  beforeEach(() => { vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns noop when no hookRegistry is configured', async () => {
    const ctx = makeCtx({ config: makeConfig(undefined) });
    const result = await runBeforeTurnEnd(ctx);
    expect(result.continueWith).toBeUndefined();
    expect(result.nextContinuation).toBe(0);
  });

  it('returns noop for forked subagents (parentSessionId set)', async () => {
    const dispatch = vi.fn().mockResolvedValue({ decision: 'approve' });
    const ctx = makeCtx({
      config: makeConfig(makeRegistry({ dispatch }), { parentSessionId: 'parent-123' }),
    });
    const result = await runBeforeTurnEnd(ctx);
    expect(result.continueWith).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('passes through when hook approves', async () => {
    const dispatch = vi.fn().mockResolvedValue({ decision: 'approve' });
    const ctx = makeCtx({ config: makeConfig(makeRegistry({ dispatch })) });
    const result = await runBeforeTurnEnd(ctx);
    expect(result.continueWith).toBeUndefined();
    expect(result.nextContinuation).toBe(0);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('delivers injectContext via wiring when hook passes with context', async () => {
    const dispatch = vi.fn().mockResolvedValue({ injectContext: 'some context note' });
    const onStopInjectContext = vi.fn();
    const ctx = makeCtx({
      config: makeConfig(makeRegistry({ dispatch })),
      wiring: { onStopInjectContext },
    });
    const result = await runBeforeTurnEnd(ctx);
    expect(result.continueWith).toBeUndefined();
    expect(onStopInjectContext).toHaveBeenCalledWith('some context note');
  });
});

// ---------------------------------------------------------------------------
// runBeforeTurnEnd — block → continuation
// ---------------------------------------------------------------------------

describe('runBeforeTurnEnd — block triggers continuation', () => {
  beforeEach(() => { vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns continueWith when hook blocks (first continuation)', async () => {
    const dispatch = vi.fn().mockRejectedValue(
      new HookBlockedError('blocked', 'Stop', 'verify your work'),
    );
    const ctx = makeCtx({ config: makeConfig(makeRegistry({ dispatch })), continuation: 0 });
    const result = await runBeforeTurnEnd(ctx);
    expect(result.continueWith).toBe('verify your work');
    expect(result.nextContinuation).toBe(1);
  });

  it('returns continueWith on second block (continuation 1 → 2)', async () => {
    const dispatch = vi.fn().mockRejectedValue(
      new HookBlockedError('blocked', 'Stop', 'still unverified'),
    );
    const ctx = makeCtx({ config: makeConfig(makeRegistry({ dispatch })), continuation: 1 });
    const result = await runBeforeTurnEnd(ctx);
    expect(result.continueWith).toBe('still unverified');
    expect(result.nextContinuation).toBe(2);
  });

  it('sets stopHookActive: true on StopContext from second dispatch onward', async () => {
    const dispatch = vi.fn().mockRejectedValue(
      new HookBlockedError('blocked', 'Stop', 'blocked reason'),
    );
    const ctx = makeCtx({
      config: makeConfig(makeRegistry({ dispatch })),
      continuation: 1, // second dispatch → stopHookActive must be true
    });
    await runBeforeTurnEnd(ctx);
    const calledCtx = (dispatch.mock.calls[0] as [unknown, ...unknown[]])[0];
    expect((calledCtx as Record<string, unknown>)?.stopHookActive).toBe(true);
    expect((calledCtx as Record<string, unknown>)?.continuation).toBe(1);
  });

  it('first dispatch has stopHookActive: undefined and continuation: 0', async () => {
    const dispatch = vi.fn().mockRejectedValue(
      new HookBlockedError('blocked', 'Stop', 'blocked reason'),
    );
    const ctx = makeCtx({ config: makeConfig(makeRegistry({ dispatch })), continuation: 0 });
    await runBeforeTurnEnd(ctx);
    const calledCtx = (dispatch.mock.calls[0] as [unknown, ...unknown[]])[0];
    expect((calledCtx as Record<string, unknown>)?.stopHookActive).toBeUndefined();
    expect((calledCtx as Record<string, unknown>)?.continuation).toBe(0);
  });

  it('uses fallback text when HookBlockedError has no explicit reason', async () => {
    // No reason arg → HookBlockedError.reason is undefined → fallback message
    const dispatch = vi.fn().mockRejectedValue(new HookBlockedError('blocked', 'Stop'));
    const ctx = makeCtx({ config: makeConfig(makeRegistry({ dispatch })), continuation: 0 });
    const result = await runBeforeTurnEnd(ctx);
    // Should still set continueWith (fallback message)
    expect(result.continueWith).toBeTruthy();
    expect(result.nextContinuation).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runBeforeTurnEnd — cap enforcement
// ---------------------------------------------------------------------------

describe('runBeforeTurnEnd — cap enforcement', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('ends turn normally when continuation reaches the cap', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2');
    const dispatch = vi.fn().mockRejectedValue(new HookBlockedError('blocked', 'Stop', 'reason'));
    // continuation=2 is AT the cap (cap=2) → no more continuations
    const ctx = makeCtx({
      config: makeConfig(makeRegistry({ dispatch })),
      continuation: 2,
    });
    const result = await runBeforeTurnEnd(ctx);
    expect(result.continueWith).toBeUndefined();
    // dispatch must NOT be called — the cap check fires before dispatch
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('AFK_STOP_HOOK_MAX_CONTINUATIONS=0 disables all continuation', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '0');
    const dispatch = vi.fn().mockRejectedValue(new HookBlockedError('blocked', 'Stop', 'reason'));
    const ctx = makeCtx({ config: makeConfig(makeRegistry({ dispatch })), continuation: 0 });
    const result = await runBeforeTurnEnd(ctx);
    expect(result.continueWith).toBeUndefined();
    // cap=0 → continuation(0)>=0 → cap hit, dispatch skipped
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('AFK_STOP_HOOK_MAX_CONTINUATIONS=1 allows exactly one continuation', async () => {
    vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '1');
    const dispatch = vi.fn().mockRejectedValue(new HookBlockedError('blocked', 'Stop', 'reason'));
    // continuation=0 < cap=1 → allowed
    const ctx0 = makeCtx({ config: makeConfig(makeRegistry({ dispatch })), continuation: 0 });
    const r0 = await runBeforeTurnEnd(ctx0);
    expect(r0.continueWith).toBeTruthy();

    // continuation=1 == cap=1 → not allowed
    const ctx1 = makeCtx({ config: makeConfig(makeRegistry({ dispatch })), continuation: 1 });
    const r1 = await runBeforeTurnEnd(ctx1);
    expect(r1.continueWith).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runBeforeTurnEnd — abort propagation
// ---------------------------------------------------------------------------

describe('runBeforeTurnEnd — abort propagation', () => {
  beforeEach(() => { vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('AbortError propagates through', async () => {
    const dispatch = vi.fn().mockRejectedValue(new AbortError('stop hook aborted'));
    const ctx = makeCtx({ config: makeConfig(makeRegistry({ dispatch })) });
    await expect(runBeforeTurnEnd(ctx)).rejects.toBeInstanceOf(AbortError);
  });
});

// ---------------------------------------------------------------------------
// runBeforeTurnEnd — Finding 3: assistantText takes precedence over messages
// ---------------------------------------------------------------------------

describe('runBeforeTurnEnd — assistantText overrides stale history (Finding 3)', () => {
  beforeEach(() => { vi.stubEnv('AFK_STOP_HOOK_MAX_CONTINUATIONS', '2'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uses assistantText when provided instead of scanning messages', async () => {
    // Set up: messages have stale assistant content (does NOT parse as Done);
    // assistantText has the real just-finished turn (DOES parse as Done).
    // Verify the StopContext passed to dispatch has terminalState:'done', which
    // means buildStopContext read assistantText, not the stale history.
    const dispatch = vi.fn().mockResolvedValue({ decision: 'approve' });
    const staleMessages = [
      { role: 'assistant', content: 'still working...', timestamp: new Date() },
    ] as const;
    // A text that parseTerminalState recognises as done:
    const freshAssistantText = 'All done.\n\n**Done**\n- What was done: task finished';

    const ctx = makeCtx({
      config: makeConfig(makeRegistry({ dispatch })),
      messages: staleMessages as unknown as BeforeTurnEndContext['messages'],
      assistantText: freshAssistantText,
      continuation: 0,
    });
    await runBeforeTurnEnd(ctx);

    expect(dispatch).toHaveBeenCalledOnce();
    const calledCtx = (dispatch.mock.calls[0] as [unknown, ...unknown[]])[0];
    // buildStopContext uses assistantText → terminalState is 'done'
    expect((calledCtx as Record<string, unknown>).terminalState).toBe('done');
  });

  it('falls back to lastAssistantText(messages) when assistantText is not provided', async () => {
    // assistantText absent → buildStopContext scans messages for last assistant text.
    // Messages contain a Done turn → dispatch sees terminalState:'done'.
    const dispatch = vi.fn().mockResolvedValue({ decision: 'approve' });
    const messagesWithDone = [
      { role: 'assistant', content: 'Done.\n\n**Done**\n- task: finished', timestamp: new Date() },
    ] as const;
    const ctx = makeCtx({
      config: makeConfig(makeRegistry({ dispatch })),
      messages: messagesWithDone as unknown as BeforeTurnEndContext['messages'],
      // no assistantText field
      continuation: 0,
    });
    await runBeforeTurnEnd(ctx);

    expect(dispatch).toHaveBeenCalledOnce();
    const calledCtx = (dispatch.mock.calls[0] as [unknown, ...unknown[]])[0];
    expect((calledCtx as Record<string, unknown>).terminalState).toBe('done');
  });

  it('stale messages with non-Done text are overridden by Done assistantText', async () => {
    // Without Finding 3 fix, this test would fail: the stale 'working...' text
    // in messages would cause terminalState to be absent (not 'done'), but the
    // freshAssistantText IS done.
    const dispatch = vi.fn().mockResolvedValue({ decision: 'approve' });
    const staleMessages = [
      { role: 'assistant', content: 'working...', timestamp: new Date() },
    ] as const;
    const freshAssistantText = 'Finished.\n\n**Done**\n- What was done: it is done';

    const ctx = makeCtx({
      config: makeConfig(makeRegistry({ dispatch })),
      messages: staleMessages as unknown as BeforeTurnEndContext['messages'],
      assistantText: freshAssistantText,
      continuation: 0,
    });
    await runBeforeTurnEnd(ctx);

    const calledCtx = (dispatch.mock.calls[0] as [unknown, ...unknown[]])[0];
    // Must be 'done' (from fresh text), not absent (from stale messages)
    expect((calledCtx as Record<string, unknown>).terminalState).toBe('done');
  });
});
