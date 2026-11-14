/**
 * Episode-fact write helper for MemoryStore — split from memory-store.ts to
 * stay within the 350-code-line ceiling.
 *
 * Episode facts are derived on-demand from the facet cache; they are not
 * user-authored data and do not need WAL crash-recovery. INSERT OR IGNORE
 * turns duplicate rows into a silent no-op so re-derive / repeated session-end
 * hook invocations never produce SQLite constraint violations.
 *
 * @module agent/memory/memory-store.episode-fact
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { NewFact } from './types.js';

/**
 * Write an episode fact using INSERT OR IGNORE for idempotency (#4661,
 * constraint 4). The UNIQUE index on facts(content, created_at, session_id,
 * category) means a re-derive or duplicate session-end hook invocation would
 * otherwise hit a constraint violation. OR IGNORE turns duplicates into a
 * silent no-op.
 *
 * Contract: unlike storeFact, this function does NOT append a WAL entry before
 * the INSERT. Episode facts are derived on-demand from the facet cache; a
 * missing episode row is simply re-synthesised on the next backfill run.
 *
 * Returns the rowid of the inserted row, or -1 when the row was ignored
 * (duplicate).
 */
export function storeEpisodeFact(db: BetterSqlite3.Database, fact: NewFact): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO facts (session_id, created_at, category, content, source_surface, evidence)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    fact.session_id ?? null,
    now,
    fact.category,
    fact.content,
    fact.source_surface,
    fact.evidence ?? null,
  );
  return result.changes > 0 ? Number(result.lastInsertRowid) : -1;
}
