/**
 * Witness-layer trace reader for the improve pipeline.
 *
 * Walks `$AFK_HOME/state/witness/<sessionId>/trace.jsonl`, parses each line
 * defensively (skipping but counting invalid lines), and yields a flat
 * sequence of (session, event) pairs to detectors.
 *
 * Design notes:
 *
 *   - **Read-only.** This module never writes to the witness layer.
 *   - **Schema-validated.** Lines are parsed with {@link TraceEventSchema}.
 *     Lines that don't pass the discriminated union are skipped; the count
 *     is surfaced in {@link ScanResult.invalidLineCount} so operators can
 *     spot drift between this reader and the runtime writer.
 *   - **`--since` is approximate.** Phase 1A filters sessions by directory
 *     mtime, not per-event `ts`. A session whose directory mtime is older
 *     than the cutoff is skipped entirely. Sessions newer than the cutoff
 *     are read in full (no per-event filtering); detectors that need
 *     finer-grained windowing must implement it themselves.
 *
 * @module improve/scan/reader
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { TraceEventSchema } from '../../agent/trace/events.js';
import type { TraceEvent } from '../../agent/trace/types.js';
import { getWitnessRoot } from '../paths.js';
import { env } from '../../config/env.js';

/**
 * A parsed event plus the bookkeeping a detector needs to construct
 * evidence references back to the source `trace.jsonl`.
 *
 * `lineNumber` is 1-based — matches what an editor would show.
 * `rawLine` is the verbatim JSON for excerpt construction (never re-stringified).
 */
export interface ReaderEvent {
  sessionId: string;
  /** Absolute path to the trace file this event was read from. */
  tracePath: string;
  /** Path relative to `$AFK_HOME`. Stored in cards; portable. */
  relativeTracePath: string;
  lineNumber: number;
  rawLine: string;
  event: TraceEvent;
}

/** One session's view from the reader's perspective. */
export interface SessionRead {
  sessionId: string;
  tracePath: string;
  relativeTracePath: string;
  /** Wall-clock mtime of the session directory. */
  sessionMtimeMs: number;
  events: ReaderEvent[];
  /** Count of lines that failed schema validation or JSON.parse. */
  invalidLineCount: number;
}

/** Aggregate result of a scan over the witness root. */
export interface ScanResult {
  /** Total sessions inspected (post `--since` filter). */
  sessionsScanned: number;
  /** Sessions skipped because they were older than the cutoff. */
  sessionsSkippedOld: number;
  /** Sessions skipped because no trace.jsonl was present. */
  sessionsSkippedEmpty: number;
  /** Sum of invalid lines across all scanned sessions. */
  invalidLineCount: number;
  sessions: SessionRead[];
}

export interface ScanOptions {
  /**
   * Cutoff in ms-since-epoch. Sessions with directory mtime strictly less
   * than this value are skipped. `undefined` reads every session.
   */
  sinceMs?: number;
  /** Override the witness root. Defaults to {@link getWitnessRoot}. */
  witnessRoot?: string;
  /** Override `$AFK_HOME` (used to derive relative paths). Defaults to env. */
  afkHome?: string;
}

/**
 * Parse a duration string like `"7d"`, `"24h"`, `"30m"`, or `"3600s"` into
 * milliseconds. Returns `undefined` on unparseable input.
 *
 * Supported units: `s` (seconds), `m` (minutes), `h` (hours), `d` (days).
 * Numeric prefix must be a positive integer. Whitespace tolerated.
 */
export function parseDuration(input: string): number | undefined {
  const trimmed = input.trim();
  const match = /^(\d+)\s*([smhd])$/i.exec(trimmed);
  if (!match) return undefined;
  const n = Number.parseInt(match[1] ?? '0', 10);
  const unit = (match[2] ?? '').toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return undefined;
  switch (unit) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    default:
      return undefined;
  }
}

/**
 * Read every session under the witness root (subject to `--since`).
 * Returns a {@link ScanResult} with per-session events and invalid-line counts.
 *
 * The reader does NOT throw on a malformed session directory; it skips it
 * with a counter bump. This lets `afk improve scan` be safely run against
 * a witness dir that contains partial/old/in-progress sessions.
 */
export function scanWitness(options: ScanOptions = {}): ScanResult {
  const root = options.witnessRoot ?? getWitnessRoot();
  const afkHome =
    options.afkHome ?? env.AFK_HOME ?? deriveDefaultAfkHome();
  const sinceMs = options.sinceMs;

  const result: ScanResult = {
    sessionsScanned: 0,
    sessionsSkippedOld: 0,
    sessionsSkippedEmpty: 0,
    invalidLineCount: 0,
    sessions: [],
  };

  let dirEntries: string[];
  try {
    dirEntries = readdirSync(root);
  } catch {
    // Witness dir doesn't exist yet — fresh install, nothing to scan.
    return result;
  }

  for (const sessionId of dirEntries) {
    if (sessionId.startsWith('.')) continue;
    const sessionDir = join(root, sessionId);
    let dirStat;
    try {
      dirStat = statSync(sessionDir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    if (sinceMs !== undefined && dirStat.mtimeMs < sinceMs) {
      result.sessionsSkippedOld += 1;
      continue;
    }

    const tracePath = join(sessionDir, 'trace.jsonl');
    let content: string;
    try {
      content = readFileSync(tracePath, 'utf-8');
    } catch {
      result.sessionsSkippedEmpty += 1;
      continue;
    }

    const relativeTracePath = pathRelativeTo(tracePath, afkHome);
    const session = parseTraceContent({
      sessionId,
      tracePath,
      relativeTracePath,
      content,
      sessionMtimeMs: dirStat.mtimeMs,
    });
    result.sessions.push(session);
    result.sessionsScanned += 1;
    result.invalidLineCount += session.invalidLineCount;
  }

  return result;
}

/**
 * Parse the contents of a single `trace.jsonl` defensively.
 *
 * Exported for unit-testing without filesystem fixtures: callers can pass
 * synthetic content and assert on the parsed sequence.
 */
export function parseTraceContent(args: {
  sessionId: string;
  tracePath: string;
  relativeTracePath: string;
  content: string;
  sessionMtimeMs: number;
}): SessionRead {
  const { sessionId, tracePath, relativeTracePath, content, sessionMtimeMs } = args;
  const events: ReaderEvent[] = [];
  let invalidLineCount = 0;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    // Skip empty trailing line that's common after final `\n`.
    if (rawLine.trim() === '') continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawLine);
    } catch {
      invalidLineCount += 1;
      continue;
    }

    const schemaResult = TraceEventSchema.safeParse(parsedJson);
    if (!schemaResult.success) {
      invalidLineCount += 1;
      continue;
    }

    events.push({
      sessionId,
      tracePath,
      relativeTracePath,
      lineNumber: i + 1,
      rawLine,
      event: schemaResult.data,
    });
  }

  return {
    sessionId,
    tracePath,
    relativeTracePath,
    sessionMtimeMs,
    events,
    invalidLineCount,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deriveDefaultAfkHome(): string {
  // Mirror the logic in src/paths.ts:getAfkHome() without importing it
  // here (avoid an import cycle in tests that mock the path module).
  const afkHome = env.AFK_HOME;
  if (afkHome && afkHome.length > 0) return afkHome;
  return join(env.HOME ?? '', '.afk');
}

function pathRelativeTo(absolutePath: string, root: string): string {
  if (!root) return absolutePath;
  if (absolutePath.startsWith(root)) {
    let rel = absolutePath.slice(root.length);
    if (rel.startsWith('/')) rel = rel.slice(1);
    return rel;
  }
  return absolutePath;
}
