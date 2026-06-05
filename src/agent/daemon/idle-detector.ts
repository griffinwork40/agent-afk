/**
 * Idle detector — tracks in-flight task count so the pull-loop can
 * back off while another task is executing. Pure in-memory; no I/O.
 *
 * @module agent/daemon/idle-detector
 */

export class IdleDetector {
  private _count = 0;

  /** Increment the in-flight counter (call when a task starts). */
  increment(): void {
    this._count++;
  }

  /**
   * Decrement the in-flight counter (call when a task finishes).
   * Floors at 0 — decrementing below zero is a no-op.
   */
  decrement(): void {
    if (this._count > 0) {
      this._count--;
    }
  }

  /** Returns `true` when no tasks are currently in-flight. */
  isIdle(): boolean {
    return this._count === 0;
  }

  /** Current in-flight task count. */
  count(): number {
    return this._count;
  }
}
