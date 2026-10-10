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
