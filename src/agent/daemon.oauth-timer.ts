/**
 * Proactive OAuth token refresh timer for the long-running daemon (#1296).
 *
 * Problem: a long-lived daemon may hold an OAuth access token that expires
 * hours into its run. The per-request 401-retry path (auth-retry-tier.ts)
 * only fires on an actual API call, so if the token expires between tasks
 * there is no request to trigger a refresh — the next task simply fails
 * with 401 and the daemon cannot recover.
 *
 * Fix: install a background setInterval that calls the injected refresher
 * periodically. The refresher is a no-op when the token is still valid
 * (keychain.ts checks `expiresAt + REFRESH_MARGIN_MS` before hitting the
 * network), so the interval cost is negligible.
 *
 * The timer is `unref()`'d so it does not prevent `process.exit()` in
 * `--once` runs or tests that don't call `stop()`.
 *
 * @module agent/daemon.oauth-timer
 */

/** Default refresh interval: 4 hours. Claude Code OAuth tokens expire after
 *  ~8 hours, so a 4-hour interval refreshes well before the halfway point. */
export const DEFAULT_OAUTH_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Install a background OAuth refresh timer if `refresher` is provided.
 * Returns the timer handle (or undefined), suitable for `clearInterval` in
 * the daemon's `stop()` handler.
 */
export function startOAuthRefreshTimer(
  refresher: (() => Promise<unknown>) | undefined,
  intervalMs: number = DEFAULT_OAUTH_REFRESH_INTERVAL_MS,
): ReturnType<typeof setInterval> | undefined {
  if (refresher === undefined) return undefined;
  const timer = setInterval(() => {
    void refresher().catch(() => {
      // Errors are suppressed — the per-request 401 retry remains the
      // last-resort safety net. A failed proactive refresh is not fatal.
      process.stderr.write('agent-afk [daemon]: proactive OAuth token refresh failed\n');
    });
  }, intervalMs);
  timer.unref();
  return timer;
}
