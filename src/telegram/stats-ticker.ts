/**
 * Periodic daemon tick for the Telegram bot: session stats + version-drift
 * watchdog.
 *
 * Extracted from `src/telegram.ts`'s `main()`. Previously this lived inside a
 * `setInterval` closure in the entrypoint, so the deferral state machine it
 * drives — including the `MAX_DRIFT_DEFERRALS` livelock escape hatch — could
 * only be exercised by running a real bot for hours. The decision logic itself
 * already lived in `version-check.ts`; this module is the loop around it.
 */

import { checkVersionDrift, decideVersionDriftAction } from './version-check.js';
import { readDiskVersion, UNKNOWN_VERSION } from './daemon-version.js';

/**
 * Exit code for a version-drift restart signal.
 *
 * On Windows the Telegram bot runs as a Task Scheduler task whose only
 * relaunch rule is `<RestartOnFailure>` — it fires only on a non-zero exit
 * code.  A clean exit (0) leaves the bot dead after an update.
 *
 * On macOS (launchd KeepAlive) and Linux (systemd Restart=always) the
 * supervisor relaunches after ANY exit, so code 1 is equally harmless there.
 *
 * Using 1 on win32 and 0 everywhere else keeps the semantics correct across
 * all three platforms without changing the installed task definition.
 */
export const DRIFT_EXIT_CODE: number = process.platform === 'win32' ? 1 : 0;

/** Default tick period: 5 minutes. 12 deferrals at this rate ≈ 1h of grace. */
export const STATS_TICK_MS = 300000;

/** The slice of `TelegramBot` this ticker needs. */
export interface StatsTickerBot {
  getStats(): { activeSessions: number; totalChats: number };
  getBusySessionCount(): number;
}

export interface StatsTickerOptions {
  bot: StatsTickerBot;
  /** Version the daemon was spawned at, captured once at startup. */
  spawnedVersion: string;
  intervalMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  exit?: (code: number) => void;
  readVersion?: () => string;
}

/**
 * Run one tick: log stats, then evaluate version drift.
 *
 * Returns the updated consecutive-deferral count. Held by the caller rather
 * than this function because it must survive between ticks, while
 * `decideVersionDriftAction` stays pure.
 */
export function runStatsTick(
  options: StatsTickerOptions & { deferrals: number },
): number {
  const { bot, spawnedVersion, deferrals } = options;
  const log = options.log ?? console.log;
  const warn = options.warn ?? console.warn;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const readVersion = options.readVersion ?? readDiskVersion;

  const stats = bot.getStats();
  log(`\n📊 Stats: ${stats.activeSessions} active sessions, ${stats.totalChats} total chats`);

  // Version drift check — re-reads package.json and compares to the startup
  // version. Exits so the updated binary takes over on the supervisor's next
  // restart: launchd KeepAlive (macOS) and systemd Restart=always (Linux)
  // relaunch after exit 0; Task Scheduler RestartOnFailure (Windows) requires
  // a non-zero code — see DRIFT_EXIT_CODE.
  try {
    const diskVersion = readVersion();
    if (diskVersion === UNKNOWN_VERSION) {
      // Invariant: skip WITHOUT touching the deferral count. A transiently
      // unreadable package.json must not reset progress toward the livelock
      // escape hatch below.
      warn('⚠️ [daemon] Could not re-read package.json for version drift check — skipping.');
      return deferrals;
    }
    const result = checkVersionDrift(spawnedVersion, diskVersion);

    // Invariant: never exit mid-turn — but never defer forever either.
    // The drift-exit hands the chat off to a freshly-installed binary via
    // launchd KeepAlive; exiting while a session is streaming severs the
    // in-flight turn (plus its queued messages and sub-agent dispatch), and
    // the cold relaunch cannot resume it ("An unexpected error occurred").
    // So defer while any session is mid-turn (PR #106). The bounded escape
    // hatch: a session wedged in processing/streaming would otherwise defer
    // the upgrade forever (stuck-busy livelock), so after MAX_DRIFT_DEFERRALS
    // deferrals (~1h at the 5-min tick) force the exit anyway.
    const busy = result.drift ? bot.getBusySessionCount() : 0;
    const decision = decideVersionDriftAction({
      drift: result,
      busyCount: busy,
      deferrals,
    });
    switch (decision.action) {
      case 'none':
        break;
      case 'defer':
        if (decision.message !== undefined) log(`⚠️ ${decision.message}`);
        break;
      case 'exit':
      case 'force-exit':
        if (decision.message !== undefined) log(`⚠️ ${decision.message}`);
        exit(DRIFT_EXIT_CODE);
    }
    return decision.deferrals;
  } catch {
    warn('⚠️ [daemon] Could not re-read package.json for version drift check — skipping.');
    return deferrals;
  }
}

/**
 * Start the recurring stats + drift tick. Returns the timer so the shutdown
 * path can clear it.
 */
export function startStatsTicker(options: StatsTickerOptions): NodeJS.Timeout {
  // Consecutive version-drift deferrals across ticks. Held here (not in
  // decideVersionDriftAction, which is pure) so it survives between ticks;
  // reset to 0 whenever drift clears or we exit.
  let driftDeferrals = 0;
  return setInterval(() => {
    driftDeferrals = runStatsTick({ ...options, deferrals: driftDeferrals });
  }, options.intervalMs ?? STATS_TICK_MS);
}
