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

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { writeJsonFile, readJsonFileLoose } from '../../utils/json-file.js';
import { getFacetCacheDir, getSessionJournalPath, getSessionLedgerPath, getSessionsDir, getSubagentJournalPath, getTraceDir, isSafeLedgerSessionId, validateSessionId } from '../../paths.js';
import { journalExists, listSubagentJournals, readJournalRecords } from '../journal/reader.js';
import { isMessageJournalDisabled } from '../journal/noop.js';
import { journalRecordsToToolEvents, summarizeSubagentJournal } from './journal-adapter.js';
import { deriveSessionFacet } from './derive.js';
import {
  FACET_VERSION,
  SessionFacetSchema,
  StoredSessionInputSchema,
  type SessionFacet,
  type StoredSessionInput,
  type SubagentToolSummary,
  type ToolEventInput,
} from './schema.js';
import { parseTraceSignals, type TraceSignals } from './derive.trace.js';

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
  // readJsonFileLoose: ENOENT and parse errors both yield undefined. Unexpected
  // I/O errors (EACCES, EISDIR) re-throw — a permission problem on the sessions
  // dir should surface rather than silently treating every session as missing.
  // Zod schema validation still runs below to reject structurally invalid sidecars.
  const raw = readJsonFileLoose<unknown>(path);
  if (raw == null) return undefined;
  const parsed = StoredSessionInputSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function readCachedFacet(cachePath: string): SessionFacet | undefined {
  // readJsonFileLoose: ENOENT and parse errors return undefined (cache miss →
  // re-derive). Unexpected I/O errors re-throw. Zod validates the schema.
  const raw = readJsonFileLoose<unknown>(cachePath);
  if (raw == null) return undefined;
  const parsed = SessionFacetSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function writeFacet(cachePath: string, facet: SessionFacet): void {
  // Atomic write via writeJsonFile: serialises to a sibling temp file with a
  // random suffix (crypto.randomBytes), then renames into place. A crash
  // mid-write never leaves a torn cache file; rename is atomic on POSIX.
  // writeJsonFile also creates parent dirs (mkdirp: true by default).
  writeJsonFile(cachePath, facet);
}

/**
 * A cached facet is fresh iff it was produced by the current FACET_VERSION and
 * neither the session sidecar nor any journal file is newer than the mtime
 * recorded in the facet. `effectiveMtimeMs` is max(sidecar, journal mtimes).
 */
function isFresh(cached: SessionFacet, effectiveMtimeMs: number): boolean {
  return cached.facet_version === FACET_VERSION && cached.source_session_mtime_ms === effectiveMtimeMs;
}

/**
 * Safe mtime read — returns 0 on any error (missing path, permission error).
 */
function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Attempt to read journal records for a session and return the derived events
 * plus the max journal mtime (parent + subagent journals). Returns undefined
 * when the journal is disabled, absent, or unreadable (safe fallback to
 * sidecar). Never throws.
 */
function tryReadJournal(sessionId: string, sessionsDir: string): {
  parentEvents: ToolEventInput[];
  subagentBreakdown: SubagentToolSummary[];
  journalMtimeMs: number;
} | undefined {
  try {
    if (isMessageJournalDisabled()) return undefined;
    // The journal reader always resolves under the default sessions dir. When a
    // caller overrides `sessionsDir` (e.g. `afk insights --afk-home`), a journal
    // found there would belong to a different home — use the sidecar instead.
    if (resolve(sessionsDir) !== resolve(getSessionsDir())) return undefined;
    if (!journalExists(sessionId)) return undefined;

    const records = readJournalRecords(sessionId);
    const parentEvents = journalRecordsToToolEvents(records);

    // Subagent journals
    const subagentIds = listSubagentJournals(sessionId);
    const subagentBreakdown = subagentIds.map((subId) => {
      const subRecords = readJournalRecords(sessionId, { subagentId: subId });
      return summarizeSubagentJournal(subId, subRecords);
    });

    // Compute effective journal mtime: max of parent + all subagent journal files
    let journalMtimeMs = safeMtimeMs(getSessionJournalPath(sessionId));
    for (const subId of subagentIds) {
      try {
        const subPath = getSubagentJournalPath(sessionId, subId);
        const subMtime = safeMtimeMs(subPath);
        if (subMtime > journalMtimeMs) journalMtimeMs = subMtime;
      } catch {
        // ignore invalid subagent id
      }
    }

    return { parentEvents, subagentBreakdown, journalMtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Read a stale cached facet loosely — raw JSON without strict schema
 * validation — so callers can extract fields that exist in old facet versions
 * (e.g. v6) that predate required fields added in later versions. Returns null
 * on missing file, parse error, or non-object JSON.
 *
 * Contract: callers must not assume the returned object matches SessionFacet —
 * use only the specific fields they need and treat all others as potentially
 * absent.
 */
function readCachedFacetLoose(cachePath: string): Record<string, unknown> | null {
  // readJsonFileLoose: ENOENT and parse errors return undefined → null (no
  // carry-forward). This matches the original "missing file or parse error →
  // return null" contract. Unexpected I/O errors re-throw.
  const raw = readJsonFileLoose<unknown>(cachePath);
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * Extract yield_tracking fields from a loosely-read cached facet. Returns null
 * when the cached file has no yield_tracking or the fields are absent.
 *
 * Used by getOrDeriveFacet to carry forward yield_tracking on version bumps
 * (#2777): the yield probe runs only at session end, so without this carry-
 * forward a FACET_VERSION bump permanently erases existing produced_pr /
 * pr_merged / pr_url data for all previously-probed sessions.
 */
function extractLooseYieldTracking(loose: Record<string, unknown> | null): {
  produced_pr: boolean | null;
  pr_merged: boolean | null;
  pr_url: string | null | undefined;
} | null {
  if (!loose) return null;
  const yt = loose['yield_tracking'];
  if (!yt || typeof yt !== 'object') return null;
  const obj = yt as Record<string, unknown>;
  const produced_pr = typeof obj['produced_pr'] === 'boolean' ? obj['produced_pr'] : null;
  const pr_merged = typeof obj['pr_merged'] === 'boolean' ? obj['pr_merged'] : null;
  const pr_url = typeof obj['pr_url'] === 'string' ? obj['pr_url'] : null;
  // Only return non-null result when at least one meaningful field is set
  if (produced_pr === null && pr_merged === null && pr_url === null) return null;
  return { produced_pr, pr_merged, pr_url };
}

/**
 * Attempt to read trace signals for a session by locating the witness trace
 * through the session ledger's `meta.traceLabel`. Returns undefined when:
 * - the ledger file is absent (old session, tracing disabled);
 * - no `meta` record with a non-null `traceLabel` is found;
 * - the trace file does not exist;
 * - any I/O error occurs.
 *
 * Callers treat `undefined` as "no trace data → no signal" — never a
 * downgrade. This is intentional: absence of data must not downgrade (#2798).
 *
 * Returns `{ signals, traceMtimeMs }` so the caller can fold `traceMtimeMs`
 * into `effectiveMtimeMs` for staleness checks — a facet cached before an
 * async trace flush should be invalidated by a later trace write.
 *
 * Synchronous so it fits into the existing sync I/O pattern of store.ts.
 */
function tryReadTraceSignals(
  sessionId: string,
  sessionsDir: string,
): { signals: TraceSignals; traceMtimeMs: number } | undefined {
  try {
    // Only resolve the ledger under the default sessions dir. When the caller
    // has overridden sessionsDir (e.g. `afk insights --afk-home`), we might
    // be looking at a different home — skip trace-signal extraction, same
    // policy as tryReadJournal.
    if (resolve(sessionsDir) !== resolve(getSessionsDir())) return undefined;
    if (!isSafeLedgerSessionId(sessionId)) return undefined;

    const ledgerPath = getSessionLedgerPath(sessionId);
    if (!existsSync(ledgerPath)) return undefined;

    // Read the ledger file synchronously and scan for the `meta` record that
    // carries `traceLabel`. Only the first `meta` record is meaningful.
    const ledgerContent = readFileSync(ledgerPath, 'utf8');
    let traceLabel: string | null | undefined;
    for (const rawLine of ledgerContent.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as Record<string, unknown>;
        if (rec['kind'] === 'meta' && 'traceLabel' in rec) {
          const tl = rec['traceLabel'];
          traceLabel = typeof tl === 'string' ? tl : null;
          break;
        }
      } catch {
        // malformed line — skip
      }
    }

    // `null` means tracing was explicitly disabled for this session.
    if (traceLabel == null) return undefined;

    // Defense-in-depth: the traceLabel comes from the ledger file (external
    // data). Guard it with the same safety check applied to the sessionId so
    // it never reaches getTraceDir/validateSessionId with a bad value.
    if (!isSafeLedgerSessionId(traceLabel)) return undefined;

    const tracePath = join(getTraceDir(traceLabel), 'trace.jsonl');
    if (!existsSync(tracePath)) return undefined;

    const traceMtimeMs = safeMtimeMs(tracePath);
    const traceContent = readFileSync(tracePath, 'utf8');
    return { signals: parseTraceSignals(traceContent), traceMtimeMs };
  } catch {
    return undefined;
  }
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

  // Read journal once per session — never per-facet. Falls back to undefined
  // (sidecar path) when the journal is absent, disabled, or unreadable.
  const journalData = tryReadJournal(sessionId, sessionsDir);

  // Read trace signals BEFORE the isFresh check so the trace file's mtime can
  // participate in effectiveMtimeMs. A facet cached before the async trace
  // flush would otherwise never be invalidated by a later trace write.
  // We load the session sidecar first only to resolve session.sessionId for the
  // override-id case (Finding 2). In the no-override case the sidecar load is
  // a cheap no-op that is repeated below with the same result.
  const sessionForId = loadStoredSession(sessionId, sessionsDir);
  // Use the SDK session ID from the sidecar when it differs from the sidecar
  // filename. getSessionLedgerPath needs the SDK ID because the ledger lives
  // under ~/.afk/state/sessions/<SDK-sessionId>/.
  const traceSessionId = sessionForId?.sessionId ?? sessionId;
  const traceResult = tryReadTraceSignals(traceSessionId, sessionsDir);

  // Effective mtime for staleness: max(sidecar, journal, trace file) so a
  // journal append or an async trace flush after the sidecar is saved still
  // triggers a re-derive.
  let effectiveMtimeMs = journalData !== undefined
    ? Math.max(sessionMtimeMs, journalData.journalMtimeMs)
    : sessionMtimeMs;
  if (traceResult !== undefined) {
    effectiveMtimeMs = Math.max(effectiveMtimeMs, traceResult.traceMtimeMs);
  }

  if (!options.force) {
    const cached = readCachedFacet(cachePath);
    if (cached && isFresh(cached, effectiveMtimeMs)) return cached;
  }

  // Read the stale cached facet loosely (before re-derive) so we can carry
  // forward yield_tracking fields. The yield probe runs asynchronously only at
  // session end, so a version bump would otherwise permanently erase
  // produced_pr / pr_merged / pr_url for all previously-probed sessions.
  // Contract: only carry forward when the new derive left the field null (never
  // downgrade a non-null value set by the probe) — see item 7 in #2777.
  const staleCached = readCachedFacetLoose(cachePath);
  const staleYield = extractLooseYieldTracking(staleCached);

  // Re-use the already-loaded sidecar; fall back to a fresh load (defensive
  // against the unlikely case the first load returned undefined but the file
  // now exists — same file so in practice identical).
  const session = sessionForId ?? loadStoredSession(sessionId, sessionsDir);
  if (!session) return undefined;

  const traceSignals = traceResult?.signals;

  const facet = deriveSessionFacet(session, {
    sourceSessionPath: sessionPath,
    sourceSessionMtimeMs: effectiveMtimeMs,
    ...(journalData !== undefined
      ? {
          journalEvents: journalData.parentEvents,
          subagentBreakdown: journalData.subagentBreakdown,
        }
      : {}),
    ...(traceSignals !== undefined ? { traceSignals } : {}),
  });

  // Carry forward yield fields that the new derivation left null (#2777).
  // Contract: never downgrade — if derive already set produced_pr=true (from
  // a detected gh pr create URL), keep that; only fill in from stale when null.
  // Each field is filled independently, so a probed pr_merged survives even
  // when the new derive itself detected the PR (produced_pr already true).
  if (staleYield !== null) {
    const yt = facet.yield_tracking;
    const producedPr = yt.produced_pr ?? staleYield.produced_pr;
    facet.yield_tracking = {
      ...yt,
      produced_pr: producedPr,
      pr_merged: producedPr === true ? (yt.pr_merged ?? staleYield.pr_merged) : null,
      pr_url: yt.pr_url ?? staleYield.pr_url ?? null,
    };
  }

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
