/**
 * Crash-restart loop guard for persistent LSP servers (#4272).
 *
 * Policy (from the issue spec):
 *   - A crashed server is restarted automatically on the next tool call.
 *   - If the same server crashes 3 times within 120 seconds, mark it failed
 *     and degrade (skip LSP, fall back to grep/regex). No restart attempts
 *     after the guard trips.
 *   - The trip expires after `GUARD_COOLDOWN_MS` (default 5 minutes): a fresh
 *     acquire after the cooldown resets the guard and may start a new server.
 *     This bounds the "lasts for the whole process" problem in long-lived
 *     daemon / Telegram-bot processes (#5131).
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

/**
 * How long after the guard trips before it expires and a fresh start is
 * allowed. Bounds the "guard lasts for the whole process" problem in
 * long-lived daemon / Telegram-bot processes (#5131).
 */
export const GUARD_COOLDOWN_MS = 300_000; // 5 minutes

export interface CrashLoopGuardOptions {
  /** Number of crashes that trip the guard. Default: `CRASH_LIMIT`. */
  readonly limit?: number;
  /** Rolling window in ms. Default: `CRASH_WINDOW_MS`. */
  readonly windowMs?: number;
  /**
   * How long after tripping before the guard auto-expires and a fresh server
   * start is allowed. Default: `GUARD_COOLDOWN_MS` (5 minutes).
   */
  readonly cooldownMs?: number;
  /** Injectable clock (tests). Default: `Date.now`. */
  readonly now?: () => number;
}

/**
 * Per-server crash-loop guard.  One instance is created per pool key; it
 * survives across crash-evict-respawn cycles for the same server identity
 * (workspace root + language + command).
 *
 * The guard trips after `limit` crashes within `windowMs`. After tripping it
 * stays failed for `cooldownMs` (default 5 min), then auto-expires so that a
 * fresh acquire may start a new server — bounding the problem where a single
 * bad stretch disables a server for an entire long-lived process (#5131).
 */
export class CrashLoopGuard {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  /** Timestamps (from `now()`) of recent crashes, oldest first. */
  private readonly timestamps: number[] = [];
  private _failed = false;
  /** When the guard tripped (`now()` value). `null` if not yet tripped. */
  private _failedAt: number | null = null;

  constructor(opts: CrashLoopGuardOptions = {}) {
    this.limit = opts.limit ?? CRASH_LIMIT;
    this.windowMs = opts.windowMs ?? CRASH_WINDOW_MS;
    this.cooldownMs = opts.cooldownMs ?? GUARD_COOLDOWN_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Whether the guard has tripped and the cooldown has not yet expired.
   * Returns `false` once `cooldownMs` have elapsed since the trip, allowing
   * the pool to attempt a fresh server start.
   */
  get failed(): boolean {
    if (!this._failed) return false;
    if (this._failedAt !== null && this.now() - this._failedAt >= this.cooldownMs) {
      // Cooldown elapsed — reset so a fresh start is allowed.
      this._failed = false;
      this._failedAt = null;
      this.timestamps.length = 0;
      return false;
    }
    return true;
  }

  /**
   * Record one crash (or timeout-as-crash).  After `limit` crashes within
   * `windowMs`, the guard trips and starts the cooldown.  Call this ONLY for
   * genuine process crashes / LSP timeouts — not for missing-binary errors.
   *
   * @returns `true` when this crash tripped the guard (or it was already tripped).
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
      this._failedAt = t;
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

  /**
   * Milliseconds remaining before the cooldown expires, or `0` if the guard
   * has not tripped or the cooldown has already elapsed.
   */
  get cooldownRemainingMs(): number {
    if (!this._failed || this._failedAt === null) return 0;
    const elapsed = this.now() - this._failedAt;
    return Math.max(0, this.cooldownMs - elapsed);
  }
}

/**
 * Map from pool key → guard. Guards persist across crash-evict-respawn cycles
 * for the same server identity so the rolling-crash memory is maintained.
 * The guard's own cooldown expiry handles process-lifetime accumulation (#5131).
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
