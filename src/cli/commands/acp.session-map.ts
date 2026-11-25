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

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getAcpSessionMapPath } from '../../paths.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import { checkJournalExists } from '../../agent/journal/reader.js';

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
const LOCK_MAX_MS = 500;

/** Absolute path to the advisory lock file for the session map. */
function mapLockPath(): string {
  return join(dirname(getAcpSessionMapPath()), 'session-map.lock');
}

/**
 * Acquire the O_EXCL advisory lock. Returns the lock token on success, or
 * throws after `LOCK_RETRIES` attempts. Each attempt waits `LOCK_BASE_MS *
 * 2^i` ms. The token format is `${pid}:${timestamp}:${uuid}` — written into
 * the lock file so stale-lock detection can verify both that the holder PID
 * is alive AND that it is the same instance that acquired the lock (guards
 * against PID reuse between the kill(0) check and the unlink).
 */
async function acquireMapLock(): Promise<string> {
  const lock = mapLockPath();
  mkdirSync(dirname(lock), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, token);
      closeSync(fd);
      return token;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Check for dead holder — stale lock from a killed process.
      try {
        const rawToken = readFileSync(lock, 'utf8').trim();
        const pid = parseInt(rawToken.split(':')[0] ?? '', 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 0);
            // PID is alive. Guard against PID reuse: re-read the token and
            // only treat as a live contender if the full token still matches
            // what we first read. If it changed, another process already
            // re-acquired the lock — fall through to sleep and retry.
            try {
              const currentToken = readFileSync(lock, 'utf8').trim();
              if (currentToken !== rawToken) {
                // Token changed: lock was re-acquired between our two reads.
                // Fall through to sleep.
              }
              // Token unchanged: genuine live holder — fall through to sleep.
            } catch { /* can't re-read — treat as live */ }
          } catch (killErr) {
            if ((killErr as NodeJS.ErrnoException).code === 'ESRCH') {
              // Holder is dead. TOCTOU guard: re-read token before unlinking.
              // If the token changed, a new holder already re-acquired the
              // lock — skip the unlink and fall through to sleep.
              try {
                const recheck = readFileSync(lock, 'utf8').trim();
                if (recheck !== rawToken) {
                  // New holder present — do not unlink. Fall through to sleep.
                } else {
                  // Token still matches the dead PID — safe to remove stale lock.
                  try { unlinkSync(lock); } catch { /* already gone or re-acquired */ }
                  continue;
                }
              } catch {
                // Can't re-read — assume another process grabbed it; do not unlink.
              }
            }
            // EPERM: process exists but we can't signal it — treat as alive.
            // Also falls through here when ESRCH + token-changed path above.
          }
        }
      } catch { /* can't read token — treat lock as live */ }
    }
    if (i < LOCK_RETRIES - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(LOCK_BASE_MS * Math.pow(2, i), LOCK_MAX_MS)));
    }
  }
  throw new Error('acp session-map lock contested after retries');
}

function releaseMapLock(token: string, lock: string): void {
  try {
    // Only unlink if the token still matches what we wrote.  A concurrent
    // caller may have cleared a stale lock and re-acquired it between our
    // last write and now; unlinking unconditionally would evict the new
    // holder's live lock.
    const current = readFileSync(lock, 'utf8').trim();
    if (current === token) unlinkSync(lock);
  } catch { /* lock already gone or unreadable — nothing to release */ }
}

/**
 * Persist acpId → afkId when they differ. No-op on match (fast path).
 * Serializes concurrent writers via an O_EXCL advisory lock file so two
 * `afk acp` processes cannot drop each other's mapping.
 */
export async function recordAcpMapping(acpId: string, afkId: string): Promise<void> {
  if (acpId === afkId) return;
  const lock = mapLockPath();
  const token = await acquireMapLock();
  try {
    const map = readAcpSessionMap();
    map[acpId] = afkId;
    await writeAcpSessionMap(map);
  } finally {
    releaseMapLock(token, lock);
  }
}

/**
 * Remove a stale acpId → afkId mapping from the session map.
 * Called by acp.session-load when the mapped journal no longer exists so
 * the same dead entry is not re-resolved on every future load attempt.
 * Serialized via the same O_EXCL lock as recordAcpMapping.
 *
 * Re-checks journal existence after acquiring the lock to guard the race
 * window between the caller's initial check and the lock acquisition: a
 * concurrent session/new for the same acpId may have written a fresh record
 * and mapping in that interval. If the journal now exists, the entry is live
 * and must not be deleted.
 */
export async function deleteAcpMapping(acpId: string): Promise<void> {
  const lock = mapLockPath();
  const token = await acquireMapLock();
  try {
    // Re-check inside the lock: a concurrent writer may have created the
    // journal between our caller's check and here.
    const afkId = resolveAcpId(acpId);
    if (checkJournalExists(afkId) === 'exists') return;
    const map = readAcpSessionMap();
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete map[acpId];
    await writeAcpSessionMap(map);
  } finally {
    releaseMapLock(token, lock);
  }
}

/**
 * Resolve an ACP wire id to the AFK journal id.
 * Returns the mapped afkId when present, otherwise acpId itself.
 */
export function resolveAcpId(acpId: string): string {
  return entryOf(readAcpSessionMap()[acpId]).afkId ?? acpId;
}
