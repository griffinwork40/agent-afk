/**
 * ACP id → AFK journal id mapping.
 *
 * The server mints an opaque UUID as the ACP wire sessionId (D1). It seeds
 * AgentConfig.sessionId with that UUID so initSessionId in the provider is the
 * same value and the journal is keyed by it. If the provider returns a
 * DIFFERENT id (e.g. a future provider that ignores the seed), this module
 * persists a durable mapping so subsequent load/resume can resolve the ACP id
 * to the actual journal id.
 *
 * The canonical session `cwd` is NOT stored here: it lives in a per-session
 * record (acp.session-record.ts). An earlier build stored it in this map as
 * `{ afkId?, cwd? }`; that shape still loads for id resolution only.
 *
 * Contract:
 *   - The map is a flat JSON object written atomically. An entry is a string
 *     (the afkId) or, from the earlier build, `{ afkId?, cwd? }` (cwd ignored).
 *   - readAcpSessionMap / writeAcpSessionMap are the only I/O entry-points.
 *   - resolveAcpId returns the afkId if mapped, otherwise the acpId itself
 *     (fast path: seeded id == journal id, no afkId needed); both shapes resolve.
 *   - recordAcpMapping is a no-op when acpId === afkId (fast path).
 *   - recordAcpMapping serializes concurrent writers via an O_EXCL advisory
 *     lock file (same directory as the map), retrying up to LOCK_RETRIES times
 *     with exponential backoff before giving up with an error.
 *
 * @module cli/commands/acp.session-map
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAcpSessionMapPath } from '../../paths.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';

export interface AcpSessionEntry { afkId?: string; cwd?: string }
export type AcpSessionMap = Record<string, string | AcpSessionEntry>;
// Note: `cwd` in AcpSessionEntry is from an earlier build; it is preserved on
// disk for forward-compatibility but is no longer read by this module.

function entryOf(value: unknown): AcpSessionEntry {
  if (typeof value === 'string') return { afkId: value };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const o = value as Record<string, unknown>;
  return {
    ...(typeof o['afkId'] === 'string' ? { afkId: o['afkId'] } : {}),
    ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'] } : {}),
  };
}

/** Read the map from disk. Returns {} on any read/parse error. */
export function readAcpSessionMap(): AcpSessionMap {
  try {
    const raw = readFileSync(getAcpSessionMapPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AcpSessionMap;
    }
    return {};
  } catch {
    return {};
  }
}

/** Atomically write the map to disk, creating the parent dir if needed. */
export async function writeAcpSessionMap(map: AcpSessionMap): Promise<void> {
  const dest = getAcpSessionMapPath();
  mkdirSync(dirname(dest), { recursive: true });
  await atomicWriteFileAsync(dest, JSON.stringify(map));
}

// ---------------------------------------------------------------------------
// Advisory lock for recordAcpMapping read-modify-write
// ---------------------------------------------------------------------------

const LOCK_RETRIES = 20;
const LOCK_BASE_MS = 10;

/** Absolute path to the advisory lock file for the session map. */
function mapLockPath(): string {
  return join(dirname(getAcpSessionMapPath()), 'session-map.lock');
}

/**
 * Acquire the O_EXCL advisory lock. Returns the fd on success, or throws
 * after `LOCK_RETRIES` attempts. Each attempt waits `LOCK_BASE_MS * 2^i` ms.
 */
async function acquireMapLock(): Promise<number> {
  const lock = mapLockPath();
  mkdirSync(dirname(lock), { recursive: true });
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      return openSync(lock, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_BASE_MS * Math.pow(2, i)));
  }
  throw new Error('acp session-map lock contested after retries');
}

function releaseMapLock(fd: number, lock: string): void {
  try { closeSync(fd); } catch { /* best-effort */ }
  try { unlinkSync(lock); } catch { /* best-effort */ }
}

/**
 * Persist acpId → afkId when they differ. No-op on match (fast path).
 * Serializes concurrent writers via an O_EXCL advisory lock file so two
 * `afk acp` processes cannot drop each other's mapping.
 */
export async function recordAcpMapping(acpId: string, afkId: string): Promise<void> {
  if (acpId === afkId) return;
  const lock = mapLockPath();
  const fd = await acquireMapLock();
  try {
    const map = readAcpSessionMap();
    map[acpId] = afkId;
    await writeAcpSessionMap(map);
  } finally {
    releaseMapLock(fd, lock);
  }
}

/**
 * Resolve an ACP wire id to the AFK journal id.
 * Returns the mapped afkId when present, otherwise acpId itself.
 */
export function resolveAcpId(acpId: string): string {
  return entryOf(readAcpSessionMap()[acpId]).afkId ?? acpId;
}
