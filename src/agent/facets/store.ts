/**
 * Facet store — lazy derive-on-read with a write-through disk cache.
 *
 * `getOrDeriveFacet(id)` returns the cached facet when it is still fresh
 * (same FACET_VERSION and derived from the current session sidecar), otherwise
 * it loads the session, derives a facet, writes it through to the cache, and
 * returns it. Repeated reads of an unchanged session never rewrite the cache.
 *
 * Layering: this module reads session JSON directly via getSessionsDir() and
 * validates it with the LOCAL StoredSessionInputSchema — it does NOT import
 * the session-store loader from src/cli/ (src/agent must not depend on src/cli).
 *
 * All directory inputs are injectable so tests can point at temp dirs without
 * touching $AFK_HOME.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { getFacetCacheDir, getSessionsDir, validateSessionId } from '../../paths.js';
import { deriveSessionFacet } from './derive.js';
import {
  FACET_VERSION,
  SessionFacetSchema,
  StoredSessionInputSchema,
  type SessionFacet,
  type StoredSessionInput,
} from './schema.js';

export interface FacetStoreOptions {
  /** Override the session sidecar directory (default: getSessionsDir()). */
  sessionsDir?: string;
  /** Override the facet cache directory (default: getFacetCacheDir()). */
  cacheDir?: string;
  /** Re-derive and rewrite even when a fresh cache entry exists. */
  force?: boolean;
}

function sessionPathFor(sessionId: string, sessionsDir: string): string {
  validateSessionId(sessionId);
  return join(sessionsDir, `${sessionId}.json`);
}

function cachePathFor(sessionId: string, cacheDir: string): string {
  validateSessionId(sessionId);
  return join(cacheDir, `${sessionId}.json`);
}

/** Load + validate a persisted session sidecar. Returns undefined on miss/corruption. */
export function loadStoredSession(
  sessionId: string,
  sessionsDir: string = getSessionsDir(),
): StoredSessionInput | undefined {
  const path = sessionPathFor(sessionId, sessionsDir);
  if (!existsSync(path)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = StoredSessionInputSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readCachedFacet(cachePath: string): SessionFacet | undefined {
  if (!existsSync(cachePath)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(cachePath, 'utf8'));
    const parsed = SessionFacetSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function writeFacet(cachePath: string, facet: SessionFacet): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  // Atomic write: serialize to a sibling temp file then rename into place, so a
  // crash mid-write can never leave a torn cache file (rename is atomic on the
  // same filesystem). The .pid suffix avoids collisions between concurrent writers.
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(facet, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, cachePath);
}

/**
 * A cached facet is fresh iff it was produced by the current FACET_VERSION and
 * the session sidecar has not been modified since the facet was derived.
 */
function isFresh(cached: SessionFacet, sessionMtimeMs: number): boolean {
  return cached.facet_version === FACET_VERSION && cached.source_session_mtime_ms === sessionMtimeMs;
}

/**
 * Return the facet for `sessionId`, deriving + caching on a miss or when the
 * cache is stale. Returns undefined if the session sidecar does not exist.
 */
export function getOrDeriveFacet(
  sessionId: string,
  options: FacetStoreOptions = {},
): SessionFacet | undefined {
  const sessionsDir = options.sessionsDir ?? getSessionsDir();
  const cacheDir = options.cacheDir ?? getFacetCacheDir();
  const sessionPath = sessionPathFor(sessionId, sessionsDir);
  if (!existsSync(sessionPath)) return undefined;

  const sessionMtimeMs = statSync(sessionPath).mtimeMs;
  const cachePath = cachePathFor(sessionId, cacheDir);

  if (!options.force) {
    const cached = readCachedFacet(cachePath);
    if (cached && isFresh(cached, sessionMtimeMs)) return cached;
  }

  const session = loadStoredSession(sessionId, sessionsDir);
  if (!session) return undefined;

  const facet = deriveSessionFacet(session, {
    sourceSessionPath: sessionPath,
    sourceSessionMtimeMs: sessionMtimeMs,
  });
  writeFacet(cachePath, facet);
  return facet;
}

/** List all persisted session ids (sidecar filenames, sans `.json`). */
export function listSessionIds(options: Pick<FacetStoreOptions, 'sessionsDir'> = {}): string[] {
  const sessionsDir = options.sessionsDir ?? getSessionsDir();
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => basename(f, '.json'));
}
