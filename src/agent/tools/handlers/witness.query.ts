/**
 * Query logic for witness-layer trace search.
 *
 * Two operations:
 *   - `readSessionTrace()` — read/filter events from one session's trace
 *   - `searchAcrossSessions()` — text-search across recent sessions' traces
 *
 * Both consume raw NDJSON from `trace.jsonl` files. No index, no SQLite —
 * at current corpus size (~2 K sessions, ~444 MB) a linear scan is fast
 * enough and avoids sweep/index coordination issues.
 *
 * Invariant: this module is read-only. It never writes to or mutates the
 * witness layer. It tolerates partially-written (live or crashed) traces —
 * malformed lines are silently skipped, never fatal.
 *
 * @module agent/tools/handlers/witness.query
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getTraceDir } from '../../../paths.js';
import { readLedger } from '../../session-ledger.js';
import { listTraces, resolveLatestSession } from '../../trace/listing.js';
import type { TraceEvent } from '../../trace/index.js';
import { readTraceSafe } from './witness.query.io.js';
import { parseJsonlLines } from '../../../utils/jsonl.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default event limit per query. */
const DEFAULT_LIMIT = 50;

/** Hard ceiling on events returned. */
export const MAX_LIMIT = 200;

/** Hard ceiling on total matches returned by cross-session search. */
export const MAX_SEARCH_MATCHES = 200;

/** Default number of sessions to scan for cross-session search. */
const DEFAULT_SESSION_COUNT = 20;

/** Hard ceiling on sessions to scan. */
const MAX_SESSION_COUNT = 100;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal structural guard — matches `looksLikeEvent` in trace.ts. */
function isTraceEvent(v: unknown): v is TraceEvent {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['kind'] === 'string' &&
    typeof o['seq'] === 'number' &&
    typeof o['payload'] === 'object' &&
    o['payload'] !== null
  );
}

/** Parse NDJSON content into trace events, skipping malformed lines. */
function parseEvents(content: string): TraceEvent[] {
  return parseJsonlLines<TraceEvent>(content, { guard: isTraceEvent });
}

/** Clamp a limit value to [1, MAX_LIMIT], defaulting to DEFAULT_LIMIT. */
export function clampLimit(raw: unknown): number {
  if (typeof raw !== 'number') return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.round(raw)), MAX_LIMIT);
}

/** Clamp session count to [1, MAX_SESSION_COUNT]. */
export function clampSessions(raw: unknown): number {
  if (typeof raw !== 'number') return DEFAULT_SESSION_COUNT;
  return Math.min(Math.max(1, Math.round(raw)), MAX_SESSION_COUNT);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

interface EventFilter {
  kinds?: Set<string>;
  toolName?: string;
  errorsOnly?: boolean;
}

function matchesFilter(event: TraceEvent, filter: EventFilter): boolean {
  if (filter.kinds && !filter.kinds.has(event.kind)) return false;

  // toolName filter: reject ALL non-tool_call events when a name is specified.
  if (filter.toolName) {
    if (event.kind !== 'tool_call') return false;
    const payload = event.payload as { name?: string };
    if (payload.name !== filter.toolName) return false;
  }

  if (filter.errorsOnly) {
    if (event.kind === 'tool_call') {
      const payload = event.payload as { phase?: string; isError?: boolean };
      if (payload.phase !== 'completed' || !payload.isError) return false;
    } else if (event.kind === 'subagent_lifecycle') {
      const payload = event.payload as { transition?: string };
      if (payload.transition !== 'failed') return false;
    } else if (event.kind === 'background_agent') {
      const payload = event.payload as { transition?: string };
      if (payload.transition !== 'failed') return false;
    } else {
      // For non-error-bearing event kinds, errors_only filters them out.
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// read_witness: single-session trace reader
// ---------------------------------------------------------------------------

export interface ReadWitnessParams {
  session?: string;
  kinds?: string[];
  toolName?: string;
  errorsOnly?: boolean;
  limit?: number;
}

export interface ReadWitnessResult {
  sessionId: string;
  events: TraceEvent[];
  totalInTrace: number;
  filtered: number;
  /** Present when tracing was disabled for the session. */
  note?: string;
}

export async function readSessionTrace(
  params: ReadWitnessParams,
): Promise<ReadWitnessResult> {
  const sessionId = params.session === 'latest' || !params.session
    ? await resolveLatestSession()
    : params.session;

  if (!sessionId) {
    return { sessionId: '(none)', events: [], totalInTrace: 0, filtered: 0 };
  }

  // getTraceDir calls validateSessionId which rejects path-traversal attempts.
  let tracePath = join(getTraceDir(sessionId), 'trace.jsonl');

  // If the direct path doesn't exist, attempt ledger-based label resolution.
  // Fresh sessions store the witness dir under a random UUID label; the session
  // ledger's `meta` record maps session id → trace label.
  if (!existsSync(tracePath)) {
    try {
      for await (const rec of readLedger(sessionId)) {
        if (rec.kind !== 'meta') continue;
        if (rec.traceLabel === null) {
          // Session ran with tracing disabled.
          return {
            sessionId,
            events: [],
            totalInTrace: 0,
            filtered: 0,
            note: `Session "${sessionId}" ran with tracing disabled (traceLabel: null).`,
          };
        }
        if (typeof rec.traceLabel === 'string' && rec.traceLabel.length > 0) {
          const relabeled = join(getTraceDir(rec.traceLabel), 'trace.jsonl');
          if (existsSync(relabeled)) {
            tracePath = relabeled;
          }
        }
        break; // meta is always the first record
      }
    } catch {
      // Ledger unreadable — fall through to empty result gracefully.
    }
  }

  const { content } = await readTraceSafe(tracePath);
  const allEvents = parseEvents(content);

  const filter: EventFilter = {
    kinds: params.kinds ? new Set(params.kinds) : undefined,
    toolName: params.toolName,
    errorsOnly: params.errorsOnly,
  };

  const limit = clampLimit(params.limit);
  const matched: TraceEvent[] = [];

  // Reverse scan: collect the N most recent matching events.
  for (let i = allEvents.length - 1; i >= 0; i--) {
    const ev = allEvents[i]!;
    if (matchesFilter(ev, filter)) {
      matched.push(ev);
      if (matched.length >= limit) break;
    }
  }

  // Return in chronological order (oldest first).
  matched.reverse();

  return {
    sessionId,
    events: matched,
    totalInTrace: allEvents.length,
    filtered: matched.length,
  };
}

// ---------------------------------------------------------------------------
// search_witness: cross-session text search
// ---------------------------------------------------------------------------

export interface SearchWitnessParams {
  query: string;
  sessions?: number;
  kinds?: string[];
  since?: string;
}

export interface SearchMatch {
  sessionId: string;
  event: TraceEvent;
  /** The line that matched the query (for context). */
  matchLine: string;
}

export interface SearchWitnessResult {
  query: string;
  /**
   * Sessions in the requested window (top-N slice) before the `since` date
   * filter was applied. Use this to tell "few sessions exist" from "the date
   * filter excluded most of them".
   */
  sessionsAvailable: number;
  /**
   * Sessions actually read (after both the top-N slice and any `since` filter,
   * and stopping early once MAX_SEARCH_MATCHES is reached).
   * Renamed from the previous `sessionsScanned` which only reported this
   * post-filter count, making it indistinguishable from "only N sessions exist".
   */
  sessionsSearched: number;
  /**
   * @deprecated Use sessionsSearched. Alias kept for backward compatibility.
   */
  sessionsScanned: number;
  matches: SearchMatch[];
  /**
   * Session IDs whose trace files exceeded the 2 MB per-session read cap.
   * Events before the cap boundary are not visible to this search; matches
   * may be incomplete for these sessions. Only present when at least one
   * session was truncated.
   */
  truncatedSessions?: string[];
}

export async function searchAcrossSessions(
  params: SearchWitnessParams,
): Promise<SearchWitnessResult> {
  const sessionCount = clampSessions(params.sessions);
  const allTraces = await listTraces();

  // Slice first (N most recent sessions per schema semantics), then filter by
  // date — so `sessions` means "most recent N", not "N within the date window".
  const sliced = allTraces.slice(0, sessionCount);
  // Capture the pre-filter count so callers can distinguish "few sessions
  // exist" from "the since filter excluded most of them".
  const sessionsAvailable = sliced.length;

  let traces = sliced;
  if (params.since) {
    const sinceMs = Date.parse(params.since);
    if (Number.isNaN(sinceMs)) {
      throw new Error(`Invalid "since" date: ${params.since}`);
    }
    traces = sliced.filter((t) => t.mtimeMs >= sinceMs);
  }

  const kindFilter = params.kinds ? new Set(params.kinds) : undefined;
  const queryLower = params.query.toLowerCase();
  const matches: SearchMatch[] = [];
  const matchLimit = MAX_SEARCH_MATCHES; // cap total matches
  const truncatedSessions: string[] = [];
  let sessionsActuallySearched = 0;

  for (const entry of traces) {
    if (matches.length >= matchLimit) break;
    const { content, truncated } = await readTraceSafe(entry.tracePath);
    sessionsActuallySearched++;
    if (truncated) truncatedSessions.push(entry.sessionId);
    // Pre-filter by query string before parsing to avoid JSON.parse overhead
    // on lines that cannot match. Then use parseJsonlLines to handle the
    // split/trim/skip-empty/JSON.parse/catch contract uniformly.
    const candidateLines = content
      .split('\n')
      .filter((l) => l.trim() !== '' && l.toLowerCase().includes(queryLower));

    for (const line of candidateLines) {
      if (matches.length >= matchLimit) break;
      const [event] = parseJsonlLines<TraceEvent>(line, { guard: isTraceEvent });
      if (!event) continue;
      if (kindFilter && !kindFilter.has(event.kind)) continue;
      matches.push({
        sessionId: entry.sessionId,
        event,
        matchLine: line.length > 500 ? line.slice(0, 500) + '…' : line,
      });
    }
  }

  return {
    query: params.query,
    sessionsAvailable,
    sessionsSearched: sessionsActuallySearched,
    sessionsScanned: sessionsActuallySearched,
    matches,
    ...(truncatedSessions.length > 0 ? { truncatedSessions } : {}),
  };
}
