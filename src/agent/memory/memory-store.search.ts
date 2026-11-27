/**
 * FTS5 fact-search helper for MemoryStore.
 *
 * Extracted from memory-store.ts to keep that file under the 350-code-line
 * ceiling. The public surface here is used exclusively by MemoryStore.
 *
 * Implements the `searchFacts` query: FTS5 MATCH with optional filters, plus
 * the bulk access-tracking UPDATE (increment access_count + set last_accessed
 * on every returned row in a single RETURNING query).
 *
 * @module agent/memory/memory-store.search
 */

import type BetterSqlite3 from 'better-sqlite3';
import { debugLog } from '../../utils/debug.js';
import type { Fact, SearchOpts } from './types.js';

/**
 * Execute a full-text search over the `facts_fts` FTS5 index and update
 * access-tracking counters on every returned row.
 *
 * @param db    Open SQLite database handle (caller guarantees non-null).
 * @param query FTS5 query string (may use operators, phrases, prefix*).
 * @param opts  Optional filters: category, since, source_surface, limit.
 * @returns     Matching facts with updated access_count / last_accessed.
 */
export function searchFactsImpl(
  db: BetterSqlite3.Database,
  query: string,
  opts?: SearchOpts,
): Fact[] {
  const limit = opts?.limit ?? 10;
  const conditions: string[] = ['facts_fts MATCH ?'];
  const params: unknown[] = [query];

  if (opts?.category) {
    conditions.push('f.category = ?');
    params.push(opts.category);
  }
  if (opts?.since) {
    conditions.push('f.created_at >= ?');
    params.push(opts.since);
  }
  if (opts?.source_surface) {
    conditions.push('f.source_surface = ?');
    params.push(opts.source_surface);
  }
  conditions.push('f.superseded_by IS NULL');

  const sql = `
    SELECT f.*, facts_fts.rank
    FROM facts f
    JOIN facts_fts ON facts_fts.rowid = f.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY facts_fts.rank
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as (Fact & { rank: number })[];

  // Activate access tracking: increment access_count and set last_accessed on
  // every fact returned by a search. Runs as a single bulk UPDATE so the
  // round-trip cost is O(1) rather than O(n). Wrapped in a try/catch so a
  // transient write failure never surfaces to the caller — reads degrading
  // gracefully is always preferable to throwing here.
  if (rows.length > 0) {
    const now = new Date().toISOString();
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    try {
      const accesses = db
        .prepare(
          `UPDATE facts
             SET access_count = access_count + 1,
                 last_accessed = ?
           WHERE id IN (${placeholders})
           RETURNING id, access_count, last_accessed`,
        )
        .all(now, ...ids) as Pick<Fact, 'id' | 'access_count' | 'last_accessed'>[];
      // RETURNING captures the committed increment, including concurrent recalls.
      // Never report an access before the write succeeds, or reorder FTS results.
      const byId = new Map(accesses.map((access) => [access.id, access]));
      // Contract: a row absent from RETURNING was deleted mid-flight (WAL
      // concurrent delete). Drop it — returning stale pre-UPDATE metadata for
      // a fact that no longer exists is more confusing than omitting it.
      const survived = rows.filter((row) => byId.has(row.id));
      if (survived.length === 0) {
        debugLog('memory-store: all recalled rows were deleted mid-flight; returning empty.');
        return [];
      }
      if (survived.length < rows.length) {
        debugLog(
          `memory-store: ${rows.length - survived.length} of ${rows.length} recalled rows were deleted mid-flight; omitting them.`,
        );
      }
      for (const row of survived) Object.assign(row, byId.get(row.id));
      return survived.map(({ rank: _rank, ...fact }) => fact as Fact);
    } catch (err) {
      debugLog('memory-store: access tracking update failed (non-fatal):', String(err));
    }
  }

  // Strip the FTS5 `rank` column — it is a query-time artifact and must not
  // leak into the public Fact[] return type.
  return rows.map(({ rank: _rank, ...fact }) => fact as Fact);
}
