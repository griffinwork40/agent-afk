/**
 * macOS launchd integration — generate, install, and remove per-user
 * LaunchAgent plists for AFK long-running services (telegram bot, daemon).
 *
 * Why this exists: `afk telegram start` and `afk daemon` spawn detached
 * processes with PID files in `~/.afk/state/`, which survive shell close
 * but NOT machine reboot, OOM-kill, or crash. A LaunchAgent with
 * `KeepAlive=true` + `RunAtLoad=true` provides true "always on" behavior
 * — relaunch on crash, restart on login, optional auto-restart on rebuild
 * via `WatchPaths`.
 *
 * Scope is intentionally per-user (`~/Library/LaunchAgents/`), not
 * system-wide (`/Library/LaunchDaemons/`):
 *   - The services read secrets from `~/.afk/config/afk.env` — that's
 *     `$HOME`. A LaunchDaemon runs as root with no `$HOME`.
 *   - PID file, logs, sessions all live under `~/.afk/`. Two users running
 *     the same bot token would collide on Telegram's `getUpdates` poller.
 *   - The bot doesn't need to poll while the user is logged out.
 *
 * Important interactions with the existing process managers:
 *   - For the telegram bot, launchd runs `node <dist/telegram.mjs>`
 *     directly — NOT `afk telegram start`, which is a spawn-and-detach
 *     wrapper and would exit immediately, triggering an endless KeepAlive
 *     restart loop. Running the entrypoint directly makes launchd the
 *     supervisor.
 *   - The PID file at `~/.afk/state/telegram/bot.pid` is NOT written when
 *     launchd is the supervisor — `afk telegram status` will report
 *     "stopped" even though the bot is running. `afk service status` is
 *     the correct introspection surface for launchd-managed instances.
 *
 * Tested without side effects: plist generation, path resolvers, and
 * label conventions are pure. The install/uninstall I/O calls (`launchctl
 * bootstrap`, file writes) are kept thin so manual integration testing on
 * a real Mac stays cheap.
 *
 * @module service/launchd
 */

import { homedir } from 'os';
import { join } from 'path';
import { getLogsDir } from '../../paths.js';

/** Service kinds AFK can register with launchd. */
export type ServiceName = 'telegram' | 'daemon';

/** All recognised service names. Single source of truth for CLI validation. */
export const SERVICE_NAMES: readonly ServiceName[] = ['telegram', 'daemon'];

/** Reverse-DNS label convention used in plist filenames and launchctl IDs. */
export function labelFor(name: ServiceName): string {
  return `com.afk.${name}`;
}

/** Per-user LaunchAgent directory. Never `/Library/LaunchAgents`. */
export function launchAgentsDir(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents');
}

/** Absolute path of the plist file for a given service. */
export function plistPath(name: ServiceName, home: string = homedir()): string {
  return join(launchAgentsDir(home), `${labelFor(name)}.plist`);
}

/** Per-service log file path under `~/.afk/logs/`. Mirrors stdout+stderr. */
export function serviceLogPath(name: ServiceName): string {
  return join(getLogsDir(), `service-${name}.log`);
}

/**
 * Where the user's gui session live for `launchctl` Tiger/Catalina+ syntax.
 * Modern launchctl requires `gui/<uid>` domain targets.
 */
export function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/**
 * Hard cap on how long we let any `launchctl` invocation run before we
 * give up. macOS occasionally wedges launchctl during system shutdown or
 * while a security-policy daemon (e.g. ManagedClient) is updating XPC
 * bindings — without a timeout the AFK CLI hangs forever waiting for
 * status or bootstrap to complete.
 *
 * 8 seconds (P-16/17) covers bootstrap/bootout which take ~50–500 ms
 * normally, with generous head-room for a slow XPC handshake, while
 * still being well inside user-perceptible "this is broken" territory.
 * The legacy LAUNCHCTL_LIST_TIMEOUT_MS kept 5 s for the read-only path;
 * we unify on 8 s so the same constant covers all callsites.
 */
export const LAUNCHCTL_TIMEOUT_MS = 8_000;


