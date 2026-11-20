/**
 * Crash-restart loop guard for persistent LSP servers (#4272).
 *
 * Policy (from the issue spec):
 *   - A crashed server is restarted automatically on the next tool call.
 *   - If the same server crashes 3 times within 120 seconds, mark it failed
 *     for the remainder of the session and silently degrade (skip LSP, fall
 *     back to grep/regex). No restart attempts after the guard trips.
 *   - A slow server (request timeout counted as one crash) counts toward
 *     the guard. The client's own initialize deadline also counts.
 *   - A start abandoned by its callers (every acquirer timed out or aborted)
 *     does NOT count — callers' patience is not server health.
 *   - A missing binary (not installed, not on PATH) is NOT a crash and does
 *     NOT count toward the guard.
 *
 * The `now` dependency is injectable so tests can drive the clock without
 * real `setTimeout` delays.
 *
 * @module agent/lsp/crash-loop-guard
 */

/** How many crashes within the window trip the guard. */
export const CRASH_LIMIT = 3;

/** Rolling window size in milliseconds. */
export const CRASH_WINDOW_MS = 120_000;

export interface CrashLoopGuardOptions {
  /** Number of crashes that trip the guard. Default: `CRASH_LIMIT`. */
  readonly limit?: number;
  /** Rolling window in ms. Default: `CRASH_WINDOW_MS`. */
  readonly windowMs?: number;
  /** Injectable clock (tests). Default: `Date.now`. */
  readonly now?: () => number;
}

/**
 * Per-server crash-loop guard.  One instance is created per pool key; it
 * survives across crash-evict-respawn cycles for the same server identity
 * (workspace root + language + command), which is exactly what gives it the
 * "session-lifetime" memory the spec requires.
 */
export class CrashLoopGuard {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** Timestamps (from `now()`) of recent crashes, oldest first. */
  private readonly timestamps: number[] = [];
  private _failed = false;

  constructor(opts: CrashLoopGuardOptions = {}) {
    this.limit = opts.limit ?? CRASH_LIMIT;
    this.windowMs = opts.windowMs ?? CRASH_WINDOW_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Whether the guard has tripped: the server must not be restarted this
   * session.
   */
  get failed(): boolean {
    return this._failed;
  }

  /**
   * Record one crash (or timeout-as-crash).  After `limit` crashes within
   * `windowMs`, the guard trips permanently.  Call this ONLY for genuine
   * process crashes / LSP timeouts — not for missing-binary errors.
   *
   * @returns `true` when this crash tripped the guard.
   */
  recordCrash(): boolean {
    if (this._failed) return true;
    const t = this.now();
    const cutoff = t - this.windowMs;
    // Prune timestamps that have rolled out of the window.
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
    this.timestamps.push(t);
    if (this.timestamps.length >= this.limit) {
      this._failed = true;
      return true;
    }
    return false;
  }

  /** How many crashes are currently within the rolling window. */
  get recentCrashes(): number {
    if (this._failed) return this.timestamps.length;
    const cutoff = this.now() - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i]! <= cutoff) i++;
    return this.timestamps.length - i;
  }
}

/**
 * Map from pool key → guard, stored for the process lifetime so the guard
 * persists across crash-evict-respawn cycles within a session.
 */
const guards = new Map<string, CrashLoopGuard>();

/**
 * Return the existing guard for `key`, or create one with `opts` and store it.
 *
 * Tests that want an injectable clock should construct a `CrashLoopGuard`
 * directly and pass it to `LspServerPool` via `LspServerPoolOptions`; this
 * function is the production path.
 */
export function getOrCreateGuard(key: string, opts?: CrashLoopGuardOptions): CrashLoopGuard {
  let guard = guards.get(key);
  if (!guard) {
    guard = new CrashLoopGuard(opts);
    guards.set(key, guard);
  }
  return guard;
}

/** Remove the guard for `key` (tests only). */
export function deleteGuard(key: string): void {
  guards.delete(key);
}

/** Clear all guards (tests only). */
export function clearGuards(): void {
  guards.clear();
}
