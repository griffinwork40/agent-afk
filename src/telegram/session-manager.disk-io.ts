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
 * Encode a routeKey into a filename-safe string.
 *
 * Invariant: General routes (`<chatId>` only) are byte-identical to the
 * pre-topics filename so existing users' sidecars load unchanged.
 * Topic routes replace the `:` separator with `~` — colons are illegal in
 * Windows filenames (NTFS rejects them at the CreateFile level), so
 * `900:7.json` can never be written on Windows.  `~` is safe on all
 * platforms (POSIX, NTFS, FAT32, exFAT).
 *
 * Encoding contract: only the chatId~threadId segment uses `~`; chatIds and
 * threadIds are always non-negative integers, so `~` is unambiguous and no
 * further escaping is needed.
 */
export function encodeRouteFilename(key: string): string {
  // routeKey returns either "<chatId>" (General) or "<chatId>:<threadId>".
  // Replace the single colon separator with ~ for filename safety.
  return key.replace(':', '~');
}

/**
 * Decode a filename stem back to a routeKey.
 *
 * Reverses `encodeRouteFilename`.  Legacy files that still contain a `:`
 * (written on POSIX before this fix) are returned unchanged — they already
 * ARE a valid routeKey and the loader derives the in-memory key from the
 * JSON payload anyway, not from the filename.
 */
export function decodeRouteFilename(stem: string): string {
  // New encoding: ~ → :
  return stem.replace('~', ':');
}

/**
 * The on-disk sidecar filename for a route's SessionData.
 *
 * Invariant: a General route's file is `<chatId>.json` -- byte-identical to
 * the pre-topics layout, so an existing user's session data loads unchanged.
 * A topic route uses `<chatId>~<threadId>.json` (tilde, not colon) so the
 * filename is legal on Windows.  The loader recomputes the map key from the
 * JSON payload's chatId+threadId, so it never relies on the filename.
 */
export function sidecarFileName(data: SessionData): string {
  const route: TelegramRoute = { chatId: data.chatId };
  if (data.threadId !== undefined) route.threadId = data.threadId;
  return `${encodeRouteFilename(routeKey(route))}.json`;
}

/**
 * Load session data from disk into `sessionData`.
 *
 * Keys the in-memory map by the route recomputed from each file's payload
 * (chatId + optional threadId), NOT the filename -- so a legacy `<chatId>.json`
 * (no threadId) loads to the General key `String(chatId)` exactly as before,
 * a new-style `<chatId>~<threadId>.json` loads correctly, and a legacy
 * POSIX-only `<chatId>:<threadId>.json` also loads (colon filenames can exist
 * on POSIX systems written before this fix).
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
        // Invariant: derive the registry key from the JSON payload, not the
        // filename, so both legacy colon-named files and new tilde-named files
        // resolve to the same in-memory key.
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
