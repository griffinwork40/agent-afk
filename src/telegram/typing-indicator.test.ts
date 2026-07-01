import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'telegraf';
import { withTypingIndicator } from './typing-indicator.js';

/** Minimal Telegraf Context stub exposing only the sendChatAction we exercise. */
function makeCtx(sendChatAction: () => Promise<unknown>): {
  ctx: Context;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(sendChatAction);
  const ctx = { sendChatAction: send } as unknown as Context;
  return { ctx, send };
}

/** A promise plus its resolver, so a test can hold `work` open across timers. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withTypingIndicator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a typing action immediately, before work resolves', async () => {
    const { ctx, send } = makeCtx(async () => true);
    const p = withTypingIndicator(ctx, async () => 'ok');
    // The initial action is fired synchronously, before the first await.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('typing');
    await p;
  });

  it('re-sends the typing action every ~4s while work is pending', async () => {
    const { ctx, send } = makeCtx(async () => true);
    const d = deferred<string>();
    const p = withTypingIndicator(ctx, () => d.promise);

    expect(send).toHaveBeenCalledTimes(1); // immediate
    await vi.advanceTimersByTimeAsync(4000);
    expect(send).toHaveBeenCalledTimes(2); // first refresh
    await vi.advanceTimersByTimeAsync(4000);
    expect(send).toHaveBeenCalledTimes(3); // second refresh

    d.resolve('done');
    await expect(p).resolves.toBe('done');
  });

  it('clears the refresh timer once work resolves (no interval outlives the turn)', async () => {
    const { ctx, send } = makeCtx(async () => true);
    await withTypingIndicator(ctx, async () => 'done');
    const callsAfterSettle = send.mock.calls.length;
    // Advancing well past several refresh windows must produce no further sends.
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).toHaveBeenCalledTimes(callsAfterSettle);
  });

  it('clears the timer and propagates when work rejects', async () => {
    const { ctx, send } = makeCtx(async () => true);
    const boom = new Error('boom');
    await expect(withTypingIndicator(ctx, async () => { throw boom; })).rejects.toBe(boom);
    const callsAfterThrow = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).toHaveBeenCalledTimes(callsAfterThrow); // timer cleared despite throw
  });

  it('runs work to completion even when the typing action itself rejects (best-effort)', async () => {
    // A flood-control 429 / blocked-chat on the indicator must never cost the reply.
    const { ctx } = makeCtx(async () => { throw new Error('429: Too Many Requests'); });
    await expect(withTypingIndicator(ctx, async () => 'still-ran')).resolves.toBe('still-ran');
  });

  it('returns the resolved value of work', async () => {
    const { ctx } = makeCtx(async () => true);
    await expect(withTypingIndicator(ctx, async () => 42)).resolves.toBe(42);
  });
});
