/**
 * Unit tests for the harness HookRegistry.
 *
 * Covers:
 * - register / unsubscribe / count
 * - sequential dispatch order
 * - first-block-wins short-circuit (continue:false AND decision:'block')
 * - fail-safe error wrapping (handler throw → HookBlockedError)
 * - abort precedence: pre-dispatch and mid-dispatch
 * - discriminated-context narrowing (compile-time)
 */

import { describe, it, expect, vi } from 'vitest';
import { AbortError, HookBlockedError } from '../utils/errors.js';
import { createHookRegistry } from './hooks.js';
import { dispatchSubagentStop } from './subagent-hooks.js';
import type {
  HookContext,
  HookHandler,
  PreToolUseContext,
  SessionStartContext,
  SubagentStopContext,
} from './hooks.js';

function sessionStartCtx(sessionId = 'sess-1'): SessionStartContext {
  return { event: 'SessionStart', sessionId };
}

function preToolCtx(toolName = 'Bash', input: unknown = {}): PreToolUseContext {
  return { event: 'PreToolUse', toolName, input, sessionId: 'sess-1' };
}

describe('HookRegistry — registration', () => {
  it('register returns an unsubscribe function that removes the handler', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn<HookHandler>(async () => ({}));
    const unsubscribe = registry.register('SessionStart', handler);

    expect(registry.count('SessionStart')).toBe(1);

    await registry.dispatch(sessionStartCtx());
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(registry.count('SessionStart')).toBe(0);

    await registry.dispatch(sessionStartCtx());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('count reflects per-event handler totals', () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', async () => ({}));
    registry.register('SessionStart', async () => ({}));
    registry.register('SessionEnd', async () => ({}));
    expect(registry.count('SessionStart')).toBe(2);
    expect(registry.count('SessionEnd')).toBe(1);
    expect(registry.count('PreToolUse')).toBe(0);
  });

  it('dispatch with no registered handlers resolves to an empty decision', async () => {
    const registry = createHookRegistry();
    const decision = await registry.dispatch(sessionStartCtx());
    expect(decision).toEqual({});
  });
});

describe('HookRegistry — ordering and short-circuit', () => {
  it('fires handlers sequentially in registration order', async () => {
    const registry = createHookRegistry();
    const calls: string[] = [];
    registry.register('SessionStart', async () => {
      calls.push('a');
      return {};
    });
    registry.register('SessionStart', async () => {
      calls.push('b');
      return {};
    });
    registry.register('SessionStart', async () => {
      calls.push('c');
      return {};
    });

    await registry.dispatch(sessionStartCtx());
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('short-circuits on continue:false — subsequent handlers do not fire', async () => {
    const registry = createHookRegistry();
    const a = vi.fn<HookHandler>(async () => ({}));
    const b = vi.fn<HookHandler>(async () => ({ continue: false, reason: 'policy-halt' }));
    const c = vi.fn<HookHandler>(async () => ({}));
    registry.register('SessionStart', a);
    registry.register('SessionStart', b);
    registry.register('SessionStart', c);

    await expect(registry.dispatch(sessionStartCtx())).rejects.toBeInstanceOf(HookBlockedError);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).not.toHaveBeenCalled();
  });

  it("short-circuits on decision:'block' — subsequent handlers do not fire", async () => {
    const registry = createHookRegistry();
    const a = vi.fn<HookHandler>(async () => ({}));
    const b = vi.fn<HookHandler>(async () => ({ decision: 'block', reason: 'bad-tool' }));
    const c = vi.fn<HookHandler>(async () => ({}));
    registry.register('PreToolUse', a);
    registry.register('PreToolUse', b);
    registry.register('PreToolUse', c);

    const err = await registry.dispatch(preToolCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(HookBlockedError);
    expect((err as HookBlockedError).event).toBe('PreToolUse');
    expect((err as HookBlockedError).reason).toBe('bad-tool');
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(c).not.toHaveBeenCalled();
  });

  it('approve / continue:true are non-blocking', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', async () => ({ continue: true }));
    registry.register('SessionStart', async () => ({ decision: 'approve' }));
    const after = vi.fn<HookHandler>(async () => ({}));
    registry.register('SessionStart', after);

    await registry.dispatch(sessionStartCtx());
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('HookRegistry — fail-safe error wrapping', () => {
  it('handler throw is wrapped in HookBlockedError and short-circuits', async () => {
    const registry = createHookRegistry();
    const boom = new Error('kaboom');
    const a = vi.fn<HookHandler>(async () => {
      throw boom;
    });
    const b = vi.fn<HookHandler>(async () => ({}));
    registry.register('SessionStart', a);
    registry.register('SessionStart', b);

    const err = await registry.dispatch(sessionStartCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(HookBlockedError);
    expect((err as HookBlockedError).event).toBe('SessionStart');
    expect((err as HookBlockedError).cause).toBe(boom);
    expect(b).not.toHaveBeenCalled();
  });

  it('synchronous handler throw is wrapped just like async throw', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => {
      throw new TypeError('sync-bang');
    });

    const err = await registry.dispatch(sessionStartCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(HookBlockedError);
    expect(((err as HookBlockedError).cause as Error).message).toBe('sync-bang');
  });
});

describe('HookRegistry — abort precedence', () => {
  it('pre-dispatch: already-aborted signal throws AbortError; no handler fires', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn<HookHandler>(async () => ({}));
    registry.register('SessionStart', handler);

    const controller = new AbortController();
    controller.abort('pre-aborted');

    const err = await registry.dispatch(sessionStartCtx(), controller.signal).catch((e) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('mid-dispatch: signal fires during handler A → handler B does not fire, AbortError surfaces', async () => {
    const registry = createHookRegistry();
    const controller = new AbortController();
    const b = vi.fn<HookHandler>(async () => ({}));

    registry.register('SessionStart', async () => {
      // Simulate a handler that takes time, during which abort fires.
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort('mid-dispatch');
      // Even if this handler finished "normally", dispatch must re-check signal
      // after the await and throw AbortError before invoking B.
      return {};
    });
    registry.register('SessionStart', b);

    const err = await registry.dispatch(sessionStartCtx(), controller.signal).catch((e) => e);
    expect(err).toBeInstanceOf(AbortError);
    expect(b).not.toHaveBeenCalled();
  });

  it('abort takes precedence over a blocking decision from a handler', async () => {
    const registry = createHookRegistry();
    const controller = new AbortController();
    registry.register('SessionStart', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort('shutdown');
      return { decision: 'block', reason: 'would-block-but-aborted-first' };
    });

    const err = await registry.dispatch(sessionStartCtx(), controller.signal).catch((e) => e);
    // Abort wins — not HookBlockedError from the decision.
    expect(err).toBeInstanceOf(AbortError);
  });

  it('dispatch without a signal is permitted and does not throw abort', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn<HookHandler>(async () => ({}));
    registry.register('SessionStart', handler);
    await registry.dispatch(sessionStartCtx());
    expect(handler).toHaveBeenCalled();
  });
});

describe('HookContext — discriminated union narrowing', () => {
  it('narrows to event-specific shape when switching on event', () => {
    const describe = (ctx: HookContext): string => {
      switch (ctx.event) {
        case 'SessionStart':
          return `start:${ctx.sessionId ?? '-'}`;
        case 'SessionEnd':
          return `end:${ctx.sessionId ?? '-'}`;
        case 'SubagentStart':
          return `sub-start:${ctx.subagentId}`;
        case 'SubagentStop':
          return `sub-stop:${ctx.subagentId}:${ctx.status}`;
        case 'PreToolUse':
          return `pre:${ctx.toolName}`;
        case 'PostToolUse':
          return `post:${ctx.toolName}`;
      }
    };

    const stop: SubagentStopContext = {
      event: 'SubagentStop',
      subagentId: 'sub-1',
      status: 'succeeded',
    };
    expect(describe(stop)).toBe('sub-stop:sub-1:succeeded');
    expect(describe(preToolCtx('Edit'))).toBe('pre:Edit');
    expect(describe(sessionStartCtx('s-99'))).toBe('start:s-99');
  });
});

describe('dispatchSubagentStop — return value', () => {
  it('returns the last handler decision including injectContext', async () => {
    const registry = createHookRegistry();

    registry.register('SubagentStop', async () => ({
      injectContext: 'verify: output looks suspicious',
    }));

    const decision = await dispatchSubagentStop(registry, {
      event: 'SubagentStop',
      subagentId: 'sub-1',
      status: 'succeeded',
    });

    expect(decision).toEqual({
      injectContext: 'verify: output looks suspicious',
    });
  });

  it('returns empty object when no handlers registered', async () => {
    const registry = createHookRegistry();

    const decision = await dispatchSubagentStop(registry, {
      event: 'SubagentStop',
      subagentId: 'sub-1',
      status: 'succeeded',
    });

    expect(decision).toEqual({});
  });

  it('returns empty object when handler throws (error swallowed)', async () => {
    const registry = createHookRegistry();

    registry.register('SubagentStop', async () => {
      throw new Error('handler kaboom');
    });

    const decision = await dispatchSubagentStop(registry, {
      event: 'SubagentStop',
      subagentId: 'sub-1',
      status: 'succeeded',
    });

    expect(decision).toEqual({});
  });

  it('block decision from handler is swallowed, returns empty object', async () => {
    const registry = createHookRegistry();

    registry.register('SubagentStop', async () => ({
      decision: 'block',
      reason: 'policy-block',
      injectContext: 'verify: blocked by policy',
    }));

    const decision = await dispatchSubagentStop(registry, {
      event: 'SubagentStop',
      subagentId: 'sub-1',
      status: 'succeeded',
    });

    // Block decision is swallowed for SubagentStop (non-blocking), and we return empty
    // because the error prevents us from capturing the decision object.
    expect(decision).toEqual({});
  });
});
