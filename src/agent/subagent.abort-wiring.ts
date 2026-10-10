/**
 * `wireParentAbortSignal` — wires a parent AbortSignal into the SubagentManager's
 * root AbortController. Split out of `subagent.ts` (file-size ceiling, #3481).
 *
 * @module agent/subagent.abort-wiring
 */

/**
 * Wire a parent AbortSignal into a root AbortController so that when the
 * parent is aborted, the cascade propagates to every child managed under
 * the root. Handles the already-aborted edge case synchronously.
 *
 * @param parentSignal    The external signal to listen on.
 * @param rootController  The manager's root AbortController to fire.
 */
export function wireParentAbortSignal(
  parentSignal: AbortSignal,
  rootController: AbortController,
): void {
  if (parentSignal.aborted) {
    rootController.abort(parentSignal.reason);
  } else {
    parentSignal.addEventListener(
      'abort',
      () => {
        if (!rootController.signal.aborted) {
          rootController.abort(parentSignal.reason);
        }
      },
      { once: true },
    );
  }
}
