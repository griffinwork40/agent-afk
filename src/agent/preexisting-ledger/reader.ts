/**
 * Reader and dedupe module for the pre-existing-defect ledger.
 *
 * Reads `preexisting-ledger.jsonl`, groups records by (repo, locus, signal),
 * counts recurrences, and tracks first/last seen timestamps.
 *
 * Design:
 *   - Tolerant: malformed lines are silently skipped (never throws).
 *   - Sync: all I/O via `existsSync` / `readFileSync`.
 *   - No side effects — pure data transformation after the single read.
 *
 * @module agent/preexisting-ledger/reader
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { getPreexistingLedgerPath } from './paths.js';
import { parseJsonlLines } from '../../utils/jsonl.js';
import type { LedgerRecord } from './session-end-hook.js';

// ---------------------------------------------------------------------------
// Bounded reader (1 MB tail cap — mirrors insights/aggregators/daemon.ts)
// ---------------------------------------------------------------------------

/** Maximum bytes read from the ledger in a single pass. */
const LEDGER_READ_LIMIT = 1_048_576; // 1 MB

/**
 * Read up to the last 1 MB of a JSONL file as a UTF-8 string.
 * Drops the partial first line when the file exceeds the cap, so every
 * returned line is a complete JSONL record.
 */
function readLedgerFileContent(filePath: string): string {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    const readOffset = Math.max(0, fileSize - LEDGER_READ_LIMIT);
    const readLength = fileSize - readOffset;
    const buf = Buffer.alloc(readLength);
    readSync(fd, buf, 0, readLength, readOffset);
    const content = buf.toString('utf-8');
    if (readOffset > 0) {
      const firstNewline = content.indexOf('\n');
      return firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
    }
    return content;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A deduplicated cluster of recurrences for one (repo, locus, signal) key. */
export interface DefectCluster {
  /** Repo path (cwd at recording time). */
  repo: string;
  /** The affected locus (file path, gate name, test name). */
  locus: string;
  /** Which detection signal fired. */
  signal: string;
  /** Coarse defect category from the detector. */
  category: string;
  /** Number of distinct sessions in which this cluster recurred. */
  recurrenceCount: number;
  /** ISO timestamp of the first recorded occurrence. */
  firstSeen: string;
  /** ISO timestamp of the most recent occurrence. */
  lastSeen: string;
}

// ---------------------------------------------------------------------------
// Type guard for raw JSONL records
// ---------------------------------------------------------------------------

function isLedgerRecord(x: unknown): x is LedgerRecord {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r['ts'] === 'string' &&
    typeof r['sessionId'] === 'string' &&
    typeof r['turn'] === 'number' &&
    typeof r['repo'] === 'string' &&
    typeof r['signal'] === 'string' &&
    typeof r['category'] === 'string' &&
    Array.isArray(r['loci']) &&
    (r['loci'] as unknown[]).every((l) => typeof l === 'string')
  );
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read the preexisting ledger and return all valid records.
 * Malformed lines are silently skipped.
 * Returns an empty array when the ledger is missing or unreadable.
 *
 * @param ledgerPath - Optional explicit path; defaults to the standard ledger
 *   location derived from `$AFK_HOME` / `$AFK_FRAMEWORK_DIR`.
 */
export function readLedgerRecords(ledgerPath?: string): LedgerRecord[] {
  const resolvedPath = ledgerPath ?? getPreexistingLedgerPath();
  if (!existsSync(resolvedPath)) return [];
  let raw: string;
  try {
    // Bounded read: cap at 1 MB (last N bytes) so a runaway ledger never
    // causes an OOM in the insights aggregator. Mirrors readTailMb() from
    // insights/aggregators/daemon.ts, kept local to avoid cross-layer imports.
    raw = readLedgerFileContent(resolvedPath);
  } catch {
    return [];
  }
  return parseJsonlLines<LedgerRecord>(raw, { guard: isLedgerRecord });
}

// ---------------------------------------------------------------------------
// Deduplication / clustering
// ---------------------------------------------------------------------------

/**
 * Build a composite cluster key: repo + locus + signal.
 * Each (repo, locus, signal) combination is its own cluster.
 */
function clusterKey(repo: string, locus: string, signal: string): string {
  return `${repo}\x00${locus}\x00${signal}`;
}

/**
 * Group ledger records by (repo, locus, signal), count distinct sessions,
 * and track first/last seen timestamps.
 *
 * One ledger record may carry multiple loci — each locus expands into its
 * own cluster entry.
 *
 * Clusters are ranked by descending recurrence count, then descending lastSeen.
 */
export function clusterLedgerRecords(records: LedgerRecord[]): DefectCluster[] {
  type ClusterAccum = {
    repo: string;
    locus: string;
    signal: string;
    category: string;
    sessions: Set<string>;
    timestamps: string[];
  };

  const map = new Map<string, ClusterAccum>();

  for (const record of records) {
    const { ts, sessionId, repo, signal, category, loci } = record;
    if (!Array.isArray(loci)) continue;
    for (const locus of loci) {
      if (typeof locus !== 'string' || !locus) continue;
      const key = clusterKey(repo, locus, signal);
      if (!map.has(key)) {
        map.set(key, { repo, locus, signal, category, sessions: new Set(), timestamps: [] });
      }
      const accum = map.get(key)!;
      accum.sessions.add(sessionId);
      if (ts) accum.timestamps.push(ts);
    }
  }

  const clusters: DefectCluster[] = [];
  for (const accum of map.values()) {
    const sorted = [...accum.timestamps].sort();
    clusters.push({
      repo: accum.repo,
      locus: accum.locus,
      signal: accum.signal,
      category: accum.category,
      recurrenceCount: accum.sessions.size,
      firstSeen: sorted[0] ?? '',
      lastSeen: sorted[sorted.length - 1] ?? '',
    });
  }

  clusters.sort((a, b) => {
    if (b.recurrenceCount !== a.recurrenceCount) return b.recurrenceCount - a.recurrenceCount;
    return b.lastSeen.localeCompare(a.lastSeen);
  });

  return clusters;
}
