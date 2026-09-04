/**
 * Relay events out of a pending async call, for provider generators.
 *
 * Both provider generators (`anthropic-direct/loop/tool-dispatch.ts` and
 * `openai-compatible/query/dispatch-append.ts`) face the same shape: they
 * `await` one long-running dispatcher call (`executeBatch`) that reports live
 * progress through a callback, and they must surface that progress to the TUI
 * *while the call is still pending* — not after it settles. A plain `await`
 * cannot do this: the generator is suspended inside the await, so nothing can
 * be yielded until the whole batch finishes, which is exactly the bug that made
 * the live parallel-batch badge appear only after every tool had already
 * completed.
 *
 * This module owns that one concern so neither provider re-implements a queue,
 * a wakeup promise, and a rejection-safety dance. Sibling of the other shared
 * provider leaf helpers; no module-scope state (every call gets its own
 * closure), so it is safe under `audit:module-state:check`.
 *
 * @module agent/providers/shared/event-relay
 */

/**
 * Run `start` and yield every event it emits while its promise is still
 * pending, then return the promise's resolved value.
 *
 * Invariant: `start` is invoked BEFORE the first drain step, so events emitted
 * synchronously inside `start` (or on any turn before the consumer next pulls)
 * are buffered rather than lost. Order is strictly FIFO, and every buffered
 * event is delivered before the return value — including events that landed in
 * the same tick the promise settled.
 *
 * Invariant: `emit` is a no-op once the promise has settled. A late callback
 * from a detached worker therefore cannot yield an event after the return, which
 * would violate the generator contract.
 *
 * Contract: rejections propagate — this generator throws whatever `start`'s
 * promise rejected with, so a caller's existing `try`/`catch` keeps its exact
 * semantics. The settlement handler is attached synchronously (before the drain
 * loop can suspend), so a rejection is never momentarily unhandled while events
 * are still draining. A synchronous throw from `start` itself propagates
 * directly out of the first `next()` call.
 *
 * @typeParam E - Event type relayed to the consumer (a `ProviderEvent` at both
 *   call sites, so `yield*` passes them straight through the provider stream).
 * @typeParam R - Resolved value of the underlying call (`ToolResult[]`).
 */
export async function* relayWhilePending<E, R>(
  start: (emit: (event: E) => void) => Promise<R>,
): AsyncGenerator<E, R, void> {
  const buffer: E[] = [];
  let settled = false;
  // Resolver for the drain loop's idle wait, or null when the loop is not
  // parked. Held in a mutable binding that both `emit` and `wake` read, so a
  // push that lands while the loop is parked wakes it exactly once.
  let wake: (() => void) | null = null;

  const signal = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const emit = (event: E): void => {
    if (settled) return;
    buffer.push(event);
    signal();
  };

  // Ordered start: kick off the work first so synchronous emits are captured,
  // and mark settlement in a `finally` so the drain loop always terminates —
  // including on rejection.
  const pending = start(emit).finally(() => {
    settled = true;
    signal();
  });

  // Attach the settlement handler NOW, synchronously, so a rejection has an
  // observer before the loop below awaits. Rethrown after the drain completes.
  const outcome: Promise<{ ok: true; value: R } | { ok: false; error: unknown }> = pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  for (;;) {
    while (buffer.length > 0) {
      yield buffer.shift()!;
    }
    if (settled) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }

  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}
