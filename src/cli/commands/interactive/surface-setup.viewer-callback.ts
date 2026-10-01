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
 * Invariant: an open viewer must never survive an `idle → streaming`
 * transition. The viewer holds the compositor's single `pickerController`
 * slot; if a turn starts while it is open (queued message, background-agent
 * result, scheduled input) and the viewer stays up, the compositor is stuck
 * in picker mode and the next overlay's `enterPickerMode` throws on
 * re-entry. Each open therefore gets a fresh AbortController, and the
 * compositor's `onStreamingStart` hook (fired by `setInputMode` BEFORE it
 * mutates mode state) aborts it, which runs the viewer's normal `close()`
 * path and calls `exitPickerMode()`. The hook is (re)installed on every open
 * so it always targets the live viewer; the viewer is its only consumer.
 *
 * @param capturePathRef  Session-scoped mutable ref written by the turn-handler
 *                        finally path; holds the most-recent bash capture path.
 * @param getCompositor   Reads the armed compositor (returns null before arm or
 *                        on non-TTY surfaces).
 */
export function buildOutputViewerCallback(
  capturePathRef: { current: string | undefined },
  getCompositor: () => TerminalCompositor | null,
): () => void {
  let current: AbortController | null = null;
  return (): void => {
    const compositor = getCompositor();
    if (!compositor) return;
    current?.abort();
    const ac = new AbortController();
    current = ac;
    compositor.setOnStreamingStart(() => ac.abort());
    // Dynamic import keeps the viewer out of the initial bundle; fire-and-forget
    // so the keypress handler returns synchronously.
    import('./bash-output-viewer.js').then(({ runBashOutputViewer }) => {
      runBashOutputViewer(compositor, capturePathRef.current, ac.signal).catch(() => {});
    }).catch(() => {});
  };
}
