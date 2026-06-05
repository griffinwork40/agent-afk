/**
 * Tests for the module-scope elicitation router.
 *
 * The router is a tiny registry: the interactive CLI (or a bridge) installs
 * a handler at session-start; `buildQueryOptions` threads
 * `options.onElicitation` into a router-lookup shim, so whichever handler
 * is currently installed answers the SDK's elicitation request.
 *
 * Invariants pinned here:
 *   - No handler installed → auto-decline (SDK's documented default).
 *   - Handler rejection → auto-decline (don't hang).
 *   - No time-based deadline; abort is the sole non-handler unblock path
 *     (and it rescues even a handler that ignores its own signal).
 *   - uninstall() reverts to default.
 *   - Install is idempotent and last-wins.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { ElicitationRequest, ElicitationResult } from './types/sdk-types.js';
import { elicitationRouter } from './elicitation-router.js';

const NO_SIGNAL = new AbortController().signal;

const URL_REQUEST: ElicitationRequest = {
  serverName: 'supabase',
  message: 'Sign in with Supabase to continue',
  mode: 'url',
  url: 'https://supabase.example/oauth/abc',
  elicitationId: 'el-1',
};

describe('elicitationRouter', () => {
  beforeEach(() => {
    elicitationRouter.uninstall();
  });

  afterEach(() => {
    elicitationRouter.uninstall();
  });

  it('auto-declines when no handler is installed', async () => {
    const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(result.action).toBe('decline');
  });

  it('forwards to the installed handler and returns its result', async () => {
    const accepted: ElicitationResult = { action: 'accept' };
    const handler = vi.fn().mockResolvedValue(accepted);
    elicitationRouter.install(handler);

    const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(handler).toHaveBeenCalledWith(URL_REQUEST, expect.any(Object));
    expect(result).toEqual(accepted);
  });

  it('has no time-based deadline — a pending question is unblocked only by abort', async () => {
    const controller = new AbortController();
    // Handler that never settles and never observes its signal. Before the
    // timer was removed, the 5-minute deadline would eventually decline this;
    // now the router's abort race is the only thing that can unblock it.
    elicitationRouter.install(() => new Promise<ElicitationResult>(() => { /* never */ }));

    const p = elicitationRouter.route(URL_REQUEST, { signal: controller.signal });
    let settled = false;
    void p.then(() => { settled = true; });

    // No timer in the router → nothing resolves the question on its own,
    // well past any window the old 20ms-ish test deadline would have fired in.
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(elicitationRouter.pendingCount()).toBe(1);

    // Abort rescues even a handler that ignores its own signal.
    controller.abort();
    expect((await p).action).toBe('decline');
    expect(elicitationRouter.pendingCount()).toBe(0);
  });

  it('auto-declines on handler rejection rather than propagating', async () => {
    elicitationRouter.install(() => Promise.reject(new Error('user cancelled')));
    const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(result.action).toBe('decline');
  });

  it('auto-declines on synchronous handler throw — resultPromise never hangs', async () => {
    // Regression: BLK-1 from PR #451 review. A non-async handler that throws
    // synchronously bypasses the inner `.catch(() => DECLINE)` (which only
    // catches promise rejections). Before the outer-finally safety net was
    // added, this case let resultPromise hang forever because the outer
    // `.catch(() => {})` on the queue chain swallowed the throw without
    // calling resolveResult.
    elicitationRouter.install(((() => {
      throw new Error('synchronous boom');
    }) as unknown) as Parameters<typeof elicitationRouter.install>[0]);
    const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(result.action).toBe('decline');
    expect(elicitationRouter.pendingCount()).toBe(0);
  });

  it('uninstall() reverts to the auto-decline default', async () => {
    elicitationRouter.install(vi.fn().mockResolvedValue({ action: 'accept' } as ElicitationResult));
    elicitationRouter.uninstall();
    const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(result.action).toBe('decline');
  });

  it('install is idempotent — last install wins', async () => {
    const a = vi.fn().mockResolvedValue({ action: 'decline' } as ElicitationResult);
    const b = vi.fn().mockResolvedValue({ action: 'accept' } as ElicitationResult);
    elicitationRouter.install(a);
    elicitationRouter.install(b);

    const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(result.action).toBe('accept');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('respects an externally-aborted signal by declining', async () => {
    const controller = new AbortController();
    controller.abort();
    elicitationRouter.install(vi.fn().mockResolvedValue({ action: 'accept' } as ElicitationResult));
    const result = await elicitationRouter.route(URL_REQUEST, { signal: controller.signal });
    expect(result.action).toBe('decline');
  });

  describe('serial queue', () => {
    it('resolves requests in enqueue order — second never starts before first finishes', async () => {
      const order: number[] = [];
      let resolveFirst!: () => void;
      const firstDone = new Promise<void>((res) => { resolveFirst = res; });

      elicitationRouter.install(async (_req, _opts) => {
        order.push(1);
        await firstDone;
        order.push(1.5);
        return { action: 'accept' };
      });

      const p1 = elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });

      let secondHandlerCalled = false;
      elicitationRouter.install(async () => {
        secondHandlerCalled = true;
        order.push(2);
        return { action: 'decline' };
      });

      const p2 = elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });

      expect(secondHandlerCalled).toBe(false);

      resolveFirst();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.action).toBe('accept');
      expect(r2.action).toBe('decline');
      expect(order).toEqual([1, 1.5, 2]);
    });

    it('abort-during-queue: aborted signal auto-declines without dispatching handler', async () => {
      let resolveBlock!: () => void;
      const block = new Promise<void>((res) => { resolveBlock = res; });
      const handler = vi.fn().mockImplementation(async () => {
        await block;
        return { action: 'accept' };
      });
      elicitationRouter.install(handler);

      const controller = new AbortController();
      const p1 = elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
      const p2 = elicitationRouter.route(URL_REQUEST, { signal: controller.signal });

      controller.abort();
      resolveBlock();
      await p1;
      const r2 = await p2;

      expect(r2.action).toBe('decline');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('pendingCount() increments during overlap and returns 0 after both resolve', async () => {
      let resolveFirst!: () => void;
      const firstDone = new Promise<void>((res) => { resolveFirst = res; });

      elicitationRouter.install(async () => {
        await firstDone;
        return { action: 'accept' };
      });

      expect(elicitationRouter.pendingCount()).toBe(0);

      const p1 = elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
      expect(elicitationRouter.pendingCount()).toBe(1);

      const p2 = elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
      expect(elicitationRouter.pendingCount()).toBe(2);

      resolveFirst();
      await Promise.all([p1, p2]);

      expect(elicitationRouter.pendingCount()).toBe(0);
    });
  });
});
