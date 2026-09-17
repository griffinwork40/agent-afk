/**
 * 150ms glyph color pulse on tool completion.
 *
 * Tracks which tool-use IDs are currently "flashing" (just completed within
 * the last {@link FLASH_DURATION_MS} milliseconds) so the overlay renderer can
 * apply a bold highlight to their glyph. The pulse gives peripheral-vision
 * feedback that a tool landed without requiring the user to read the output.
 *
 * Design:
 *   - `flashTool(id)` marks the id as flashing and schedules its removal after
 *     150ms. If the same id is flashed again before the timer fires (rare), the
 *     old timer is cancelled and a fresh one is started.
 *   - `isFlashing(id)` is checked at overlay-render time (inside
 *     `ToolLane.getOverlay`) and is deliberately fast: a Set lookup.
 *   - On expiry the caller-supplied `onRepaint` callback fires so the overlay
 *     can push the post-flash (normal) frame. The flash-start repaint happens
 *     naturally: `addResult` is always followed by `setComposedOverlay`, so the
 *     flash-on frame reaches the screen without an extra timer.
 *   - `dispose()` clears all pending flash timers; call at turn end / teardown.
 *
 * @module cli/commands/interactive/tool-lane-flash
 */

/** Wall-clock duration (ms) of the bright-glyph flash on tool completion. */
export const FLASH_DURATION_MS = 150;

/**
 * Manages the transient flash state for tool-lane glyphs.
 *
 * Thread safety: JavaScript is single-threaded; every method runs to
 * completion before the next event or timer fires, so no locking is needed.
 */
export class ToolLaneFlash {
  private readonly flashing = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  /**
   * @param onRepaint Called when a flash expires so the overlay renderer can
   *   push the post-flash frame. Must not throw. Called at most once per
   *   expired flash — NOT called on `dispose()` (the session is tearing down).
   */
  constructor(private readonly onRepaint: () => void) {}

  /**
   * Mark `toolUseId` as flashing and start (or restart) its expiry timer.
   * No-op after {@link dispose}.
   */
  flashTool(toolUseId: string): void {
    if (this.disposed) return;
    // Cancel any existing timer for this id (re-flash on rapid repeat).
    const existing = this.timers.get(toolUseId);
    if (existing !== undefined) clearTimeout(existing);

    this.flashing.add(toolUseId);
    const timer = setTimeout(() => {
      this.flashing.delete(toolUseId);
      this.timers.delete(toolUseId);
      if (!this.disposed) {
        try {
          this.onRepaint();
        } catch {
          // Defense-in-depth: swallow throws from controlled callback so a
          // repaint error never surfaces as an uncaught timer exception.
        }
      }
    }, FLASH_DURATION_MS);
    this.timers.set(toolUseId, timer);
    // Flash-start repaint happens naturally: addResult() is always followed by
    // setComposedOverlay(), which pushes the flash-on frame to the screen.
  }

  /**
   * Returns `true` while `toolUseId` is within its flash window.
   * Checked by `ToolLane.getOverlay()` at render time — O(1) Set lookup.
   */
  isFlashing(toolUseId: string): boolean {
    return this.flashing.has(toolUseId);
  }

  /**
   * Cancel all pending flash timers. Call at turn end / session teardown.
   * After this, `flashTool` is a no-op and `onRepaint` is never called again.
   */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.flashing.clear();
  }
}
