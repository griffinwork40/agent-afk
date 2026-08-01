/**
 * Live throttle surfacing while a `messages.create` promise is parked.
 *
 * Extracted from `loop.ts` unchanged. Its own module because it is a
 * self-contained concurrency concern — racing a pending create against an
 * out-of-band signal queue — with no knowledge of rounds, retries, or turns.
 *
 * @module agent/providers/anthropic-direct/loop/throttle-signals
 */

import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput } from '../types.js';

/**
 * Await the `messages.create` promise while surfacing LIVE throttle (rate-limit/backoff)
 * signals from the out-of-band {@link RunTurnInput.throttleQueue}.
 *
 * Invariant: the SDK retries 429/503/529 responses INSIDE the single
 * `messages.create` promise `createWithRetry` returns, sleeping out
 * `retry-after` between attempts. During that sleep the loop is parked on this
 * await and can `yield` nothing — so a healthy session waiting ~70s (retried
 * twice ≈ 140s) looks frozen. The wrapped `fetch` pushes a `ThrottleSignal`
 * onto the queue as each throttled response lands; here we race the create
 * promise against `queue.waitForItem()` and yield a `rate_limit` ProviderEvent
 * for every drained signal, so the banner updates DURING the wait. When the
 * create promise finally settles we yield any last-drained signals, then RETURN
 * the resolved events iterable (or re-throw the create error) via the
 * generator's return value.
 *
 * When `throttleQueue` is absent this degrades to a bare `await` (one extra
 * microtask), so non-throttling paths and unit tests are unaffected.
 */
export async function* awaitCreateWithThrottleSignals(
  createPromise: Promise<AsyncIterable<unknown>>,
  input: RunTurnInput,
): AsyncGenerator<ProviderEvent, AsyncIterable<unknown>, void> {
  const queue = input.throttleQueue;
  if (!queue) {
    // No live seam wired — plain await. `createPromise` rejection propagates to
    // the caller's try/catch exactly as a direct `await createWithRetry` would.
    return await createPromise;
  }
  // Reset the per-call attempt counter so `attempt` numbers reflect throttles
  // within THIS messages.create (mirrors the SDK's per-call retry budget).
  queue.resetAttempts();

  // Sentinel so `Promise.race` can tell "create settled" apart from "a throttle
  // signal arrived" without leaking the create result into the race's value.
  const CREATE_DONE = Symbol('create-done');
  // Track settlement so a throttle wake after the create resolves doesn't loop.
  let settled = false;
  const guarded = createPromise.then(
    (v) => { settled = true; return v; },
    (e) => { settled = true; throw e; },
  );

  for (;;) {
    // Drain and surface anything already queued before parking again.
    for (const sig of queue.takeAll()) {
      yield {
        type: 'rate_limit',
        sessionId: input.ctx.sessionId,
        status: sig.status,
        attempt: sig.attempt,
        ...(sig.retryAfterMs !== undefined ? { retryAfterMs: sig.retryAfterMs } : {}),
      };
    }
    if (settled) {
      // Return the resolved iterable (or re-throw the create rejection). A
      // final drain above already surfaced any late signals.
      return await guarded;
    }
    // Park until EITHER the create settles OR a new throttle signal lands.
    const outcome = await Promise.race([
      guarded.then(() => CREATE_DONE, () => CREATE_DONE),
      queue.waitForItem().then(() => undefined),
    ]);
    if (outcome === CREATE_DONE) {
      // Loop once more to drain any signals pushed right before settlement,
      // then the `settled` branch returns/throws.
      continue;
    }
    // A throttle signal woke us — loop to drain it.
  }
}
