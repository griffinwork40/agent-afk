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
 * Contract:
 *   - The map is a flat JSON object { [acpId]: afkId } written atomically.
 *   - readAcpSessionMap / writeAcpSessionMap are the only I/O entry-points.
 *   - resolveAcpId returns the afkId if mapped, otherwise the acpId itself
 *     (fast path: seeded id == journal id, no entry needed).
 *   - recordAcpMapping is a no-op when acpId === afkId (fast path).
 *
 * @module cli/commands/acp.session-map
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getAcpSessionMapPath } from '../../paths.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';

export type AcpSessionMap = Record<string, string>;

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
  map[acpId] = afkId;
  await writeAcpSessionMap(map);
}

/**
 * Resolve an ACP wire id to the AFK journal id.
 * Returns the mapped afkId when present, otherwise acpId itself.
 */
export function resolveAcpId(acpId: string): string {
  const map = readAcpSessionMap();
  return map[acpId] ?? acpId;
}
