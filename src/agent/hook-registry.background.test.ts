/**
 * Background lane for SessionEnd hooks (`RegisterOptions.background`).
 *
 * Pins the contract that keeps `/clear` fast: a background handler is not
 * awaited by `dispatch()`, cannot block or inject, runs serialized with its
 * siblings, and is awaited only via `drainBackground()`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHookRegistry } from './hook-registry.js';
import type { HookContext } from './hooks.js';

const END: HookContext = { event: 'SessionEnd', sessionId: 's1', reason: 'reset' };

/** A promise plus its resolver, for holding a handler open. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

describe('HookRegistry background lane', () => {
  it('dispatch() resolves without awaiting a background handler; drainBackground() awaits it', async () => {
    const registry = createHookRegistry();
    const g = gate();
    let finished = false;
    registry.register('SessionEnd', async () => { await g.promise; finished = true; return {}; }, { background: true });

    await registry.dispatch(END);
    expect(finished).toBe(false);

    let drained = false;
    const drain = registry.drainBackground!().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    g.open();
    await drain;
    expect(finished).toBe(true);
  });

  it('still runs foreground handlers in order and returns their decision', async () => {
    const registry = createHookRegistry();
    const order: string[] = [];
    registry.register('SessionEnd', () => { order.push('fg1'); return { reason: 'a' }; });
    registry.register('SessionEnd', () => { order.push('bg'); return { decision: 'block', reason: 'ignored' }; }, { background: true });
    registry.register('SessionEnd', () => { order.push('fg2'); return {}; });

    // A background block must neither throw nor surface in the decision. The
    // background run may interleave anywhere after enqueue (microtask), so
    // only the foreground relative order is asserted.
    const decision = await registry.dispatch(END);
    expect(decision).toEqual({ reason: 'a' });
    await registry.drainBackground!();
    expect(order.filter((o) => o !== 'bg')).toEqual(['fg1', 'fg2']);
    expect(order.filter((o) => o === 'bg')).toHaveLength(1);
  });

  it('serializes background runs across dispatches (no overlap)', async () => {
    const registry = createHookRegistry();
    let active = 0;
    let maxActive = 0;
    const runs: string[] = [];
    registry.register('SessionEnd', async (ctx) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      runs.push(ctx.event === 'SessionEnd' ? (ctx.sessionId ?? '') : '');
      active--;
      return {};
    }, { background: true });

    await registry.dispatch({ ...END, sessionId: 'first' });
    await registry.dispatch({ ...END, sessionId: 'second' });
    await registry.drainBackground!();
    expect(runs).toEqual(['first', 'second']);
    expect(maxActive).toBe(1);
  });

  it('a throwing background handler neither rejects dispatch/drain nor stops later runs', async () => {
    const registry = createHookRegistry();
    const after = vi.fn(() => ({}));
    registry.register('SessionEnd', () => { throw new Error('boom'); }, { background: true });
    registry.register('SessionEnd', after, { background: true });

    await expect(registry.dispatch(END)).resolves.toEqual({});
    await expect(registry.drainBackground!()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung background handler by the per-handler timeout', async () => {
    const registry = createHookRegistry();
    registry.register('SessionEnd', () => new Promise(() => {}), { background: true });
    await registry.dispatch(END, undefined, 10);
    await expect(registry.drainBackground!()).resolves.toBeUndefined();
  });

  it('drainBackground() resolves immediately when nothing was queued', async () => {
    await expect(createHookRegistry().drainBackground!()).resolves.toBeUndefined();
  });

  it('rejects background registration for events other than SessionEnd', () => {
    const registry = createHookRegistry();
    expect(() => registry.register('PreToolUse', () => ({}), { background: true })).toThrow(TypeError);
    expect(registry.count('PreToolUse')).toBe(0);
  });
});
