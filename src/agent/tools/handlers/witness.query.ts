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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getWitnessRoot } from '../../../paths.js';
import { listTraces, resolveLatestSession } from '../../../cli/commands/trace.js';
import type { TraceEvent } from '../../trace/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max bytes to read from a single trace file. Prevents OOM on huge traces. */
const MAX_READ_BYTES = 2_097_152; // 2 MB

/** Default event limit per query. */
const DEFAULT_LIMIT = 50;

/** Hard ceiling on events returned. */
const MAX_LIMIT = 200;

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
  const events: TraceEvent[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isTraceEvent(parsed)) events.push(parsed);
    } catch {
      // Malformed line — skip silently (live traces may have partial tails).
    }
  }
  return events;
}

/** Read a trace.jsonl file with a byte-size cap. */
function readTraceSafe(tracePath: string): string {
  if (!existsSync(tracePath)) return '';
  try {
    const buf = readFileSync(tracePath);
    const capped = buf.length > MAX_READ_BYTES
      ? buf.subarray(buf.length - MAX_READ_BYTES)
      : buf;
    return capped.toString('utf-8');
  } catch {
    return '';
  }
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
  if (filter.toolName && event.kind === 'tool_call') {
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

  const tracePath = join(getWitnessRoot(), sessionId, 'trace.jsonl');
  const content = readTraceSafe(tracePath);
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
  sessionsScanned: number;
  matches: SearchMatch[];
}

export async function searchAcrossSessions(
  params: SearchWitnessParams,
): Promise<SearchWitnessResult> {
  const sessionCount = clampSessions(params.sessions);
  const allTraces = await listTraces();

  // Apply date filter if provided.
  let traces = allTraces;
  if (params.since) {
    const sinceMs = Date.parse(params.since);
    if (!Number.isNaN(sinceMs)) {
      traces = traces.filter((t) => t.mtimeMs >= sinceMs);
    }
  }

  traces = traces.slice(0, sessionCount);

  const kindFilter = params.kinds ? new Set(params.kinds) : undefined;
  const queryLower = params.query.toLowerCase();
  const matches: SearchMatch[] = [];
  const matchLimit = MAX_LIMIT; // cap total matches

  for (const entry of traces) {
    if (matches.length >= matchLimit) break;
    const content = readTraceSafe(entry.tracePath);
    for (const line of content.split('\n')) {
      if (matches.length >= matchLimit) break;
      if (line.trim() === '') continue;
      if (!line.toLowerCase().includes(queryLower)) continue;

      try {
        const parsed: unknown = JSON.parse(line);
        if (!isTraceEvent(parsed)) continue;
        if (kindFilter && !kindFilter.has(parsed.kind)) continue;
        matches.push({
          sessionId: entry.sessionId,
          event: parsed,
          matchLine: line.length > 500 ? line.slice(0, 500) + '…' : line,
        });
      } catch {
        // Malformed — skip.
      }
    }
  }

  return {
    query: params.query,
    sessionsScanned: traces.length,
    matches,
  };
}
