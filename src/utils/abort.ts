/**
 * AbortSignal forwarding utilities.
 *
 * @module utils/abort
 */

/**
 * Forward an abort from a parent signal to a child AbortController.
 * Returns a cleanup function that removes the listener.
 */
export function forwardAbortSignal(
  parent: AbortSignal,
  child: AbortController,
): () => void {
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }
  const handler = () => child.abort(parent.reason);
  parent.addEventListener('abort', handler, { once: true });
  return () => parent.removeEventListener('abort', handler);
}

/**
 * Options for {@link createRequestAbortScope}.
 */
export interface RequestAbortScopeOptions {
  /** The session-level AbortSignal to forward into the scope. */
  parentSignal: AbortSignal;
  /**
   * Per-request timeout in milliseconds. When the timer fires the scope's
   * signal is aborted with `new Error(timeoutMessage)`.
   */
  timeoutMs: number;
  /**
   * Message used as the reason when the timeout fires.
   * Example: `"web_request timeout after 30000ms"`.
   */
  timeoutMessage: string;
}

/**
 * Result returned by {@link createRequestAbortScope}.
 */
export interface RequestAbortScope {
  /** Combined signal: aborts on parent abort OR timeout, whichever comes first. */
  readonly signal: AbortSignal;
  /**
   * Release all resources (timer + parent listener). Call this in a `finally`
   * block. Idempotent.
   */
  dispose(): void;
}

/**
 * Build a per-request abort scope that combines a parent {@link AbortSignal}
 * with a per-request timeout.
 *
 * Behaviour:
 * - If `parentSignal` is already aborted the scope's signal is immediately
 *   aborted with the parent's reason.
 * - Otherwise a `setTimeout(timeoutMs)` is armed; if it fires first the scope's
 *   signal is aborted with `new Error(timeoutMessage)`.
 * - A parent abort that arrives before `dispose()` propagates immediately.
 * - Calling `dispose()` clears the timer and removes the parent listener so
 *   nothing leaks after the request completes.
 *
 * Reuses {@link forwardAbortSignal} for the parent-forwarding leg so the two
 * mechanisms stay in sync.
 */
export function createRequestAbortScope(
  opts: RequestAbortScopeOptions,
): RequestAbortScope {
  const { parentSignal, timeoutMs, timeoutMessage } = opts;
  const ac = new AbortController();
  const cleanupParent = forwardAbortSignal(parentSignal, ac);

  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    ac.abort(new Error(timeoutMessage));
  }, timeoutMs);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    cleanupParent();
  };

  return { signal: ac.signal, dispose };
}

/**
 * Options for {@link createDeferredRequestAbortScope}.
 */
export interface DeferredRequestAbortScopeOptions {
  /**
   * The session-level AbortSignal to forward into the scope. Optional —
   * when absent, only the (deferred) timeout can abort the scope.
   */
  parentSignal?: AbortSignal;
  /**
   * Per-request timeout in milliseconds. The timer is NOT armed at creation;
   * it starts only when {@link DeferredRequestAbortScope.armTimeout} runs.
   */
  timeoutMs: number;
  /**
   * Message used as the reason when the timeout fires.
   * Example: `"approval timeout after 300s"`.
   */
  timeoutMessage: string;
}

/**
 * Result returned by {@link createDeferredRequestAbortScope}.
 */
export interface DeferredRequestAbortScope {
  /** Combined signal: aborts on parent abort (if any) OR the deferred timeout. */
  readonly signal: AbortSignal;
  /**
   * Arm the timeout timer. Idempotent — only the first call takes effect;
   * before it, only the parent leg (if any) can abort the scope. The optional
   * `onFired` callback runs immediately AFTER the timer's abort, letting the
   * caller race a sentinel against a pending work promise.
   */
  armTimeout(onFired?: () => void): void;
  /**
   * Release all resources (timer + parent listener). Call this in a `finally`
   * block. Idempotent.
   */
  dispose(): void;
}

/**
 * Build a per-request abort scope whose timeout starts DEFERRED — only when
 * {@link DeferredRequestAbortScope.armTimeout} is called. For callers whose
 * clock should run from "actually active", not from "queued" (e.g. an
 * elicitation prompt whose timeout window starts only once the prompt is
 * shown to the operator, never while it waits in the elicitation queue).
 *
 * Behaviour:
 * - If `parentSignal` is provided and already aborted the scope's signal is
 *   immediately aborted with the parent's reason.
 * - Until `armTimeout()` runs, only the parent leg (if any) can abort the scope.
 * - Once armed, a `setTimeout(timeoutMs)` is started (and `unref`'d); if it
 *   fires first the scope's signal is aborted with `new Error(timeoutMessage)`
 *   and the `onFired` callback (if any) is invoked immediately after the abort.
 * - `dispose()` clears any armed timer and removes the parent listener so
 *   nothing leaks after the request completes.
 *
 * Reuses {@link forwardAbortSignal} for the parent-forwarding leg so the two
 * scope flavours stay in sync.
 */
export function createDeferredRequestAbortScope(
  opts: DeferredRequestAbortScopeOptions,
): DeferredRequestAbortScope {
  const { parentSignal, timeoutMs, timeoutMessage } = opts;
  const ac = new AbortController();
  const cleanupParent =
    parentSignal !== undefined ? forwardAbortSignal(parentSignal, ac) : (): void => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onFired: (() => void) | undefined;
  const armTimeout = (fired?: () => void): void => {
    if (timer !== undefined) return; // idempotent — first arm wins
    onFired = fired;
    timer = setTimeout(() => {
      // Abort first, then notify: onFired may inspect scope.signal
      // synchronously and must observe the post-abort state.
      ac.abort(new Error(timeoutMessage));
      onFired?.();
    }, timeoutMs);
    timer.unref?.();
  };

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    cleanupParent();
  };

  return { signal: ac.signal, armTimeout, dispose };
}
