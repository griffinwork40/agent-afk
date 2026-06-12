/**
 * Version drift check for the Telegram daemon.
 *
 * Extracted into its own module so it can be imported in tests without
 * triggering src/telegram.ts's module-level main() call.
 */

export interface VersionDriftResult {
  drift: boolean;
  message?: string;
}

/**
 * Compare the version the daemon was spawned at against the version
 * currently on disk. Returns drift:true when a new install has landed
 * while the daemon is still running.
 *
 * Safe defaults: if either argument is 'unknown' or empty string,
 * returns { drift: false } to avoid spurious exits when package.json
 * is unreadable.
 */
export function checkVersionDrift(
  spawnedVersion: string,
  diskVersion: string,
): VersionDriftResult {
  if (!spawnedVersion || !diskVersion || spawnedVersion === 'unknown' || diskVersion === 'unknown') {
    return { drift: false };
  }
  if (spawnedVersion === diskVersion) {
    return { drift: false };
  }
  return {
    drift: true,
    message: `[daemon] Version mismatch: running ${spawnedVersion} but installed is ${diskVersion}. Exiting.`,
  };
}

/**
 * Maximum number of consecutive stats-tick deferrals the version-drift
 * watchdog tolerates before it force-exits under an active session.
 *
 * Invariant: this is the bounded escape hatch for the deferral added in PR #106.
 * That fix defers the upgrade-exit while any session is mid-turn (exiting would
 * sever the in-flight turn, its queued messages, and any sub-agent dispatch —
 * the relaunched binary starts cold and cannot resume it). But a session wedged
 * in `processing`/`streaming` (hung sub-agent, leaked session) would otherwise
 * defer the upgrade *forever*: a stuck-busy livelock. After this many deferrals
 * the watchdog forces the exit even though sessions still report busy. At the
 * daemon's 5-min stats tick (300_000 ms) 12 deferrals ≈ 1 hour of grace — far
 * longer than any legitimate turn (those finish in minutes) yet bounded for a
 * wedged one. Tuned here, consumed by decideVersionDriftAction().
 */
export const MAX_DRIFT_DEFERRALS = 12;

/** What the version-drift watchdog should do on a given stats tick. */
export type VersionDriftAction = 'none' | 'exit' | 'defer' | 'force-exit';

export interface VersionDriftDecisionInput {
  /** Result of {@link checkVersionDrift} for this tick. */
  drift: VersionDriftResult;
  /** Sessions currently mid-turn (`SessionManager.getBusySessionCount()`). */
  busyCount: number;
  /** Consecutive deferrals accumulated so far — caller-held, fed back each tick. */
  deferrals: number;
  /** Force the exit once `deferrals` reaches this many. Defaults to {@link MAX_DRIFT_DEFERRALS}. */
  maxDeferrals?: number;
}

export interface VersionDriftDecision {
  /** Action the caller should take this tick. */
  action: VersionDriftAction;
  /** Updated consecutive-deferral count to carry into the next tick. */
  deferrals: number;
  /** Human-readable log line. Present for every action except `'none'`. */
  message?: string;
}

/**
 * Decide whether the daemon should exit, defer, or force-exit for a version
 * drift this tick — the bounded escape hatch for PR #106's mid-turn deferral.
 *
 * Pure: holds no state. The caller persists `deferrals` across ticks and feeds
 * it back in; the reset-to-0 (drift cleared, or cleared-to-exit) happens here so
 * the caller never manages the counter directly.
 *
 *   - no drift                 → { action: 'none',       deferrals: 0 }
 *   - drift, no busy session   → { action: 'exit',       deferrals: 0 }   clean handoff
 *   - drift, busy, < cap       → { action: 'defer',      deferrals: n+1 } grace window
 *   - drift, busy, ≥ cap       → { action: 'force-exit', deferrals: n }   livelock escape
 *
 * With the default cap, drift+busy defers on ticks 1..maxDeferrals (counter
 * reaching maxDeferrals/maxDeferrals) and force-exits on the next busy tick.
 */
export function decideVersionDriftAction(
  input: VersionDriftDecisionInput,
): VersionDriftDecision {
  const maxDeferrals = input.maxDeferrals ?? MAX_DRIFT_DEFERRALS;

  if (!input.drift.drift) {
    return { action: 'none', deferrals: 0 };
  }

  const base = input.drift.message ?? '[daemon] Version drift detected.';

  // No session mid-turn: exit cleanly so the freshly-installed binary takes
  // over. Reset the counter so a later drift starts its grace window fresh.
  if (input.busyCount <= 0) {
    return { action: 'exit', deferrals: 0, message: base };
  }

  // A session is mid-turn. Once the grace window is exhausted, force the exit to
  // break the stuck-busy livelock; otherwise defer one more tick.
  if (input.deferrals >= maxDeferrals) {
    return {
      action: 'force-exit',
      deferrals: input.deferrals,
      message: `${base} — forcing upgrade after ${input.deferrals} deferral(s): ${input.busyCount} session(s) still mid-turn (their turn will be interrupted).`,
    };
  }

  const deferrals = input.deferrals + 1;
  return {
    action: 'defer',
    deferrals,
    message: `${base} — deferred (${deferrals}/${maxDeferrals}): ${input.busyCount} active session(s) mid-turn.`,
  };
}
