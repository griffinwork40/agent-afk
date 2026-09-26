/**
 * cup-frame-renderer.cursor.ts
 *
 * CupCursorTracker — pure cursor-position state machine.
 *
 * Tracks the on-screen footprint of the most recently rendered frame:
 *   - `previousTopRow`       — first row the frame occupies (1-based, 0 = none)
 *   - `previousLineCount`    — padded row count (erase-loop reference)
 *   - `previousRawLineCount` — raw (unpadded) content rows (shrink-detection reference)
 *   - `eraseBottomOverride`  — one-shot erase-ceiling for the next render
 *
 * All methods are pure state transitions with no I/O. The renderer reads from
 * and commits to this tracker after each frame write so it can reconstruct the
 * on-screen footprint for the next erase pass.
 *
 * Invariant (padded >= raw):
 *   `previousLineCount` is always ≥ `previousRawLineCount`. Violating this
 *   would cause the erase loop to under-cover the write loop's footprint and
 *   leave orphan rows.
 */
export class CupCursorTracker {
  private _previousTopRow = 0;
  private _previousLineCount = 0;
  private _previousRawLineCount = 0;

  /**
   * One-shot override for the erase-loop ceiling in the next render call.
   * When set, the erase pass covers old rows up to this row (inclusive) instead
   * of the new frame's `bottomRow`. Consumed (cleared) by `consume()` after use.
   *
   * The compositor sets this before a repaint that moves `targetBottomRow`
   * upward (cursor-follow dropdown collapse) so the erase pass can reach the
   * old frame's full footprint without the default `bottomRow` guard truncating
   * it.
   */
  eraseBottomOverride: number | undefined;

  /** The top row of the most recently rendered frame. Returns 0 if none. */
  get previousTopRow(): number {
    return this._previousTopRow;
  }

  /** The padded on-screen line count of the most recently rendered frame. */
  get previousLineCount(): number {
    return this._previousLineCount;
  }

  /** The raw (unpadded) content line count of the most recently rendered frame. */
  get previousRawLineCount(): number {
    return this._previousRawLineCount;
  }

  /**
   * Commit a completed frame's geometry so the next render's erase pass has
   * accurate coordinates.
   *
   * @param topRow      First row the frame occupies (1-based).
   * @param lineCount   Padded row count (written rows, including blank padding).
   * @param rawLineCount Raw content row count (before padding).
   */
  commit(topRow: number, lineCount: number, rawLineCount: number): void {
    this._previousTopRow = topRow;
    this._previousLineCount = lineCount;
    this._previousRawLineCount = rawLineCount;
  }

  /**
   * Consume (read and clear) the one-shot erase-bottom override.
   * Returns `undefined` when no override is set.
   */
  consumeEraseBottomOverride(): number | undefined {
    const v = this.eraseBottomOverride;
    this.eraseBottomOverride = undefined;
    return v;
  }

  /**
   * Reset all tracked coordinates to zero.
   *
   * Called by the renderer on resize (SIGWINCH) so the next render skips the
   * stale erase pass and performs a fresh full-paint at the new geometry.
   * Also used by clear()/done() to signal that no frame is on-screen.
   */
  reset(): void {
    this._previousTopRow = 0;
    this._previousLineCount = 0;
    this._previousRawLineCount = 0;
    this.eraseBottomOverride = undefined;
  }
}
