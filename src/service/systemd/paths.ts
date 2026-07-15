/**
 * systemd `--user` path + label helpers — the Linux analog of
 * `launchd/paths.ts`.
 *
 * Units live in the per-user generator dir `~/.config/systemd/user/`
 * (XDG default; `$XDG_CONFIG_HOME` is not yet honoured — tracked as a
 * follow-up). Per-user (not `/etc/systemd/system/`) for the same reasons
 * launchd uses LaunchAgents over LaunchDaemons: the services read secrets
 * from `~/.afk/config/afk.env` ($HOME) and write PID/logs/sessions under
 * `~/.afk/`, so a root/system unit with no $HOME would break them.
 *
 * @module service/systemd/paths
 */

import { homedir } from 'os';
import { join } from 'path';
import { getLogsDir } from '../../paths.js';
import type { ServiceName } from '../types.js';

/** Per-user systemd generator directory. Never `/etc/systemd/system`. */
export function systemdUserDir(home: string = homedir()): string {
  return join(home, '.config', 'systemd', 'user');
}

/** `.service` unit filename for a service, e.g. `afk-telegram.service`. */
export function unitFileName(name: ServiceName): string {
  return `afk-${name}.service`;
}

/**
 * `.path` unit filename — the systemd equivalent of launchd `WatchPaths`.
 * A `.path` unit with `PathModified=` restarts the paired `.service` when
 * the watched file changes (auto-restart-on-rebuild in a dev tree).
 */
export function pathUnitFileName(name: ServiceName): string {
  return `afk-${name}.path`;
}

/**
 * Oneshot restart-helper unit filename triggered by the `.path` unit. A
 * plain `start` on an already-active `Restart=always` service is a no-op,
 * so the `.path` unit activates this oneshot instead, which runs
 * `systemctl --user restart` on the real service. See `unit.ts`'s
 * `renderRestartUnit`.
 */
export function restartUnitFileName(name: ServiceName): string {
  return `afk-${name}-restart.service`;
}

/** Absolute path of the `.service` unit file. */
export function unitPath(name: ServiceName, home: string = homedir()): string {
  return join(systemdUserDir(home), unitFileName(name));
}

/** Absolute path of the companion `.path` unit file. */
export function pathUnitPath(name: ServiceName, home: string = homedir()): string {
  return join(systemdUserDir(home), pathUnitFileName(name));
}

/** Absolute path of the oneshot restart-helper unit file. */
export function restartUnitPath(name: ServiceName, home: string = homedir()): string {
  return join(systemdUserDir(home), restartUnitFileName(name));
}

/** Unit label used in CLI output and `systemctl --user` targets. */
export function systemdLabel(name: ServiceName): string {
  return unitFileName(name);
}

/**
 * Per-service log file under `~/.afk/logs/`. Identical to the launchd
 * backend's log path so `afk service status` reports the same file
 * regardless of platform.
 */
export function serviceLogPath(name: ServiceName): string {
  return join(getLogsDir(), `service-${name}.log`);
}

/**
 * Hard cap on any `systemctl --user` invocation. Mirrors launchd's
 * LAUNCHCTL_TIMEOUT_MS rationale: a wedged DBus/user-manager handshake
 * must not hang the AFK CLI forever.
 */
export const SYSTEMCTL_TIMEOUT_MS = 8_000;
