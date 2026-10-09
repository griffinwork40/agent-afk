/**
 * Disk-IO helpers extracted from SessionManager.
 *
 * Covers loading and saving per-route SessionData sidecars and the filename
 * convention that keeps the General-topic layout byte-identical to the
 * pre-topics era.
 *
 * Invariant: all state mutations go through explicit parameters so this module
 * is stateless and testable in isolation. SessionManager delegates to these
 * helpers; its public surface is unchanged.
 *
 * @module telegram/session-manager.disk-io
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { type TelegramRoute, routeKey } from './route.js';
import type { SessionData } from './session-manager.js';
import { isErrnoCode } from '../utils/errors.js';
import { writeJsonFileAsync } from '../utils/json-file.js';

/**
 * The on-disk sidecar filename for a route's SessionData.
 *
 * Invariant: a General route's file is `<chatId>.json` -- byte-identical to
 * the pre-topics layout, so an existing user's session data loads unchanged.
 * A topic route uses its routeKey (`<chatId>:<threadId>`). The `:` separator
 * is legal on the macOS/Linux targets AFK supports; the loader recomputes the
 * map key from the data's chatId+threadId, so it never relies on the filename.
 */
export function sidecarFileName(data: SessionData): string {
  const route: TelegramRoute = { chatId: data.chatId };
  if (data.threadId !== undefined) route.threadId = data.threadId;
  return `${routeKey(route)}.json`;
}

/**
 * Load session data from disk into `sessionData`.
 *
 * Keys the in-memory map by the route recomputed from each file's payload
 * (chatId + optional threadId), NOT the filename -- so a legacy `<chatId>.json`
 * (no threadId) loads to the General key `String(chatId)` exactly as before,
 * and a topic sidecar loads to `<chatId>:<threadId>`.
 */
export async function loadSessionsFromDisk(
  dataDir: string,
  sessionData: Map<string, SessionData>,
  onEachRoute: (route: TelegramRoute, data: SessionData) => void,
): Promise<void> {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const files = await fs.readdir(dataDir);

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = join(dataDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const data: SessionData = JSON.parse(content);
        const route: TelegramRoute = { chatId: data.chatId };
        if (data.threadId !== undefined) route.threadId = data.threadId;
        sessionData.set(routeKey(route), data);
        try {
          onEachRoute(route, data);
        } catch {
          // non-fatal: registry error should not skip remaining sidecars
        }
      }
    }
  } catch (error) {
    // Ignore errors if directory doesn't exist
    if (!isErrnoCode(error, 'ENOENT')) {
      console.error('Failed to load sessions:', error);
    }
  }
}

/**
 * Save session data to disk, one file per route (General -> `<chatId>.json`).
 */
export async function saveSessionsToDisk(
  dataDir: string,
  sessionData: Map<string, SessionData>,
): Promise<void> {
  try {
    for (const data of sessionData.values()) {
      const filePath = join(dataDir, sidecarFileName(data));
      // Atomic write: writeJsonFileAsync uses tmp+rename (mkdirp by default).
      await writeJsonFileAsync(filePath, data);
    }
  } catch (error) {
    console.error('Failed to save sessions:', error);
  }
}
