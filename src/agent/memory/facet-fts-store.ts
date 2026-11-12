/**
 * Facet FTS store — a sidecar SQLite database that indexes session facet fields
 * for `memory_search` via a `type: 'session'` result lane.
 *
 * Architecture:
 *   - Stored at `<memoryDir>/facets-fts.db` (sibling to `memory.db`).
 *   - Uses a single FTS5 virtual table `facets_fts` keyed on `session_id`.
 *   - Each row indexes `brief_summary + underlying_goal + primary_success +
 *     decisions` as a single concatenated text blob.
 *   - Upsert per session: indexed at facet-write time; replaced on re-index so the final complete facet always wins.
 *   - Backfill: on first open, re-indexes all facet cache files whose session_id
 *     is not already in the store (runs when the sidecar DB mtime is older than
 *     the facet cache dir mtime).
 *
 * This module is intentionally isolated from the main memory schema: it has its
 * own schema version, its own SQLite connection, and no WAL/GC interaction.
 *
 * @module agent/memory/facet-fts-store
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { configureSqliteConnection } from '../storage/sqlite.js';
import { readJsonFileLoose } from '../../utils/json-file.js';
import { debugLog } from '../../utils/debug.js';
import { sanitizeFtsQuery } from './memory-store.fts.js';
import type { MemorySearchResult } from './types.js';

const FACET_FTS_DB_FILE = 'facets-fts.db';

/**
 * Schema version for the sidecar facets FTS database.
 * Bump when the indexed fields or schema change.
 */
const FACET_FTS_SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facets_index (
  session_id TEXT PRIMARY KEY,
  indexed_at TEXT NOT NULL,
  brief_summary TEXT NOT NULL DEFAULT '',
  underlying_goal TEXT NOT NULL DEFAULT '',
  primary_success TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS facets_fts USING fts5(
  session_id UNINDEXED,
  text_blob,
  content=facets_index,
  content_rowid=rowid,
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS facets_index_ai AFTER INSERT ON facets_index BEGIN
  INSERT INTO facets_fts(rowid, session_id, text_blob)
    VALUES (new.rowid, new.session_id,
            new.brief_summary || ' ' || new.underlying_goal || ' ' ||
            new.primary_success || ' ' || new.decisions);
END;

CREATE TRIGGER IF NOT EXISTS facets_index_ad AFTER DELETE ON facets_index BEGIN
  INSERT INTO facets_fts(facets_fts, rowid, session_id, text_blob)
    VALUES ('delete', old.rowid, old.session_id,
            old.brief_summary || ' ' || old.underlying_goal || ' ' ||
            old.primary_success || ' ' || old.decisions);
END;

CREATE TRIGGER IF NOT EXISTS facets_index_au AFTER UPDATE ON facets_index BEGIN
  INSERT INTO facets_fts(facets_fts, rowid, session_id, text_blob)
    VALUES ('delete', old.rowid, old.session_id,
            old.brief_summary || ' ' || old.underlying_goal || ' ' ||
            old.primary_success || ' ' || old.decisions);
  INSERT INTO facets_fts(rowid, session_id, text_blob)
    VALUES (new.rowid, new.session_id,
            new.brief_summary || ' ' || new.underlying_goal || ' ' ||
            new.primary_success || ' ' || new.decisions);
END;
`;

/** A single row from the facets_index table. */
export interface FacetIndexRow {
  session_id: string;
  indexed_at: string;
  brief_summary: string;
  underlying_goal: string;
  primary_success: string;
  decisions: string;
}

/** Loose shape we read from cached facet JSON files for indexing. */
interface LooseFacet {
  session_id?: unknown;
  brief_summary?: unknown;
  underlying_goal?: unknown;
  primary_success?: unknown;
  decisions?: unknown;
}

/**
 * Extract indexable text fields from a loosely-read facet JSON object.
 * Returns null when the facet has no session_id (un-indexable).
 */
function extractFacetFields(raw: LooseFacet): {
  session_id: string;
  brief_summary: string;
  underlying_goal: string;
  primary_success: string;
  decisions: string;
} | null {
  const session_id = typeof raw.session_id === 'string' ? raw.session_id.trim() : '';
  if (!session_id) return null;

  const brief_summary = typeof raw.brief_summary === 'string' ? raw.brief_summary : '';
  const underlying_goal = typeof raw.underlying_goal === 'string' ? raw.underlying_goal : '';
  const primary_success = typeof raw.primary_success === 'string' ? raw.primary_success : '';
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions.filter((d): d is string => typeof d === 'string').join(' ')
    : typeof raw.decisions === 'string'
      ? raw.decisions
      : '';

  return { session_id, brief_summary, underlying_goal, primary_success, decisions };
}

export class FacetFtsStore {
  private readonly db: BetterSqlite3.Database;

  constructor(memoryDir: string) {
    mkdirSync(memoryDir, { recursive: true });
    this.db = new Database(join(memoryDir, FACET_FTS_DB_FILE));
    configureSqliteConnection(this.db);

    const existingVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (existingVersion === 0) {
      this.db.exec(SCHEMA_SQL);
      this.db.pragma(`user_version = ${FACET_FTS_SCHEMA_VERSION}`);
    } else if (existingVersion < FACET_FTS_SCHEMA_VERSION) {
      // Future migrations go here. For now, drop and recreate.
      this.db.exec(`
        DROP TABLE IF EXISTS facets_fts;
        DROP TABLE IF EXISTS facets_index;
      `);
      this.db.exec(SCHEMA_SQL);
      this.db.pragma(`user_version = ${FACET_FTS_SCHEMA_VERSION}`);
    }
    // existingVersion === FACET_FTS_SCHEMA_VERSION: nothing to do
    // existingVersion > FACET_FTS_SCHEMA_VERSION: forward-compat — read-only graceful
  }

  /**
   * Upserts a facet row. If the session was already indexed (e.g. a mid-session
   * partial snapshot), the row is replaced so the final complete facet wins.
   */
  indexFacet(fields: {
    session_id: string;
    brief_summary: string;
    underlying_goal: string;
    primary_success: string;
    decisions: string;
  }): void {
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO facets_index
          (session_id, indexed_at, brief_summary, underlying_goal, primary_success, decisions)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        fields.session_id,
        now,
        fields.brief_summary,
        fields.underlying_goal,
        fields.primary_success,
        fields.decisions,
      );
    } catch (err) {
      debugLog('facet-fts-store: indexFacet failed (non-fatal):', String(err));
    }
  }

  /**
   * Check whether a session_id is already indexed.
   */
  isIndexed(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM facets_index WHERE session_id = ?')
      .get(sessionId);
    return row != null;
  }

  /**
   * Search the facet FTS index. Returns up to `limit` MemorySearchResult entries
   * with `type: 'session'`.
   */
  search(query: string, limit = 10): MemorySearchResult[] {
    // Sanitize before passing to FTS5 MATCH so hyphenated / colon-containing
    // queries (e.g. "agent-afk") do not cause "no such column" errors.
    const safeQuery = sanitizeFtsQuery(query);
    try {
      const rows = this.db.prepare(`
        SELECT fi.session_id, fi.indexed_at, fi.brief_summary, fi.underlying_goal,
               fi.primary_success, fi.decisions, facets_fts.rank
        FROM facets_index fi
        JOIN facets_fts ON facets_fts.rowid = fi.rowid
        WHERE facets_fts MATCH ?
        ORDER BY facets_fts.rank
        LIMIT ?
      `).all(safeQuery, limit) as (FacetIndexRow & { rank: number })[];

      return rows.map((row) => {
        // Build a summary content string from the indexed fields
        const content = [
          row.brief_summary,
          row.underlying_goal && `Goal: ${row.underlying_goal}`,
          row.primary_success && `Outcome: ${row.primary_success}`,
          row.decisions && `Decisions: ${row.decisions}`,
        ]
          .filter(Boolean)
          .join('\n');

        return {
          type: 'session' as const,
          content,
          created_at: row.indexed_at,
          source_session: row.session_id,
          confidence: 1.0,
        };
      });
    } catch (err) {
      debugLog('facet-fts-store: search failed (non-fatal):', String(err));
      return [];
    }
  }

  /**
   * Backfill all facet cache files from `cacheDir` that are not yet indexed.
   * Called on first open when the sidecar DB may predate the facet cache dir.
   * Never throws — backfill failures are logged and swallowed.
   */
  backfill(cacheDir: string): void {
    if (!existsSync(cacheDir)) return;

    let files: string[];
    try {
      files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      debugLog('facet-fts-store: backfill readdirSync failed (non-fatal):', String(err));
      return;
    }

    let indexed = 0;
    for (const file of files) {
      const sessionId = file.slice(0, -5); // strip .json
      if (this.isIndexed(sessionId)) continue;

      try {
        const facetPath = join(cacheDir, file);
        const raw = readJsonFileLoose<LooseFacet>(facetPath);
        if (raw == null) continue;
        const fields = extractFacetFields(raw);
        if (!fields) continue;
        this.indexFacet(fields);
        indexed++;
      } catch (err) {
        debugLog(`facet-fts-store: backfill failed for ${file} (non-fatal):`, String(err));
      }
    }

    if (indexed > 0) {
      debugLog(`facet-fts-store: backfilled ${indexed} facet(s) into FTS index`);
    }
  }

  /**
   * Check whether the sidecar DB needs a backfill pass.
   * Returns true when any cache file's sessionId is not yet indexed.
   */
  needsBackfill(_memoryDir: string, cacheDir: string): boolean {
    if (!existsSync(cacheDir)) return false;

    // Fast O(1) check: empty index always needs backfill.
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM facets_index').get() as { n: number };
      if (count.n === 0) return true;
    } catch {
      return true;
    }

    // Bulk O(1) SQL round-trip: load all indexed session_ids into a Set,
    // then check against the list of cache files. Replaces the previous
    // per-file isIndexed() loop which was O(N) SQLite queries.
    try {
      const files = readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
      const rows = this.db.prepare('SELECT session_id FROM facets_index').all() as { session_id: string }[];
      const indexed = new Set(rows.map((r) => r.session_id));
      return files.some((f) => !indexed.has(f.slice(0, -5)));
    } catch {
      return true; // conservative: backfill on any error
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Index a facet from a raw (loosely-typed) JSON object.
 * Utility for callers that have the raw facet object but not the typed schema.
 */
export function indexFacetInStore(store: FacetFtsStore, raw: unknown): void {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const fields = extractFacetFields(raw as LooseFacet);
  if (!fields) return;
  store.indexFacet(fields);
}
