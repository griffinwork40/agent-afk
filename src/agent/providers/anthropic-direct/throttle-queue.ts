/**
 * Out-of-band mailbox for live throttle (rate-limit / backoff) signals.
 *
 * Invariant: the anthropic-direct per-turn loop (`loop.ts`) is BLOCKED on a
 * single `await client.messages.create(...)` while the SDK retries a throttled
 * request (429/503/529) internally, honoring `retry-after`. It therefore cannot
 * `yield` a `rate_limit` ProviderEvent during that backoff — the very window in
 * which the user most needs a "still alive, waiting ~70s" signal. The wrapped
 * `fetch` (`tracing-fetch.ts`) is the ONLY code that runs during that wait: it
 * sees each throttled HTTP response as the SDK retries. This queue is the seam
 * that carries a signal from that fetch callback (constructed at query time)
 * across to the per-turn loop (constructed per turn), so the loop can drain and
 * yield it WHILE still awaiting the same `messages.create`.
 *
 * Contract: a single logical producer (the fetch throttle callback) calls
 * {@link push}; a single consumer (the loop, via a race against the SDK
 * promise) calls {@link takeAll} to drain queued items without blocking, or
 * awaits {@link waitForItem} to be woken the instant a new item lands. The
 * queue is unbounded but bounded in practice by the SDK's per-call retry count
 * (≈3), so no backpressure is needed. Draining is level-triggered: items pushed
 * before a `waitForItem` call resolve it immediately.
 *
 * Deliberately tiny and dependency-free — it holds plain payloads, not
 * ProviderEvents, so it does not couple this provider-internal seam to the
 * harness event union.
 *
 * @module agent/providers/anthropic-direct/throttle-queue
 */

/** A single throttle observation pushed from the wrapped fetch. */
export interface ThrottleSignal {
  /** Throttled HTTP status (429/503/529). */
  status: number;
  /** Parsed `retry-after` in ms, when the header was present. */
  retryAfterMs?: number;
  /** 1-based count of throttles observed within the current call. */
  attempt: number;
}

/**
 * Minimal single-consumer async mailbox. Not exported as a general utility on
 * purpose: its wake semantics are tuned for the loop's drain-then-await race
 * and it is intentionally provider-local.
 */
export class ThrottleQueue {
  private readonly items: ThrottleSignal[] = [];
  /** Resolver for the pending {@link waitForItem} promise, if any. */
  private waiter: (() => void) | null = null;
  private attempts = 0;

  /**
   * Enqueue a throttle observation and wake any pending consumer. The
   * `attempt` counter is assigned here (monotonic across the queue's life) so
   * the producer callback stays stateless. Safe to call from the fetch path;
   * never throws.
   */
  push(info: { status: number; retryAfterMs?: number }): void {
    this.attempts += 1;
    const signal: ThrottleSignal = {
      status: info.status,
      attempt: this.attempts,
      ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
    };
    this.items.push(signal);
    // Wake a pending consumer exactly once; it re-arms via waitForItem().
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  /** Synchronously drain every queued item (may be empty). */
  takeAll(): ThrottleSignal[] {
    if (this.items.length === 0) return [];
    return this.items.splice(0, this.items.length);
  }

  /**
   * Resolve when at least one item is available. If items are already queued,
   * resolves on the next microtask (level-triggered). Only one consumer may
   * await at a time — a second concurrent call replaces the first waiter's
   * resolver, which is fine here because the loop awaits serially.
   */
  waitForItem(): Promise<void> {
    if (this.items.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  /**
   * Reset the per-call attempt counter. Called by the loop at the start of
   * each new `messages.create` so the `attempt` numbering reflects throttles
   * within THAT call (mirrors the SDK's per-call retry budget), not a running
   * total across the whole turn.
   */
  resetAttempts(): void {
    this.attempts = 0;
  }
}
