/**
 * Windows Task Scheduler path + label helpers — the win32 analog of
 * `launchd/paths.ts` and `systemd/paths.ts`.
 *
 * Tasks live in the root folder of the current user's task library.
 * Labels follow the convention `AFK-<name>` (e.g. `AFK-telegram`,
 * `AFK-daemon`) — shorter than a reverse-DNS label but unambiguous in
 * Task Scheduler's flat root namespace.
 *
 * The XML copy (the task definition file) lives under `<afk home>/service/`
 * so it travels with the rest of AFK state and can be inspected or removed
 * without opening the Task Scheduler GUI.
 *
 * @module service/windows/paths
 */

import { join } from 'path';
import { SERVICE_TIMEOUT_MS, serviceLogPath as sharedServiceLogPath } from '../types.js';
import { getAfkHome } from '../../paths.js';
import type { ServiceName } from '../types.js';

/** Task name (label) used with `schtasks /TN`. E.g. `AFK-telegram`. */
export function taskName(name: ServiceName): string {
  return `AFK-${name}`;
}

/**
 * Directory where AFK stores the task XML copies on disk.
 * Lives under `<afk home>/service/` to colocate all service state.
 */
export function windowsServiceDir(): string {
  return join(getAfkHome(), 'service');
}

/** Absolute path of the XML definition file stored on disk for a service. */
export function taskXmlPath(name: ServiceName): string {
  return join(windowsServiceDir(), `${taskName(name)}.xml`);
}

/**
 * Per-service log file under `~/.afk/logs/`. Re-export from shared types —
 * identical to the launchd/systemd log path so `afk service status`
 * reports the same file regardless of platform.
 */
export const serviceLogPath = sharedServiceLogPath;

/**
 * Hard cap on any `schtasks` invocation. Re-export from the shared
 * `SERVICE_TIMEOUT_MS` constant in `service/types.ts`.
 */
export const SCHTASKS_TIMEOUT_MS = SERVICE_TIMEOUT_MS;
