/**
 * Handler for the `get_facet` built-in tool.
 *
 * Returns a structured, filtered session facet as JSON. Supports "latest",
 * "current" / "self", session ID, or session name resolution.
 *
 * Resolution semantics:
 *   - `"latest"`: the most recently modified sealed session whose sidecar `cwd`
 *     matches `context.resolveBase`. Falls back to the global newest when no
 *     cwd match exists. Response includes `cwd_mismatch: true` on fallback.
 *   - `"current"` / `"self"`: the session that invoked this tool call, resolved
 *     from `context.sessionId`. Falls back to `"latest"` when context is absent.
 *   - any other string: resolved by the session-name resolver (ID, name, prefix).
 *
 * New response fields added regardless of `fields`:
 *   - `session_cwd`: the `cwd` recorded in the session sidecar (may be absent
 *     for legacy sidecars).
 *   - `is_current_session`: true only when the session was resolved via the
 *     `"current"`/`"self"` alias path (not when an explicit id coincidentally
 *     matches the caller's sessionId).
 *   - `cwd_mismatch`: true when `session_cwd` differs from `context.resolveBase`
 *     (i.e., a cross-cwd session was returned).
 *
 * Filters internal provenance fields from default output.
 *
 * @module agent/tools/handlers/get-facet
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getOrDeriveFacet, listSessionIds } from '../../facets/index.js';
import { getSessionsDir } from '../../../paths.js';
import { resolveSessionByName } from '../../trace/session-name-resolver.js';
import { FACET_INTERNAL_FIELDS } from '../schemas.facet.js';
import { readRecord } from '../../outcomes/store.js';
import type { ToolHandler } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SidecarCwdSlice {
  mtimeMs: number;
  cwd: string | undefined;
}

/**
 * Number of bytes to read from the start of a sidecar file to extract `cwd`.
 * The `cwd` key is always in the first few top-level fields of a sidecar, so
 * 2 KiB is far more than needed even for sidecars with long session names.
 */
const SIDECAR_PREFIX_BYTES = 2048;

/**
 * Regex that extracts the value of the top-level `"cwd"` key from a JSON
 * prefix. Handles the standard JSON encoding: any character except unescaped
 * backslash or double-quote inside the string value.
 */
const CWD_FIELD_RE = /"cwd"\s*:\s*"((?:[^\\"]|\\.)*)"/;

/**
 * Read the mtime and `cwd` field from a session sidecar cheaply.
 *
 * Reads only the first {@link SIDECAR_PREFIX_BYTES} bytes rather than the full
 * sidecar (which contains all turns and can be several MB). The `cwd` key
 * appears in the first handful of top-level fields, so the prefix always
 * covers it. Falls back to returning `cwd: undefined` when the field is absent
 * in the prefix (e.g. legacy sidecars that pre-date the field).
 *
 * Returns undefined when the file is unreadable.
 */
function readSidecarCwdSlice(path: string): SidecarCwdSlice | undefined {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(SIDECAR_PREFIX_BYTES);
    const bytesRead = readSync(fd, buf, 0, SIDECAR_PREFIX_BYTES, 0);
    const prefix = buf.slice(0, bytesRead).toString('utf-8');
    const m = CWD_FIELD_RE.exec(prefix);
    // JSON.parse the matched value to unescape any backslash sequences (e.g.
    // Windows paths with \\). Wrapping in quotes makes it a valid JSON string.
    let cwd: string | undefined;
    if (m) {
      try {
        cwd = JSON.parse(`"${m[1]}"`) as string;
      } catch {
        cwd = m[1]; // fallback: use raw match if re-parse fails
      }
    }
    return { mtimeMs: stat.mtimeMs, cwd };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

/**
 * Resolve the `"latest"` session id, preferring sessions whose sidecar `cwd`
 * matches `callerCwd`. Falls back to the global newest when no match.
 *
 * Returns `{ id, cwdMatch, cwd }` — `cwdMatch` is true when the winner came
 * from the cwd-filtered pass. `cwd` is the winner's sidecar cwd so callers
 * do not need to re-read the sidecar.
 */
function resolveLatest(
  ids: string[],
  sessionsDir: string,
  callerCwd: string | undefined,
): { id: string; cwdMatch: boolean; cwd: string | undefined } | undefined {
  let bestGlobal: { id: string; mtimeMs: number; cwd: string | undefined } | undefined;
  let bestCwd: { id: string; mtimeMs: number; cwd: string | undefined } | undefined;

  for (const id of ids) {
    const slice = readSidecarCwdSlice(join(sessionsDir, `${id}.json`));
    if (!slice) continue;

    const { mtimeMs, cwd } = slice;

    if (!bestGlobal || mtimeMs > bestGlobal.mtimeMs) {
      bestGlobal = { id, mtimeMs, cwd };
    }

    if (callerCwd !== undefined && cwd === callerCwd) {
      if (!bestCwd || mtimeMs > bestCwd.mtimeMs) {
        bestCwd = { id, mtimeMs, cwd };
      }
    }
  }

  if (bestCwd) return { id: bestCwd.id, cwdMatch: true, cwd: bestCwd.cwd };
  if (bestGlobal) return { id: bestGlobal.id, cwdMatch: false, cwd: bestGlobal.cwd };
  return undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const getFacetHandler: ToolHandler = async (input, _signal, context) => {
  const obj = (input ?? {}) as Record<string, unknown>;
  const sessionArg = typeof obj['session'] === 'string' ? obj['session'] : 'latest';
  const fields = Array.isArray(obj['fields']) ? (obj['fields'] as string[]) : null;

  const callerSessionId = context?.sessionId;
  const callerCwd = context?.resolveBase;

  let sessionId: string | undefined;
  let cwdMismatch = false;
  // Track the cwd from the winning sidecar so we avoid a second read later.
  // Only set when the session was resolved via resolveLatest.
  let latestWinnerCwd: string | undefined;
  // True when the session was resolved by name/id (explicit-id path), meaning
  // we must call readSidecarCwdSlice once below to get the cwd.
  let resolvedByName = false;
  // True when the caller used "current"/"self" and provided a callerSessionId.
  // In this case the resolved session IS the current session by definition,
  // even if the sidecar filename stem differs from the SDK-assigned sessionId.
  let isSelfResolution = false;

  const isSelfAlias = sessionArg === 'current' || sessionArg === 'self';

  if (isSelfAlias) {
    // Resolve to the caller's own session. Fall back to "latest" when context is absent.
    if (callerSessionId) {
      // Route through name resolver so an SDK id that differs from the sidecar
      // filename stem still resolves correctly (Item 4).
      const resolved = resolveSessionByName(callerSessionId);
      if (resolved) {
        sessionId = resolved.sidecarId;
        resolvedByName = true;
        // Only mark isSelfResolution when the resolved session is genuinely the
        // caller's — i.e. when its stored sessionId equals callerSessionId.
        isSelfResolution = resolved.sessionId === callerSessionId;
      } else {
        // Resolution failed (sidecar not yet flushed / swept). Fall through to
        // "latest" semantics rather than handing a bare SDK id to getOrDeriveFacet
        // (which would look for a <sdk-id>.json that does not exist).
        const ids = listSessionIds();
        if (ids.length > 0) {
          const sessionsDir = getSessionsDir();
          const winner = resolveLatest(ids, sessionsDir, callerCwd);
          sessionId = winner?.id;
          latestWinnerCwd = winner?.cwd;
          cwdMismatch = winner ? !winner.cwdMatch : false;
        }
      }
    } else {
      // No context — fall through to "latest" semantics.
      const ids = listSessionIds();
      if (ids.length > 0) {
        const sessionsDir = getSessionsDir();
        const winner = resolveLatest(ids, sessionsDir, callerCwd);
        sessionId = winner?.id;
        latestWinnerCwd = winner?.cwd;
        cwdMismatch = winner ? !winner.cwdMatch : false;
      }
    }
  } else if (sessionArg === 'latest') {
    const ids = listSessionIds();
    if (ids.length > 0) {
      const sessionsDir = getSessionsDir();
      const winner = resolveLatest(ids, sessionsDir, callerCwd);
      sessionId = winner?.id;
      latestWinnerCwd = winner?.cwd;
      cwdMismatch = winner ? !winner.cwdMatch : false;
    }
  } else {
    const resolved = resolveSessionByName(sessionArg);
    sessionId = resolved?.sidecarId;
    resolvedByName = true;
  }

  if (!sessionId) {
    return { content: `Session not found: ${sessionArg}`, isError: true };
  }

  const facet = getOrDeriveFacet(sessionId);
  if (!facet) {
    return { content: `Session not found: ${sessionArg}`, isError: true };
  }

  // Join VerifiedOutcome record when present — read-only, never affects
  // existing facet fields. Absent means no record yet (not an error).
  const outcomeRecord = readRecord(sessionId);

  // Read session_cwd from the sidecar. For the "latest" and isSelfAlias-fallback
  // paths the cwd was already extracted by resolveLatest (no second read).
  // For the explicit-id path (resolveSessionByName) we call readSidecarCwdSlice
  // once here.
  let sessionCwd: string | undefined;
  if (resolvedByName) {
    const sessionsDir = getSessionsDir();
    const slice = readSidecarCwdSlice(join(sessionsDir, `${sessionId}.json`));
    sessionCwd = slice?.cwd;
  } else {
    sessionCwd = latestWinnerCwd;
  }

  // is_current_session: true only when the session was resolved via the
  // "current"/"self" alias path and the resolved session is genuinely the
  // caller's own (isSelfResolution). An explicit-name lookup that coincidentally
  // resolves to the same id as the caller MUST NOT set this to true — the flag
  // is meant to indicate intentional self-inspection, not accidental id collision.
  const isCurrentSession = isSelfResolution;

  // When no callerCwd is available, cwd_mismatch stays false (not a cross-cwd call).
  // When callerCwd is set but sessionCwd is unknown, also stays false (Item 3).
  // Guard: only recompute cwdMismatch for the explicit-id path when callerCwd is set;
  // the latest and self-alias paths already set cwdMismatch correctly via resolveLatest
  // when callerCwd is present. The callerCwd-absent reset (false) still runs
  // unconditionally because resolveLatest returns cwdMatch:false when no callerCwd is
  // given, which would incorrectly set cwdMismatch to true on the latest/self paths.
  if (callerCwd === undefined) {
    cwdMismatch = false;
  } else if (resolvedByName) {
    if (sessionCwd !== undefined) {
      cwdMismatch = sessionCwd !== callerCwd;
    } else {
      // callerCwd set but sessionCwd unknown — Item 3.
      cwdMismatch = false;
    }
  }

  const raw = facet as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const exclude = new Set<string>(FACET_INTERNAL_FIELDS);

  if (fields && fields.length > 0) {
    for (const f of fields) {
      if (f === 'verified_outcome') {
        result[f] = outcomeRecord ?? null;
      } else {
        result[f] = raw[f];
      }
    }
  } else {
    for (const [k, v] of Object.entries(raw)) {
      if (!exclude.has(k)) result[k] = v;
    }
    if (outcomeRecord !== undefined) {
      result['verified_outcome'] = outcomeRecord;
    }
  }

  // Append resolution-context fields (always present, even in fields-filtered mode).
  result['session_cwd'] = sessionCwd ?? null;
  result['is_current_session'] = isCurrentSession;
  result['cwd_mismatch'] = cwdMismatch;

  return { content: JSON.stringify(result, null, 2) };
};
