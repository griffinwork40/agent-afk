/** Separate SQLite FTS index for the session result lane of memory_search. */
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configureSqliteConnection } from '../storage/sqlite.js';
import { readJsonFileLoose } from '../../utils/json-file.js';
import { debugLog } from '../../utils/debug.js';
import { indexFacetIntoStore, type FacetIndexFields } from './memory-store.facet-index.js';
import { sanitizeFtsQuery } from './memory-store.fts.js';
import type { MemorySearchResult } from './types.js';

const FACET_FTS_DB_FILE = 'facets-fts.db';
const FACET_FTS_SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE facets_index (
  session_id TEXT PRIMARY KEY,
  start_time TEXT,
  brief_summary TEXT NOT NULL,
  underlying_goal TEXT NOT NULL,
  primary_success TEXT NOT NULL,
  decisions TEXT NOT NULL,
  cwd TEXT NOT NULL,
  extra_text TEXT NOT NULL,
  text_blob TEXT GENERATED ALWAYS AS (
    brief_summary || ' ' || underlying_goal || ' ' || primary_success || ' ' ||
    decisions || ' ' || cwd || ' ' || extra_text
  ) VIRTUAL
);

CREATE VIRTUAL TABLE facets_fts USING fts5(
  text_blob,
  content=facets_index,
  content_rowid=rowid,
  tokenize='porter'
);

CREATE TRIGGER facets_index_ai AFTER INSERT ON facets_index BEGIN
  INSERT INTO facets_fts(rowid, text_blob) VALUES (new.rowid, new.text_blob);
END;

CREATE TRIGGER facets_index_ad AFTER DELETE ON facets_index BEGIN
  INSERT INTO facets_fts(facets_fts, rowid, text_blob) VALUES ('delete', old.rowid, old.text_blob);
END;

CREATE TRIGGER facets_index_au AFTER UPDATE ON facets_index BEGIN
  INSERT INTO facets_fts(facets_fts, rowid, text_blob) VALUES ('delete', old.rowid, old.text_blob);
  INSERT INTO facets_fts(rowid, text_blob) VALUES (new.rowid, new.text_blob);
END;
`;

function initializeSchema(db: BetterSqlite3.Database): void {
  const version = () => db.pragma('user_version', { simple: true }) as number;
  if (version() >= FACET_FTS_SCHEMA_VERSION) return;
  // Re-check under the write lock: two simultaneous opens must not both rebuild.
  db.transaction(() => {
    if (version() >= FACET_FTS_SCHEMA_VERSION) return;
    db.exec('DROP TABLE IF EXISTS facets_fts; DROP TABLE IF EXISTS facets_index;');
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${FACET_FTS_SCHEMA_VERSION}`);
  }).immediate();
}

type SearchRow = Omit<FacetIndexFields, 'start_time'> & { start_time: string | null };

export class FacetFtsStore {
  private readonly db?: BetterSqlite3.Database;

  constructor(memoryDir: string, bestEffortWrite = false) {
    let db: BetterSqlite3.Database | undefined;
    try {
      mkdirSync(memoryDir, { recursive: true });
      db = new Database(join(memoryDir, FACET_FTS_DB_FILE));
      // SessionEnd should skip the write rather than wait on another process.
      configureSqliteConnection(db, bestEffortWrite ? { busyTimeoutMs: 0, walMaxAttempts: 1 } : {});
      initializeSchema(db);
      this.db = db;
    } catch (err) {
      db?.close();
      debugLog('facet-fts-store: open failed (non-fatal):', String(err));
    }
  }

  /** The latest snapshot wins; UPDATE triggers also remove old postings. */
  indexFacet(fields: FacetIndexFields, backfill = false): void {
    try {
      this.db?.prepare(`
        INSERT INTO facets_index
          (session_id, start_time, brief_summary, underlying_goal, primary_success, decisions, cwd, extra_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) ${backfill ? 'DO NOTHING' : `DO UPDATE SET
          start_time=excluded.start_time, brief_summary=excluded.brief_summary,
          underlying_goal=excluded.underlying_goal, primary_success=excluded.primary_success,
          decisions=excluded.decisions, cwd=excluded.cwd, extra_text=excluded.extra_text`}
      `).run(
        fields.session_id, fields.start_time ?? null, fields.brief_summary, fields.underlying_goal,
        fields.primary_success, fields.decisions, fields.cwd ?? '', fields.extra_text ?? '',
      );
    } catch (err) {
      debugLog('facet-fts-store: indexFacet failed (non-fatal):', String(err));
    }
  }

  isIndexed(sessionId: string): boolean {
    try {
      return this.db?.prepare('SELECT 1 FROM facets_index WHERE session_id = ?').get(sessionId) != null;
    } catch {
      return false;
    }
  }

  search(query: string, limit = 10): MemorySearchResult[] {
    try {
      const rows = this.db?.prepare(`
        SELECT fi.session_id, fi.start_time, fi.brief_summary, fi.underlying_goal,
               fi.primary_success, fi.decisions, fi.cwd
        FROM facets_fts
        JOIN facets_index fi ON facets_fts.rowid = fi.rowid
        WHERE facets_fts MATCH ?
        ORDER BY facets_fts.rank
        LIMIT ?
      `).all(sanitizeFtsQuery(query), limit) as SearchRow[] | undefined;

      return rows?.map((row) => ({
        type: 'session' as const,
        content: [
          row.brief_summary,
          row.cwd && `Cwd: ${row.cwd}`,
          row.underlying_goal && `Goal: ${row.underlying_goal}`,
          row.primary_success && `Outcome: ${row.primary_success}`,
          row.decisions && `Decisions: ${row.decisions}`,
          `Pass session ID ${JSON.stringify(row.session_id)} to get_facet for the structured summary (if still retained).`,
        ].filter(Boolean).join('\n'),
        created_at: row.start_time ?? '', // Very old facets may not have a start time.
        source_session: row.session_id,
        confidence: 1.0,
      })) ?? [];
    } catch (err) {
      debugLog('facet-fts-store: search failed (non-fatal):', String(err));
      return [];
    }
  }

  /** Index any cached facet not yet present, enriching it from retained sidecars. */
  backfill(cacheDir: string): void {
    for (const file of this.missingFacets(cacheDir)) {
      try {
        const raw = readJsonFileLoose<unknown>(join(cacheDir, file));
        indexFacetIntoStore(this, raw, { sidecarId: file.slice(0, -5), backfill: true });
      } catch (err) {
        debugLog(`facet-fts-store: backfill failed for ${file} (non-fatal):`, String(err));
      }
    }
  }

  private missingFacets(cacheDir: string): string[] {
    if (!this.db) return [];
    try {
      const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
      if (!files.length) return [];
      const rows = this.db.prepare('SELECT session_id FROM facets_index').all() as { session_id: string }[];
      const indexed = new Set(rows.map((r) => r.session_id));
      return files.filter((f) => !indexed.has(f.slice(0, -5)));
    } catch {
      return [];
    }
  }

  close(): void {
    this.db?.close();
  }
}
