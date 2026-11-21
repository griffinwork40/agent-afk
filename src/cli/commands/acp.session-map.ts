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
 * It also stores the canonical session `cwd` recorded at `session/new`, so a
 * later load or resume of a session that is not live can require the original
 * directory (profile §2).
 *
 * Contract:
 *   - The map is a flat JSON object written atomically. An entry is either a
 *     legacy string (the afkId) or `{ afkId?, cwd? }`.
 *   - readAcpSessionMap / writeAcpSessionMap are the only I/O entry-points;
 *     in-process read-modify-write updates are serialised through one queue.
 *   - resolveAcpId returns the afkId if mapped, otherwise the acpId itself
 *     (fast path: seeded id == journal id, no afkId needed).
 *   - recordAcpMapping is a no-op when acpId === afkId (fast path).
 *   - readAcpCwd is undefined for entries written before cwd was stored.
 *
 * @module cli/commands/acp.session-map
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getAcpSessionMapPath } from '../../paths.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';

export interface AcpSessionEntry { afkId?: string; cwd?: string }
export type AcpSessionMap = Record<string, string | AcpSessionEntry>;

function entryOf(value: unknown): AcpSessionEntry {
  if (typeof value === 'string') return { afkId: value };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const o = value as Record<string, unknown>;
  return {
    ...(typeof o['afkId'] === 'string' ? { afkId: o['afkId'] } : {}),
    ...(typeof o['cwd'] === 'string' ? { cwd: o['cwd'] } : {}),
  };
}

/** Compact form: a mapping without cwd stays a plain string (legacy shape). */
function packEntry(e: AcpSessionEntry): string | AcpSessionEntry {
  return e.cwd === undefined && e.afkId !== undefined ? e.afkId : e;
}

let updateQueue: Promise<void> = Promise.resolve();

/** Serialise read-modify-write updates so concurrent sessions do not drop entries. */
function updateEntry(acpId: string, patch: (e: AcpSessionEntry) => AcpSessionEntry): Promise<void> {
  const run = updateQueue.then(async () => {
    const map = readAcpSessionMap();
    map[acpId] = packEntry(patch(entryOf(map[acpId])));
    await writeAcpSessionMap(map);
  });
  updateQueue = run.catch(() => undefined);
  return run;
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

/**
 * Persist acpId → afkId when they differ. No-op on match (fast path).
 * Reads the existing map first to avoid clobbering other entries.
 */
export async function recordAcpMapping(acpId: string, afkId: string): Promise<void> {
  if (acpId === afkId) return;
  await updateEntry(acpId, (e) => ({ ...e, afkId }));
}

/** Settles once every update queued so far in this process has been written (or failed). */
export function acpSessionMapSettled(): Promise<void> {
  return updateQueue;
}

/** Persist the canonical session cwd for `acpId`, keeping any afkId mapping. */
export async function recordAcpCwd(acpId: string, cwd: string): Promise<void> {
  await updateEntry(acpId, (e) => ({ ...e, cwd }));
}

/** The canonical cwd stored for `acpId`, or undefined (legacy or unknown entry). */
export function readAcpCwd(acpId: string): string | undefined {
  return entryOf(readAcpSessionMap()[acpId]).cwd;
}

/**
 * Resolve an ACP wire id to the AFK journal id.
 * Returns the mapped afkId when present, otherwise acpId itself.
 */
export function resolveAcpId(acpId: string): string {
  return entryOf(readAcpSessionMap()[acpId]).afkId ?? acpId;
}
