/**
 * SQLite schema DDL, version constants, migration runner, and WAL-mode switch
 * for the cross-session memory store.
 *
 * Extracted from memory-store.ts to keep that file under the 350-code-line
 * ceiling. The public surface here is used exclusively by MemoryStore.
 *
 * @module agent/memory/memory-store.schema
 */

import type BetterSqlite3 from 'better-sqlite3';
import { debugLog } from '../../utils/debug.js';
import { sleepSync } from '../../utils/sleep-sync.js';

/**
 * Increment this constant whenever the schema changes in a backward-incompatible way.
 * The constructor guards against opening a DB written by a newer version of the code,
 * and throws a clear error for older schemas so users know to migrate.
 *
 * History: v1 → v2: Added UNIQUE index on facts(content, created_at, session_id, category)
 *          to prevent same-ms duplicate inserts from breaking WAL fingerprint
 *          lookups. Migration deduplicates any existing colliding rows.
 * v2 → v3: Added a nullable `actor` column to sessions ('main' | 'subagent'
 *          execution role). ALTER ADD COLUMN with no default → existing rows
 *          read back NULL, so the migration cannot fail on stored data.
 * v3 → v4: Added a nullable `evidence` column to facts (provenance citation
 *          backing a codebase fact, for the AFK_MEMORY_EVIDENCE_GATE feature).
 *          ALTER ADD COLUMN with no default → existing rows read back NULL
 *          (= uncited), so the migration cannot fail on stored data. The
 *          column is additive and populated/consulted only when the gate is
 *          enabled, but the SCHEMA_VERSION guard still rejects a v4 DB from
 *          older builds — enabling the prototype migrates the DB forward.
 */
export const SCHEMA_VERSION = 4;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  surface TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  tools_used TEXT NOT NULL DEFAULT '[]',
  outcome TEXT,
  token_count INTEGER,
  cost_usd REAL,
  -- v3: execution role 'main' | 'subagent'. Nullable (NULL on pre-v3 rows).
  -- Listed last to match the position ALTER TABLE ADD COLUMN appends it on
  -- migrated databases, so fresh and migrated DBs share one column order.
  actor TEXT
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('preference', 'convention', 'decision', 'learning')),
  content TEXT NOT NULL,
  source_surface TEXT NOT NULL DEFAULT 'cli',
  superseded_by INTEGER REFERENCES facts(id),
  confidence REAL NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed TEXT,
  -- v4: provenance citation backing a codebase fact (file:line, commit SHA,
  -- trace-event id). Nullable (NULL on pre-v4 rows and uncited writes).
  -- Listed last to match the position ALTER TABLE ADD COLUMN appends it on
  -- migrated databases, so fresh and migrated DBs share one column order.
  evidence TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  content,
  category,
  content=facts,
  content_rowid=id,
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
  INSERT INTO facts_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_session_id ON facts(session_id);

-- v2: Fingerprint uniqueness for WAL replay. The four-field key (content,
-- created_at, session_id, category) is the stable identity used by supersede
-- WAL entries to locate rows across crash+restart cycles. Without a UNIQUE
-- constraint, same-ms duplicate inserts make .get() return an arbitrary row.
-- NULL session_id is coerced to the empty string so it participates in the
-- uniqueness check (SQLite treats NULLs as distinct in UNIQUE indexes).
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_fingerprint
  ON facts(content, created_at, COALESCE(session_id, ''), category);
`;

/**
 * Apply incremental schema migrations to bring the DB from `existingVersion`
 * up to `SCHEMA_VERSION`. Called by the MemoryStore constructor after the
 * fresh-DB case is handled.
 *
 * Invariant: migrations are applied in ascending order so a DB at ANY supported
 * older version catches up within a single open (a v1 DB runs v1→v2 then
 * v2→v3; a v2 DB runs only v2→v3). Each step is guarded by the version it
 * migrates FROM and stamps user_version on completion.
 */
export function runMigrations(db: BetterSqlite3.Database, existingVersion: number): void {
  if (existingVersion < 2) {
    // v1 → v2: add UNIQUE index on facts(content, created_at, session_id,
    // category). Uses CREATE … IF NOT EXISTS — already idempotent — so a
    // plain transaction wrapper is sufficient.
    db.transaction(() => {
      // First, deduplicate any colliding rows keeping the lowest id.
      db.exec(`
        DELETE FROM facts
        WHERE id NOT IN (
          SELECT MIN(id)
          FROM facts
          GROUP BY content, created_at, COALESCE(session_id, ''), category
        );
      `);
      // Rebuild FTS index after the dedup deletes.
      db.exec(`INSERT INTO facts_fts(facts_fts) VALUES('rebuild');`);
      // Apply the new unique index.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_fingerprint
          ON facts(content, created_at, COALESCE(session_id, ''), category);
      `);
      db.pragma(`user_version = 2`);
    })();
    debugLog('memory-store: migrated schema v1 → v2 (added fingerprint UNIQUE index)');
  }
  if (existingVersion < 3) {
    // v2 → v3: add a NULLABLE `actor` column to sessions ('main' |
    // 'subagent' execution role). No default → existing rows read back
    // NULL, so the migration cannot fail on stored data.
    //
    // Invariant: pre-check-only pattern instead of try/catch. SQLite has
    // no `ADD COLUMN IF NOT EXISTS`, and this global DB is cold-opened
    // concurrently by every AFK surface, so two new-build processes can
    // race the ALTER. By checking column presence INSIDE the transaction
    // BEFORE attempting the ALTER we avoid a swallowed error masking a
    // partial commit:
    //   - Normal case: column absent → ALTER runs → version stamped → commit.
    //   - Concurrent racer added the column first → pre-check sees it →
    //     skip ALTER → stamp version → commit. (No try/catch needed.)
    //   - Genuine ALTER failure (disk error) → transaction throws → ROLLS
    //     BACK (version NOT stamped) → next open re-runs from existingVersion.
    db.transaction(() => {
      const hasActor = (db.pragma('table_info(sessions)') as Array<{ name: string }>).some(
        (col) => col.name === 'actor',
      );
      if (!hasActor) {
        db.exec(`ALTER TABLE sessions ADD COLUMN actor TEXT;`);
      }
      db.pragma(`user_version = 3`);
    })();
    debugLog('memory-store: migrated schema v2 → v3 (added sessions.actor column)');
  }
  if (existingVersion < 4) {
    // v3 → v4: add a NULLABLE `evidence` column to facts (provenance
    // citation backing a codebase fact). No default → existing rows read
    // back NULL (= uncited), so the migration cannot fail on stored data.
    //
    // Invariant: same pre-check-only pattern as v2→v3 (see comment above).
    // The column presence check happens inside the transaction so the
    // pre-check and ALTER are atomic: if the ALTER fails, the transaction
    // rolls back and the version stamp is not advanced.
    db.transaction(() => {
      const hasEvidence = (db.pragma('table_info(facts)') as Array<{ name: string }>).some(
        (col) => col.name === 'evidence',
      );
      if (!hasEvidence) {
        db.exec(`ALTER TABLE facts ADD COLUMN evidence TEXT;`);
      }
      db.pragma(`user_version = 4`);
    })();
    debugLog('memory-store: migrated schema v3 → v4 (added facts.evidence column)');
  }
}

/**
 * Switch the database into WAL mode, tolerant of concurrent cold opens.
 *
 * Invariant: enabling WAL requires a brief EXCLUSIVE lock, and SQLite does
 * NOT honor busy_timeout for the journal-mode change — a contended switch
 * throws SQLITE_BUSY immediately instead of waiting. The global memory DB is
 * cold-opened concurrently by every AFK surface (and, under vitest, by every
 * parallel worker via the provider module-load singletons), so the switch
 * races. WAL is a property persisted in the DB header, so once any opener
 * wins, the rest only need to observe it: read the mode first (a lock-free
 * query) and skip the switch when already 'wal', otherwise bound-retry the
 * brief cold-start contention window. WAL is a concurrency optimization, not
 * a correctness requirement, but we still surface a non-BUSY error or an
 * exhausted retry budget rather than masking a genuinely broken DB.
 */
export function enableWalMode(db: BetterSqlite3.Database): void {
  const MAX_ATTEMPTS = 50;
  const BACKOFF_MS = 20;
  for (let attempt = 1; ; attempt++) {
    try {
      if (db.pragma('journal_mode', { simple: true }) === 'wal') return;
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      const busy = (err as { code?: string } | null)?.code === 'SQLITE_BUSY';
      if (!busy || attempt >= MAX_ATTEMPTS) throw err;
      sleepSync(BACKOFF_MS);
    }
  }
}
