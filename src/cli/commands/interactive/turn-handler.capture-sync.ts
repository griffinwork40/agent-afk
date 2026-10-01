import type { StreamRenderer } from '../../_lib/stream-renderer.js';

/**
 * Persist the most-recent bash capture path from `renderer` into `capturePathRef`
 * so that Ctrl+G can open the viewer between turns.
 *
 * Must be called BEFORE `disposeRenderer()` because `getLastCapturePath()` reads
 * from the tool-lane, which is cleared during disposal.
 *
 * Extracted from `runTurn`'s finally block so the grandfathered function does not
 * grow beyond its baselined ceiling (issue #1505).
 *
 * @param capturePathRef  Session-scoped mutable ref; updated in place when a newer
 *                        capture path is available.
 * @param renderer        The per-turn StreamRenderer being torn down.
 */
export function syncCapturePathRef(
  capturePathRef: { current: string | undefined },
  renderer: StreamRenderer,
): void {
  const cp = renderer.getLastCapturePath();
  if (cp !== undefined) capturePathRef.current = cp;
}
