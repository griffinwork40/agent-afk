/**
 * Layering-safe session-name resolver for the agent layer.
 *
 * Resolves a caller-supplied human name (e.g. "having-this-convo-w-andrew-what")
 * to its corresponding SDK `sessionId` by scanning the session sidecar files
 * under `~/.afk/state/sessions/`.
 *
 * Layering: this module reads sidecar JSON directly via `getSessionsDir()` from
 * `../../paths.js` — it does NOT import from `src/cli/session-store` so that
 * the agent-layer invariant (`src/agent/ must not depend on src/cli/`) is
 * preserved. The same pattern is used by `src/agent/facets/store.ts`.
 *
 * Resolution order mirrors `findSession()` in `src/cli/session-store.ts`:
 *   1. Exact match on sidecar filename id
 *   2. Exact match on `.sessionId`
 *   3. Exact match on `.name`
 *   4. Unique prefix match on `.name` (≥ MIN_PREFIX_LEN chars)
 *
 * Returns the resolved SDK `sessionId`, or `undefined` when no match is found.
 *
 * @module agent/trace/session-name-resolver
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getSessionsDir } from '../../paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The minimal subset of a sidecar we need for name resolution. */
interface SidecarMinimal {
  sessionId?: string;
  name?: string;
  savedAt?: number;
}

/** How a session was resolved (for callers that want to log/debug). */
export type ResolveReason = 'exact-id' | 'exact-session-id' | 'exact-name' | 'prefix-name';

export interface ResolvedSession {
  /** The SDK session id (i.e. `StoredSession.sessionId`). */
  sessionId: string;
  /** The sidecar file id (basename of the `.json` file, without extension). */
  sidecarId: string;
  reason: ResolveReason;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum length of a prefix query to prevent single-character wildcards. */
const MIN_PREFIX_LEN = 3;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseSidecar(filePath: string): SidecarMinimal | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof raw !== 'object' || raw === null) return undefined;
    const o = raw as Record<string, unknown>;
    return {
      sessionId: typeof o['sessionId'] === 'string' ? o['sessionId'] : undefined,
      name: typeof o['name'] === 'string' ? o['name'] : undefined,
      savedAt: typeof o['savedAt'] === 'number' ? o['savedAt'] : undefined,
    };
  } catch {
    return undefined;
  }
}

interface SidecarEntry {
  sidecarId: string;
  filePath: string;
  data: SidecarMinimal;
}

function loadAllSidecars(sessionsDir: string): SidecarEntry[] {
  if (!existsSync(sessionsDir)) return [];
  let files: string[];
  try {
    files = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const entries: SidecarEntry[] = [];
  for (const fname of files) {
    if (!fname.endsWith('.json')) continue;
    const filePath = join(sessionsDir, fname);
    const data = parseSidecar(filePath);
    if (!data) continue;
    entries.push({ sidecarId: basename(fname, '.json'), filePath, data });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a caller-supplied string (human name, sidecar id, or SDK session id)
 * to a `ResolvedSession`. Returns `undefined` when no match is found.
 *
 * Pass `sessionsDir` to override the default `getSessionsDir()` (useful in
 * tests that redirect `$AFK_HOME`).
 */
export function resolveSessionByName(
  idOrName: string,
  sessionsDir: string = getSessionsDir(),
): ResolvedSession | undefined {
  const entries = loadAllSidecars(sessionsDir);

  // Sort by savedAt descending (newest first) so that when multiple sessions
  // share the same name, the newest one wins — mirroring the listSessions()
  // sort in src/cli/session-store.ts. Entries missing savedAt sort last.
  entries.sort((a, b) => {
    const aTime = a.data.savedAt ?? -Infinity;
    const bTime = b.data.savedAt ?? -Infinity;
    return bTime - aTime;
  });

  // Pass 1: exact matches (sidecar id, sessionId, name)
  for (const entry of entries) {
    if (entry.sidecarId === idOrName) {
      const sessionId = entry.data.sessionId ?? entry.sidecarId;
      return { sessionId, sidecarId: entry.sidecarId, reason: 'exact-id' };
    }
    if (entry.data.sessionId === idOrName) {
      return { sessionId: entry.data.sessionId, sidecarId: entry.sidecarId, reason: 'exact-session-id' };
    }
    if (entry.data.name === idOrName) {
      const sessionId = entry.data.sessionId ?? entry.sidecarId;
      return { sessionId, sidecarId: entry.sidecarId, reason: 'exact-name' };
    }
  }

  // Pass 2: unique prefix match on name (≥ MIN_PREFIX_LEN chars to avoid noise)
  if (idOrName.length >= MIN_PREFIX_LEN) {
    const prefixMatches = entries.filter(
      (e) => e.data.name !== undefined && e.data.name.startsWith(idOrName),
    );
    if (prefixMatches.length === 1) {
      const only = prefixMatches[0]!;
      const sessionId = only.data.sessionId ?? only.sidecarId;
      return { sessionId, sidecarId: only.sidecarId, reason: 'prefix-name' };
    }
  }

  return undefined;
}
