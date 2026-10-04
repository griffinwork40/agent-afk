/**
 * Access-pattern reporting helpers for the MemoryStore fact archive.
 *
 * Now that `searchFacts()` activates the `access_count` / `last_accessed`
 * columns on every retrieval (issue #1848, step 1), these read-only queries
 * surface the data for observability and future GC tooling.
 *
 * Deliberately non-destructive: every function here is a pure SELECT with no
 * side-effects. A future GC sweep (issue #1848, step 2) will build on these
 * primitives — it is NOT implemented here; hard-deletion of facts is never
 * the default behaviour and requires an explicit opt-in command.
 *
 * @module agent/memory/memory-store.access
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { AccessStats, Fact } from './types.js';

/**
 * Return non-superseded facts that have never been retrieved
 * (`access_count = 0`) and were created more than `minAgeDays` days ago.
 *
 * This is the primary signal for a future GC sweep: old facts that nobody
 * has ever searched for are candidates for review or removal. The query is
 * entirely read-only — no rows are modified or deleted.
 *
 * @param db  Open SQLite database handle (from MemoryStore).
 * @param minAgeDays  Minimum age in days; only facts older than this are
 *                    returned. Must be ≥ 0. Defaults to 30.
 */
export function queryUnaccessed(
  db: BetterSqlite3.Database,
  minAgeDays: number = 30,
): Fact[] {
  const age = Math.max(0, minAgeDays);
  const cutoff = new Date(Date.now() - age * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      // Explicit column list instead of SELECT * so that future schema changes
      // (new columns added to facts) do not silently change this query's shape.
      `SELECT id, session_id, created_at, category, content, source_surface,
              superseded_by, confidence, access_count, last_accessed, evidence
         FROM facts
        WHERE access_count = 0
          AND created_at < ?
          AND superseded_by IS NULL
        ORDER BY created_at ASC`,
    )
    .all(cutoff) as Fact[];
}

/**
 * Return aggregate access-pattern statistics for the fact archive.
 *
 * The query is entirely read-only and runs in a single pass over the
 * non-superseded rows, so its cost is O(n) in the number of active facts.
 *
 * @param db  Open SQLite database handle (from MemoryStore).
 */
export function queryAccessStats(db: BetterSqlite3.Database): AccessStats {
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                                           AS total,
         COALESCE(SUM(CASE WHEN access_count = 0 THEN 1 ELSE 0 END), 0)  AS neverAccessed,
         COALESCE(SUM(CASE WHEN access_count > 0 THEN 1 ELSE 0 END), 0)  AS accessed,
         COALESCE(SUM(access_count), 0)                                    AS totalAccessEvents,
         COALESCE(MAX(access_count), 0)                                    AS maxAccessCount
       FROM facts
      WHERE superseded_by IS NULL`,
    )
    .get() as {
    total: number;
    neverAccessed: number;
    accessed: number;
    totalAccessEvents: number;
    maxAccessCount: number;
  };
  return {
    total: row.total,
    neverAccessed: row.neverAccessed,
    accessed: row.accessed,
    totalAccessEvents: row.totalAccessEvents,
    maxAccessCount: row.maxAccessCount,
  };
}
