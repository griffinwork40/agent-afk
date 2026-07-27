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

// Mock the Telegram push primitive so park-and-notify can be asserted without
// touching the network. Hoisted above the router import below.
vi.mock('../telegram/push.js', () => ({
  pushIfConfigured: vi.fn().mockResolvedValue(null),
}));

// Mock the presence writer so the blocked-marker lifecycle can be asserted as
// an ordered call log without touching the filesystem. Hoisted above the
// router import below.
vi.mock('./awareness/presence.js', () => ({
  setPresenceBlocked: vi.fn().mockResolvedValue(undefined),
}));

import { elicitationRouter } from './elicitation-router.js';
import { pushIfConfigured } from '../telegram/push.js';
import { setPresenceBlocked } from './awareness/presence.js';

/** Ordered [sessionId, blocked] pairs the router asked presence to write. */
function blockedCalls(): Array<[string, boolean]> {
  return vi.mocked(setPresenceBlocked).mock.calls.map((c) => [c[0], c[1]] as [string, boolean]);
}

/**
 * The marker writes are fire-and-forget (`void ... .catch()`), so a settle can
 * be observed by the caller before the clear's microtask has run. Flush the
 * microtask queue before asserting on the call log.
 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

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
    vi.mocked(pushIfConfigured).mockClear();
    vi.mocked(setPresenceBlocked).mockClear();
  });

  afterEach(() => {
    elicitationRouter.uninstall();
  });

  it('auto-declines when no handler is installed', async () => {
    const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(result.action).toBe('decline');
  });

  it('park-and-notify: no handler → fires a Telegram notification, then declines', async () => {
    const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(result.action).toBe('decline');
    expect(pushIfConfigured).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(pushIfConfigured).mock.calls[0]?.[0] as string;
    expect(msg).toContain('supabase'); // serverName label
    expect(msg).toContain('Sign in with Supabase to continue'); // request.message
    expect(msg).toContain('https://supabase.example/oauth/abc'); // request.url
  });

  it('park-and-notify: does NOT notify when a handler is installed (human already prompted)', async () => {
    elicitationRouter.install(vi.fn().mockResolvedValue({ action: 'accept' } as ElicitationResult));
    await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(pushIfConfigured).not.toHaveBeenCalled();
  });

  it('park-and-notify: a notification failure never breaks the decline', async () => {
    vi.mocked(pushIfConfigured).mockRejectedValueOnce(new Error('telegram down'));
    const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    expect(result.action).toBe('decline');
  });

  it('park-and-notify: does NOT fire on the pre-aborted fast path', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const result = await elicitationRouter.route(URL_REQUEST, { signal: aborted.signal });
    expect(result.action).toBe('decline');
    expect(pushIfConfigured).not.toHaveBeenCalled();
  });

  it('park-and-notify: no handler + aborted while waiting in queue → declines without notifying', async () => {
    // A first request (with a handler) holds the serial queue; a second request
    // is captured with NO handler, then aborted while it waits behind the first.
    // When the queue reaches it, the abort re-check fires BEFORE the no-handler
    // branch — so it declines silently rather than firing park-and-notify.
    const handler = vi.fn().mockResolvedValue({ action: 'accept' } as ElicitationResult);
    elicitationRouter.install(handler);
    const firstSignal = new AbortController();
    const first = elicitationRouter.route(URL_REQUEST, { signal: firstSignal.signal });

    elicitationRouter.uninstall(); // the second request captures a null handler
    const secondAbort = new AbortController();
    const second = elicitationRouter.route(URL_REQUEST, { signal: secondAbort.signal });
    secondAbort.abort(); // aborted while still queued behind the first

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ action: 'accept' });
    expect(r2).toEqual({ action: 'decline' });
    expect(pushIfConfigured).not.toHaveBeenCalled();
  });

  it('park-and-notify: truncates an over-long message to bound inadvertent disclosure', async () => {
    const longMsg = 'x'.repeat(500);
    await elicitationRouter.route({ ...URL_REQUEST, message: longMsg }, { signal: NO_SIGNAL });
    const msg = vi.mocked(pushIfConfigured).mock.calls[0]?.[0] as string;
    expect(msg).toContain('…(truncated)');
    expect(msg).not.toContain(longMsg); // the full 500-char message is never sent
    expect(msg).toContain('x'.repeat(300)); // first 300 chars preserved
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

  describe('onActive callback', () => {
    it('fires exactly once for a served request, immediately before the handler', async () => {
      const order: string[] = [];
      elicitationRouter.install(async () => {
        order.push('handler');
        return { action: 'accept' };
      });
      const onActive = vi.fn(() => { order.push('onActive'); });
      await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL, onActive });
      expect(onActive).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['onActive', 'handler']);
    });

    it('is NOT called when the signal is pre-aborted (fast-path decline)', async () => {
      elicitationRouter.install(vi.fn().mockResolvedValue({ action: 'accept' } as ElicitationResult));
      const controller = new AbortController();
      controller.abort();
      const onActive = vi.fn();
      await elicitationRouter.route(URL_REQUEST, { signal: controller.signal, onActive });
      expect(onActive).not.toHaveBeenCalled();
    });

    it('is NOT called when the signal is aborted while waiting in queue', async () => {
      let resolveBlock!: () => void;
      const block = new Promise<void>((res) => { resolveBlock = res; });
      elicitationRouter.install(async () => {
        await block;
        return { action: 'accept' };
      });
      const controller = new AbortController();
      const p1 = elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
      const onActive2 = vi.fn();
      const p2 = elicitationRouter.route(URL_REQUEST, { signal: controller.signal, onActive: onActive2 });
      controller.abort();
      resolveBlock();
      await p1;
      await p2;
      expect(onActive2).not.toHaveBeenCalled();
    });

    it('is NOT called when no handler is installed', async () => {
      // No install() — no handler
      const onActive = vi.fn();
      const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL, onActive });
      expect(result.action).toBe('decline');
      expect(onActive).not.toHaveBeenCalled();
    });

    it('a throwing onActive does not break the queue or the result', async () => {
      elicitationRouter.install(async () => ({ action: 'accept' } as ElicitationResult));
      const onActive = vi.fn(() => { throw new Error('boom from onActive'); });
      const result = await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL, onActive });
      expect(onActive).toHaveBeenCalledTimes(1);
      expect(result.action).toBe('accept');
    });
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

describe('hasHandler', () => {
  it('reflects install/uninstall state', () => {
    elicitationRouter.uninstall();
    expect(elicitationRouter.hasHandler()).toBe(false);

    elicitationRouter.install(async (): Promise<ElicitationResult> => ({ action: 'decline' }));
    expect(elicitationRouter.hasHandler()).toBe(true);

    elicitationRouter.uninstall();
    expect(elicitationRouter.hasHandler()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// blocked-on-human presence marker
//
// The marker is a SET/CLEAR pair, not a fire-and-forget event: an unpaired set
// strands a permanent "your agent is waiting on you" marker on a session that
// is no longer waiting. These tests pin the pairing on every settle path, and
// pin that the set happens ONLY where a human is really about to be prompted.
// ---------------------------------------------------------------------------

describe('blockedSince presence marker', () => {
  beforeEach(() => {
    elicitationRouter.uninstall();
    vi.mocked(setPresenceBlocked).mockClear();
  });

  afterEach(() => {
    elicitationRouter.uninstall();
  });

  it('sets before the handler runs and clears after it answers', async () => {
    const order: string[] = [];
    vi.mocked(setPresenceBlocked).mockImplementation(async (_id, blocked) => {
      order.push(blocked ? 'set' : 'clear');
    });
    elicitationRouter.install(async (): Promise<ElicitationResult> => {
      order.push('handler');
      return { action: 'accept' };
    });

    const result = await elicitationRouter.route(URL_REQUEST, {
      signal: NO_SIGNAL,
      sessionId: 'sess-A',
    });
    await flush();

    expect(result.action).toBe('accept');
    // Ordering is the contract: a marker written after the handler returns, or
    // cleared before it runs, would be visible to a poller as the wrong state.
    expect(order).toEqual(['set', 'handler', 'clear']);
    expect(blockedCalls()).toEqual([
      ['sess-A', true],
      ['sess-A', false],
    ]);
  });

  it('clears when the handler REJECTS (decline path)', async () => {
    elicitationRouter.install(async () => {
      throw new Error('handler exploded');
    });

    const result = await elicitationRouter.route(URL_REQUEST, {
      signal: NO_SIGNAL,
      sessionId: 'sess-B',
    });
    await flush();

    expect(result.action).toBe('decline');
    expect(blockedCalls()).toEqual([
      ['sess-B', true],
      ['sess-B', false],
    ]);
  });

  it('clears when the handler throws SYNCHRONOUSLY', async () => {
    // A non-async handler that throws bubbles past the inner catch; the safety-net
    // resolve covers the result, and the finally must still clear the marker.
    elicitationRouter.install((() => {
      throw new Error('sync boom');
    }) as unknown as Parameters<typeof elicitationRouter.install>[0]);

    const result = await elicitationRouter.route(URL_REQUEST, {
      signal: NO_SIGNAL,
      sessionId: 'sess-C',
    });
    await flush();

    expect(result.action).toBe('decline');
    expect(blockedCalls()).toEqual([
      ['sess-C', true],
      ['sess-C', false],
    ]);
  });

  it('clears when the turn is ABORTED mid-prompt (handler never settles)', async () => {
    // The worst stranding case: operator walks away, turn is torn down, and the
    // handler never resolves. The abort race unblocks the caller — the clear
    // must ride the same finally.
    const ac = new AbortController();
    elicitationRouter.install(() => new Promise<ElicitationResult>(() => { /* never settles */ }));

    const p = elicitationRouter.route(URL_REQUEST, { signal: ac.signal, sessionId: 'sess-D' });
    await flush();
    expect(blockedCalls()).toEqual([['sess-D', true]]); // set, still waiting

    ac.abort();
    const result = await p;
    await flush();

    expect(result.action).toBe('decline');
    expect(blockedCalls()).toEqual([
      ['sess-D', true],
      ['sess-D', false],
    ]);
  });

  it('does NOT set when no handler is installed (nobody is being prompted)', async () => {
    // Park-and-notify declines immediately: no human is waiting, so an on-disk
    // "blocked" marker would be a lie. Telegram push is the signal here.
    const result = await elicitationRouter.route(URL_REQUEST, {
      signal: NO_SIGNAL,
      sessionId: 'sess-E',
    });
    await flush();

    expect(result.action).toBe('decline');
    expect(blockedCalls()).toEqual([]);
  });

  it('does NOT set when the signal is already aborted', async () => {
    elicitationRouter.install(vi.fn().mockResolvedValue({ action: 'accept' } as ElicitationResult));
    const ac = new AbortController();
    ac.abort();

    const result = await elicitationRouter.route(URL_REQUEST, {
      signal: ac.signal,
      sessionId: 'sess-F',
    });
    await flush();

    expect(result.action).toBe('decline');
    expect(blockedCalls()).toEqual([]);
  });

  it('writes no marker at all when no sessionId is supplied', async () => {
    // Legacy callers and subagent-originated prompts: better to write nothing
    // than to guess a session id and mark the wrong file.
    elicitationRouter.install(vi.fn().mockResolvedValue({ action: 'accept' } as ElicitationResult));

    await elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL });
    await flush();

    expect(setPresenceBlocked).not.toHaveBeenCalled();
  });

  it('marks each session independently when two sessions queue concurrently', async () => {
    // A process can host several concurrent top-level sessions (the Telegram bot
    // keeps one per chat), so the id must ride the call, never a global.
    const gates: Array<() => void> = [];
    elicitationRouter.install(
      () =>
        new Promise<ElicitationResult>((resolve) => {
          gates.push(() => resolve({ action: 'accept' }));
        }),
    );

    const p1 = elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL, sessionId: 'chat-1' });
    const p2 = elicitationRouter.route(URL_REQUEST, { signal: NO_SIGNAL, sessionId: 'chat-2' });
    await flush();

    // Serial queue: only the first is active, so only it is marked.
    expect(blockedCalls()).toEqual([['chat-1', true]]);

    gates[0]!();
    await p1;
    await flush();
    gates[0 + 1]!();
    await p2;
    await flush();

    expect(blockedCalls()).toEqual([
      ['chat-1', true],
      ['chat-1', false],
      ['chat-2', true],
      ['chat-2', false],
    ]);
  });

  it('a presence-write failure never affects the elicitation result', async () => {
    // Presence is best-effort telemetry; an elicitation must not fail with it.
    vi.mocked(setPresenceBlocked).mockRejectedValue(new Error('disk full'));
    elicitationRouter.install(vi.fn().mockResolvedValue({ action: 'accept' } as ElicitationResult));

    const result = await elicitationRouter.route(URL_REQUEST, {
      signal: NO_SIGNAL,
      sessionId: 'sess-G',
    });
    await flush();

    expect(result.action).toBe('accept');
  });
});
