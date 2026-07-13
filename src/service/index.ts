/**
 * Service-manager entry point. `serviceManagerFor(platform)` selects the
 * backend for the host OS, replacing the old single `assertMacOS()` gate
 * in `cli/commands/service.ts`.
 *
 * Platform is a parameter defaulting to `process.platform` — the same
 * injected-platform shape `src/cli/clipboard.ts` uses — so the dispatch is
 * unit-testable without stubbing globals.
 *
 * @module service
 */

import { launchdManager } from './launchd/manager.js';
import { systemdManager } from './systemd/manager.js';
import type { ServiceManager } from './types.js';

export * from './types.js';

/**
 * Return the {@link ServiceManager} for `platform`, or `null` when AFK
 * has no service backend for it (e.g. win32). Callers render a clear
 * "not supported on <platform>" message on null.
 */
export function serviceManagerFor(platform: NodeJS.Platform = process.platform): ServiceManager | null {
  switch (platform) {
    case 'darwin':
      return launchdManager;
    case 'linux':
      return systemdManager;
    default:
      return null;
  }
}

/** Human-readable list of supported platforms, for CLI error copy. */
export const SUPPORTED_SERVICE_PLATFORMS = 'macOS (launchd) and Linux (systemd --user)';
