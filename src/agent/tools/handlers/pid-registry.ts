/**
 * Session-scoped PID registry for the `wait_for` process condition.
 *
 * Records PIDs of child processes spawned by the agent's bash tool so that
 * `evaluateProcess` can restrict probing to processes the current session
 * actually owns. Any PID not in the registry is rejected, preventing the
 * model from leaking process-liveness information for arbitrary host PIDs.
 *
 * The registry is intentionally simple — a Set<number> with a thin API —
 * because its entire job is membership tracking. It has no eviction policy:
 * PIDs persist for the session lifetime. This is safe because:
 *   - Sessions are bounded in duration and typically spawn O(100s) of children.
 *   - A PID that has already been waited on is harmless to re-probe; the kernel
 *     reuses PIDs slowly enough that a stale entry rarely collides within a
 *     session window.
 *
 * Thread-safety note: Node.js runs on a single thread, so all Set operations
 * are atomic from our perspective. No mutex is needed.
 *
 * @module agent/tools/handlers/pid-registry
 */

/**
 * Tracks PIDs of child processes spawned by the current session's bash tool.
 *
 * Create one instance per session and share it between the bash handler
 * (which registers PIDs) and the wait_for handler (which checks membership).
 */
export class SpawnedPidRegistry {
  private readonly _pids = new Set<number>();

  /**
   * Record a PID as session-owned.
   * Called by the bash handler immediately after `spawn()` assigns a PID.
   *
   * @param pid - The child process PID. Must be a positive integer.
   */
  register(pid: number): void {
    if (Number.isInteger(pid) && pid > 1) {
      this._pids.add(pid);
    }
  }

  /**
   * Check whether a PID was spawned by this session.
   *
   * @param pid - PID to test.
   * @returns `true` iff the PID was previously registered via `register()`.
   */
  has(pid: number): boolean {
    return this._pids.has(pid);
  }

  /**
   * Remove all registered PIDs.
   * Useful in tests to reset state between cases.
   */
  clear(): void {
    this._pids.clear();
  }

  /** Number of currently registered PIDs (for diagnostics/tests). */
  get size(): number {
    return this._pids.size;
  }
}
