import { checkVersionDrift, readDiskVersion, UNKNOWN_VERSION } from '../../../utils/version-drift.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';
import { palette } from '../../palette.js';

declare const __AFK_VERSION__: string | undefined;

// Capture the loaded bundle, not the package.json which can change under it.
// Dev/tsx has no build literal, so deliberately disable the notice there.
const spawnedVersion = typeof __AFK_VERSION__ === 'string' ? __AFK_VERSION__ : UNKNOWN_VERSION;
export const VERSION_CHECK_INTERVAL_MS = 300_000;

/** Per-REPL state; no timer or automatic restart. Injectable seams for tests. */
export function createVersionNotice(
  runningVersion = spawnedVersion,
  readVersion: () => string = readDiskVersion,
  now: () => number = Date.now,
): () => string | undefined {
  let lastCheck: number | undefined;
  const warnedVersions = new Set<string>();
  return () => {
    if (!runningVersion || runningVersion === UNKNOWN_VERSION) return undefined;
    const time = now();
    if (lastCheck !== undefined && time - lastCheck < VERSION_CHECK_INTERVAL_MS) return undefined;
    lastCheck = time;
    const diskVersion = readVersion();
    if (!checkVersionDrift(runningVersion, diskVersion).drift || warnedVersions.has(diskVersion)) return undefined;
    warnedVersions.add(diskVersion);
    return palette.warning(
      `⚠ agent-afk was upgraded to v${sanitizeForDisplay(diskVersion)} while this session is running v${sanitizeForDisplay(runningVersion)}; restart this session to pick up fixes.`,
    );
  };
}
