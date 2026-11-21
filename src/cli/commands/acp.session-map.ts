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
 * `{ afkId?, cwd? }`; that shape still loads, and its `cwd` is readable through
 * readLegacyAcpCwd as a fallback for sessions without a record.
 *
 * Contract:
 *   - The map is a flat JSON object written atomically. An entry is a string
 *     (the afkId) or, from the earlier build, `{ afkId?, cwd? }`.
 *   - readAcpSessionMap / writeAcpSessionMap are the only I/O entry-points.
 *   - resolveAcpId returns the afkId if mapped, otherwise the acpId itself
 *     (fast path: seeded id == journal id, no afkId needed); both shapes resolve.
 *   - recordAcpMapping is a no-op when acpId === afkId (fast path); it is the
 *     only writer and keeps a legacy `cwd` already in the entry.
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
  const map = readAcpSessionMap();
  const legacyCwd = entryOf(map[acpId]).cwd;
  map[acpId] = legacyCwd === undefined ? afkId : { afkId, cwd: legacyCwd };
  await writeAcpSessionMap(map);
}

/**
 * Read-only: the `cwd` an earlier build stored in the map entry for `acpId`,
 * or undefined (string entry, unknown id, or no `cwd`). Nothing writes it now.
 */
export function readLegacyAcpCwd(acpId: string): string | undefined {
  return entryOf(readAcpSessionMap()[acpId]).cwd;
}

/**
 * Resolve an ACP wire id to the AFK journal id.
 * Returns the mapped afkId when present, otherwise acpId itself.
 */
export function resolveAcpId(acpId: string): string {
  return entryOf(readAcpSessionMap()[acpId]).afkId ?? acpId;
}
