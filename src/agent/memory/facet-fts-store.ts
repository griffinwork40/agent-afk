/** Separate SQLite FTS index for the session result lane of memory_search. */
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configureSqliteConnection } from '../storage/sqlite.js';
import { readJsonFileLoose } from '../../utils/json-file.js';
import { debugLog } from '../../utils/debug.js';
import { projectFacet, type FacetIndexFields } from './memory-store.facet-index.js';
import { sanitizeFtsQuery } from './memory-store.fts.js';
import type { MemorySearchResult } from './types.js';

// Contract: every index schema version lives in its own file,
// `facets-fts.v<N>.db`, and is never migrated in place. A schema bump picks a
// new N and rebuilds that file from the cached facets in the background
// (see backfill). Older binaries that may still be running on the same
// machine keep reading and writing their own file, so neither side ever
// sees a table shape it does not understand, and no existing row is
// destroyed. Abandoned files (including the unversioned v1/v2
// `facets-fts.db`) are left in place: they are user data that an older
// binary may still be using, and deleting them is not this store's call.
const FACET_FTS_SCHEMA_VERSION = 3;
const FACET_FTS_DB_FILE = `facets-fts.v${FACET_FTS_SCHEMA_VERSION}.db`;

// Upper bounds on the rebuild work done by any single open. The constructor of
// MemoryStore runs at session start on every surface and per web request, so
// a bulk rebuild is spread across opens; each open commits one batch.
const BACKFILL_MAX_FILES = 200;
const BACKFILL_BUDGET_MS = 100;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facets_index (
  session_id TEXT PRIMARY KEY,
  start_time TEXT,
  brief_summary TEXT NOT NULL,
  underlying_goal TEXT NOT NULL,
  primary_success TEXT NOT NULL,
  decisions TEXT NOT NULL,
  cwd TEXT NOT NULL,
  extra_text TEXT NOT NULL,
  sources INTEGER NOT NULL DEFAULT 0,
  text_blob TEXT GENERATED ALWAYS AS (
    brief_summary || ' ' || underlying_goal || ' ' || primary_success || ' ' ||
    decisions || ' ' || cwd || ' ' || extra_text
  ) VIRTUAL
);

CREATE TABLE IF NOT EXISTS facets_backfilled (file TEXT PRIMARY KEY);

CREATE VIRTUAL TABLE IF NOT EXISTS facets_fts USING fts5(
  text_blob,
  content=facets_index,
  content_rowid=rowid,
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS facets_index_ai AFTER INSERT ON facets_index BEGIN
  INSERT INTO facets_fts(rowid, text_blob) VALUES (new.rowid, new.text_blob);
END;

CREATE TRIGGER IF NOT EXISTS facets_index_ad AFTER DELETE ON facets_index BEGIN
  INSERT INTO facets_fts(facets_fts, rowid, text_blob) VALUES ('delete', old.rowid, old.text_blob);
END;

CREATE TRIGGER IF NOT EXISTS facets_index_au AFTER UPDATE ON facets_index BEGIN
  INSERT INTO facets_fts(facets_fts, rowid, text_blob) VALUES ('delete', old.rowid, old.text_blob);
  INSERT INTO facets_fts(rowid, text_blob) VALUES (new.rowid, new.text_blob);
END;
`;

// A replacement must have seen at least as many enrichment sources as the row
// it replaces, so a late thin projection never erases a rich one.
const UPSERT_SQL = `
  INSERT INTO facets_index
    (session_id, start_time, brief_summary, underlying_goal, primary_success, decisions, cwd, extra_text, sources)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET
    start_time=excluded.start_time, brief_summary=excluded.brief_summary,
    underlying_goal=excluded.underlying_goal, primary_success=excluded.primary_success,
    decisions=excluded.decisions, cwd=excluded.cwd, extra_text=excluded.extra_text,
    sources=excluded.sources
  WHERE excluded.sources >= facets_index.sources
`;

function initializeSchema(db: BetterSqlite3.Database): void {
  if ((db.pragma('user_version', { simple: true }) as number) === FACET_FTS_SCHEMA_VERSION) return;
  // IF NOT EXISTS makes two simultaneous first opens safe.
  db.transaction(() => {
    db.exec(SCHEMA_SQL);
    db.pragma(`user_version = ${FACET_FTS_SCHEMA_VERSION}`);
  }).immediate();
}

export interface FacetFtsStoreOptions {
  /** Lock wait for this connection. SessionEnd passes 0 to skip rather than wait. */
  busyTimeoutMs?: number;
}

function upsertParams(f: FacetIndexFields): (string | number | null)[] {
  return [f.session_id, f.start_time ?? null, f.brief_summary, f.underlying_goal,
    f.primary_success, f.decisions, f.cwd ?? '', f.extra_text ?? '', f.sources ?? 0];
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

type SearchRow = Omit<FacetIndexFields, 'start_time'> & { start_time: string | null };

export class FacetFtsStore {
  private readonly db?: BetterSqlite3.Database;

  constructor(memoryDir: string, options: FacetFtsStoreOptions = {}) {
    let db: BetterSqlite3.Database | undefined;
    try {
      mkdirSync(memoryDir, { recursive: true });
      db = new Database(join(memoryDir, FACET_FTS_DB_FILE));
      const { busyTimeoutMs } = options;
      configureSqliteConnection(db, busyTimeoutMs === undefined ? {}
        : { busyTimeoutMs, ...(busyTimeoutMs === 0 ? { walMaxAttempts: 1 } : {}) });
      initializeSchema(db);
      this.db = db;
    } catch (err) {
      db?.close();
      debugLog('facet-fts-store: open failed (non-fatal):', String(err));
    }
  }

  /** Upsert one projected facet, subject to the enrichment-source rule above. */
  indexFacet(fields: FacetIndexFields): void {
    try {
      this.db?.prepare(UPSERT_SQL).run(...upsertParams(fields));
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

  /**
   * Index a bounded batch of cached facets this file has not yet processed,
   * newest first, enriching them from retained session files. Projection
   * (file reads, redaction) runs outside the write lock; the batch commits in
   * one short transaction together with the processed-file markers, so a
   * failure leaves the batch to the next open. Never throws. Returns the
   * number of facets indexed.
   */
  backfill(cacheDir: string): number {
    const db = this.db;
    const files = this.pendingFiles(cacheDir);
    if (!db || !files.length) return 0;
    const started = performance.now();
    const rows: FacetIndexFields[] = [];
    const done: string[] = [];
    for (const file of files.slice(0, BACKFILL_MAX_FILES)) {
      if (done.length && performance.now() - started > BACKFILL_BUDGET_MS) break;
      done.push(file); // A file that cannot be projected is not retried forever.
      try {
        const fields = projectFacet(readJsonFileLoose<unknown>(join(cacheDir, file)), { sidecarId: file.slice(0, -5) });
        if (fields) rows.push(fields);
      } catch (err) {
        debugLog(`facet-fts-store: backfill failed for ${file} (non-fatal):`, String(err));
      }
    }
    try {
      const upsert = db.prepare(UPSERT_SQL);
      const mark = db.prepare('INSERT OR IGNORE INTO facets_backfilled (file) VALUES (?)');
      db.transaction(() => {
        for (const fields of rows) upsert.run(...upsertParams(fields));
        for (const file of done) mark.run(file);
      }).immediate();
    } catch (err) {
      debugLog('facet-fts-store: backfill batch failed (non-fatal, retried on next open):', String(err));
      return 0;
    }
    debugLog(`facet-fts-store: backfill indexed ${rows.length} of ${done.length} facets ` +
      `in ${Math.round(performance.now() - started)}ms; ${files.length - done.length} pending`);
    return rows.length;
  }

  private pendingFiles(cacheDir: string): string[] {
    if (!this.db) return [];
    try {
      const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
      if (!files.length) return [];
      // Skip files already processed and sessions already indexed live at SessionEnd.
      const rows = this.db.prepare(`SELECT file FROM facets_backfilled
        UNION SELECT session_id || '.json' FROM facets_index`).all() as { file: string }[];
      const processed = new Set(rows.map((r) => r.file));
      const pending = files.filter((f) => !processed.has(f));
      return pending.map((file) => ({ file, mtime: mtimeMs(join(cacheDir, file)) }))
        .sort((a, b) => b.mtime - a.mtime).map((p) => p.file);
    } catch {
      return [];
    }
  }

  close(): void {
    this.db?.close();
  }
}
