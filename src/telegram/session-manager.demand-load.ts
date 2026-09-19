/**
 * On-demand sidecar reload for Telegram SessionManager.
 *
 * P2-2 fix (#1687): when the periodic eviction removes a route's in-memory
 * sessionData after 24 h of inactivity, the on-disk sidecar (`<dataDir>/<key>.json`)
 * still carries the user's persisted `model` and `cwd` preferences. Without a
 * demand-load path, the next access returns the manager default — silently losing
 * the user's settings until the next bot restart and `loadSessions()` call.
 *
 * This module exposes a synchronous `demandLoadSidecar` helper that reads and
 * parses the sidecar file in one blocking call and populates `sessionData`. The
 * blocking read is intentional: `getModel()` and `getCwd()` are synchronous
 * public methods — making them async would break every downstream caller. The
 * sidecar files are small (< 1 KB each) and this path fires only after 24 h of
 * no activity, so the blocking cost is negligible.
 *
 * @module telegram/session-manager.demand-load
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { SessionData } from './session-manager.js';
import type { TelegramRoute } from './route.js';
import { routeKey } from './route.js';

/**
 * Attempt to load a route's SessionData from its on-disk sidecar, populating
 * `sessionData` when the file exists. No-ops silently when the file is absent
 * or unparseable — callers fall through to their existing defaults.
 *
 * Invariant: the sidecar filename follows the same convention as
 * `SessionManager.sidecarFileName` — General routes use `<chatId>.json`,
 * topic routes use `<chatId>:<threadId>.json`. This function recomputes the
 * same path so it does not depend on a live SessionManager instance.
 *
 * @param dataDir - The bot's session-data directory (same as SessionManager.options.dataDir)
 * @param sessionData - The live in-memory map to populate when a sidecar is found
 * @param route - The route whose sidecar to load
 * @returns The loaded SessionData when found, undefined otherwise
 */
export function demandLoadSidecar(
  dataDir: string,
  sessionData: Map<string, SessionData>,
  route: TelegramRoute,
): SessionData | undefined {
  const key = routeKey(route);
  // Already in memory — nothing to do.
  if (sessionData.has(key)) return sessionData.get(key);

  const filePath = join(dataDir, `${key}.json`);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as SessionData;
    sessionData.set(key, data);
    return data;
  } catch {
    // ENOENT (never messaged) or parse error — return undefined; callers use defaults.
    return undefined;
  }
}
