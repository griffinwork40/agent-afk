import type { TerminalCompositor } from '../../terminal-compositor.js';

/**
 * Build the `onOpenOutputViewer` callback for the compositor arm options.
 *
 * Ctrl+G fires this callback in any input mode.  The function lazy-imports
 * the viewer module so it never lands in the startup bundle.  `runBashOutputViewer`
 * is fire-and-forget — it owns its own picker lifecycle and returns a promise
 * that the caller never needs to await.
 *
 * Extracted from `surface-setup.ts` so `setupSurface` stays under its
 * baselined function-size ceiling (issue #1505).
 *
 * @param capturePathRef  Session-scoped mutable ref written by the turn-handler
 *                        finally path; holds the most-recent bash capture path.
 * @param getCompositor   Reads the armed compositor (returns null before arm or
 *                        on non-TTY surfaces).
 * @param getSignal       Optional: returns an AbortSignal scoped to the
 *                        compositor's lifetime so the viewer can be closed
 *                        externally (e.g. when a new turn starts and the
 *                        compositor is disarmed).
 */
export function buildOutputViewerCallback(
  capturePathRef: { current: string | undefined },
  getCompositor: () => TerminalCompositor | null,
  getSignal?: () => AbortSignal,
): () => void {
  return (): void => {
    const compositor = getCompositor();
    if (!compositor) return;
    const signal = getSignal?.();
    // Dynamic import keeps the viewer out of the initial bundle; fire-and-forget
    // so the keypress handler returns synchronously.
    import('./bash-output-viewer.js').then(({ runBashOutputViewer }) => {
      runBashOutputViewer(compositor, capturePathRef.current, signal).catch(() => {});
    }).catch(() => {});
  };
}
