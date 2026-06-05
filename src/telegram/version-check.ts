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
