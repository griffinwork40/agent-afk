/**
 * Transcript search index — FTS5-backed full-text search over session transcripts.
 *
 * Transcripts live at `~/.afk/state/transcripts/<isoStamp>.md` (plain Markdown).
 * This module builds and queries an SQLite FTS5 index over their content,
 * complementing the curated fact archive in `src/agent/memory/memory-store.ts`.
 *
 * Design notes:
 * - Reindex-on-demand only (no incremental indexing at session close). This is
 *   the safest v1 choice: no hooks required, no session lifecycle coupling,
 *   trivially correct. With 565 files at ~10-50 KB each, a full reindex takes
 *   well under a second. If incremental becomes desirable, add a last-modified
 *   mtime gate in a follow-up.
 * - Standalone SQLite at `~/.afk/state/transcripts-index/index.db` — isolated
 *   from the memory DB to avoid schema coupling.
 * - FTS5 with `porter` tokenizer matches the memory store convention.
 * - Query strings passed verbatim to FTS5 MATCH (callers may use FTS5 syntax
 *   such as "exact phrase", prefix*, AND, OR). Errors from malformed queries are
 *   caught and re-thrown as a descriptive Error.
 * - The in-session `transcript_search` tool is deferred for v1 — the CLI
 *   commands (`afk transcript search`, `afk transcript reindex`) are the
 *   required surface.
 *
 * @module agent/transcript-search/transcript-index
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { getTranscriptsDir, getAfkStateDir } from '../../paths.js';
import { debugLog } from '../../utils/debug.js';

// ── Constants ──────────────────────────────────────────────────────────────

const DB_FILE = 'index.db';
const INDEX_DIR_NAME = 'transcripts-index';

/**
 * Increment when the schema changes incompatibly.
 *
 * v1: initial schema — `transcripts` content table + `transcripts_fts` FTS5 table.
 */
const SCHEMA_VERSION = 1;

// Contract: SCHEMA_SQL creates the backing content table and the FTS5 virtual
// table. The FTS5 table uses `content=transcripts` (external content mode) so
// ranking information (via the hidden `rank` column) is available on queries.
// `porter` tokenizer matches the memory store convention for stem-aware search.
// Triggers keep the FTS index in sync with the content table.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS transcripts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- filename is the stable key: ISO timestamp with ':' and '.' → '-'.
  filename TEXT NOT NULL UNIQUE,
  -- ISO-8601 timestamp recovered from the filename (no parsing of file body).
  session_at TEXT NOT NULL,
  -- Full raw Markdown content of the transcript file.
  content TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
  content,
  content=transcripts,
  content_rowid=id,
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS transcripts_ai AFTER INSERT ON transcripts BEGIN
  INSERT INTO transcripts_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS transcripts_ad AFTER DELETE ON transcripts BEGIN
  INSERT INTO transcripts_fts(transcripts_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS transcripts_au AFTER UPDATE ON transcripts BEGIN
  INSERT INTO transcripts_fts(transcripts_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO transcripts_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE INDEX IF NOT EXISTS idx_transcripts_session_at ON transcripts(session_at DESC);
`;

// ── Types ──────────────────────────────────────────────────────────────────

/** One search hit returned by {@link searchTranscripts}. */
export interface TranscriptSearchResult {
  /** Basename of the transcript file, e.g. `2026-06-15T10-45-52-728Z.md`. */
  filename: string;
  /** ISO-8601 session timestamp recovered from the filename. */
  session_at: string;
  /**
   * Leading snippet of the transcript content (first 300 chars). Callers that
   * want the full body should read the file directly via `getTranscriptsDir()`.
   */
  snippet: string;
  /** Raw FTS5 rank (lower is better). Exposed so callers can sort if needed. */
  rank: number;
}

// ── Filename helpers ───────────────────────────────────────────────────────

/**
 * Recover an ISO-8601 datetime string from a transcript filename.
 *
 * Filenames use the pattern `<isoStamp>.md` where `:` and `.` in the ISO
 * timestamp are replaced by `-` to survive plain filesystems. This reverses
 * the transform — but only for the datetime portion, not the `.md` suffix.
 *
 * Example: `2026-06-15T10-45-52-728Z.md` → `2026-06-15T10:45:52.728Z`
 */
function filenameToIso(filename: string): string {
  // Strip the .md suffix, then un-mangle the time portion.
  // The date part (YYYY-MM-DD) already uses '-' legitimately; only the
  // characters after 'T' need restoring: colons and the millisecond dot.
  const stem = basename(filename, '.md');
  // Pattern: after the 'T' separator, replace the first two '-' separating
  // HH-MM-SS with ':', and the third '-' separating SS-mmm with '.'.
  // The trailing 'Z' is preserved as-is.
  return stem.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, 'T$1:$2:$3.$4');
}

// ── TranscriptIndex class ──────────────────────────────────────────────────

export class TranscriptIndex {
  private readonly indexDir: string;
  private readonly transcriptsDir: string;
  private readonly db: BetterSqlite3.Database;

  constructor(indexDir?: string, transcriptsDir?: string) {
    this.indexDir = indexDir ?? join(getAfkStateDir(), INDEX_DIR_NAME);
    this.transcriptsDir = transcriptsDir ?? getTranscriptsDir();
    mkdirSync(this.indexDir, { recursive: true });

    this.db = new Database(join(this.indexDir, DB_FILE));
    // Invariant: busy_timeout must be set before any schema or data operation
    // so contended reads wait rather than fail immediately. WAL mode is set
    // next so concurrent readers don't block the writer.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');

    const existingVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (existingVersion === 0) {
      this.db.exec(SCHEMA_SQL);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (existingVersion > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `transcript index schema v${existingVersion} is newer than this build supports (v${SCHEMA_VERSION}). ` +
          `Upgrade agent-afk or delete ${join(this.indexDir, DB_FILE)} to rebuild.`,
      );
    }
    // existingVersion === SCHEMA_VERSION: no migration needed (v1 only for now).
  }

  /**
   * Rebuild the FTS index from scratch by scanning the transcripts directory.
   *
   * Invariant (ordered writes): the FTS table is kept in sync with the content
   * table via SQLite triggers — INSERT on `transcripts` automatically fires
   * `INSERT INTO transcripts_fts`. The governing constraint is the FTS5 trigger
   * protocol: content-table rows must be written before the FTS virtual table
   * can be queried, because FTS5 external-content tables do not self-populate.
   *
   * All writes run inside a single transaction for atomicity and performance.
   * A full reindex is used for v1 (reindex-on-demand design). Incremental
   * indexing (mtime-gated upsert) is left for a future iteration.
   *
   * @returns count of transcript files indexed
   */
  reindex(): number {
    if (!existsSync(this.transcriptsDir)) {
      debugLog('transcript-index: transcripts dir does not exist, nothing to index');
      return 0;
    }

    const files = readdirSync(this.transcriptsDir).filter((f) => f.endsWith('.md'));
    debugLog(`transcript-index: reindexing ${files.length} transcript files`);

    // Invariant (ordered operation sequence): clear the FTS index before
    // clearing the content table. The FTS `delete` command requires the content
    // row to still be present in the backing store; however, with external-
    // content FTS5 we issue a full `rebuild` command after clearing, which
    // reconstructs the FTS index from the (now-replaced) content table rows
    // without needing the old rows. Therefore the correct order is:
    //   1. DELETE all rows from `transcripts` (content table)
    //   2. INSERT new rows from disk
    //   3. Rebuild FTS index from updated content table
    // This is done inside a transaction to ensure atomicity.
    const doReindex = this.db.transaction(() => {
      this.db.exec(`DELETE FROM transcripts;`);

      const insert = this.db.prepare<[string, string, string]>(`
        INSERT INTO transcripts (filename, session_at, content)
        VALUES (?, ?, ?)
        ON CONFLICT(filename) DO UPDATE SET session_at=excluded.session_at, content=excluded.content
      `);

      let count = 0;
      for (const filename of files) {
        const filePath = join(this.transcriptsDir, filename);
        let content: string;
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch (err) {
          debugLog(`transcript-index: skipping unreadable file ${filename}:`, String(err));
          continue;
        }
        const sessionAt = filenameToIso(filename);
        insert.run(filename, sessionAt, content);
        count++;
      }

      // Rebuild the FTS index from the now-populated content table.
      this.db.exec(`INSERT INTO transcripts_fts(transcripts_fts) VALUES('rebuild');`);
      return count;
    });

    return doReindex() as number;
  }

  /**
   * Search indexed transcripts for the given query string.
   *
   * The query is passed verbatim to SQLite FTS5 MATCH — callers may use FTS5
   * syntax: `"exact phrase"`, `term*`, `term1 AND term2`, `term1 OR term2`.
   * Malformed queries throw a descriptive Error (FTS5 parse error surfaced as-is).
   *
   * Contract:
   * - Returns up to `limit` results, ordered by FTS5 rank (best match first).
   * - Returns an empty array when the index is empty or no query matches.
   * - Each result includes a 300-char snippet from the start of the document.
   * - Callers should call {@link reindex} at least once before searching.
   *
   * @param query  FTS5 query string
   * @param limit  Maximum results to return (default 10)
   */
  search(query: string, limit = 10): TranscriptSearchResult[] {
    // Contract: empty or whitespace-only query returns nothing (avoids an FTS5
    // parse error on an empty MATCH expression).
    if (!query.trim()) return [];

    const sql = `
      SELECT t.filename, t.session_at, t.content, transcripts_fts.rank
      FROM transcripts t
      JOIN transcripts_fts ON transcripts_fts.rowid = t.id
      WHERE transcripts_fts MATCH ?
      ORDER BY transcripts_fts.rank
      LIMIT ?
    `;

    let rows: Array<{ filename: string; session_at: string; content: string; rank: number }>;
    try {
      rows = this.db.prepare(sql).all(query, limit) as typeof rows;
    } catch (err) {
      throw new Error(
        `Transcript FTS5 query failed for "${query}": ${String(err)}. ` +
          `Use FTS5 syntax — wrap phrases in "quotes", use * for prefix, AND/OR for boolean.`,
      );
    }

    return rows.map((row) => ({
      filename: row.filename,
      session_at: row.session_at,
      snippet: row.content.slice(0, 300),
      rank: row.rank,
    }));
  }

  /**
   * Return the count of transcripts currently in the index (0 = not yet indexed).
   * Useful for telling users to run `afk transcript reindex` first.
   */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM transcripts').get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

// ── Module-level helpers (thin wrappers for CLI use) ───────────────────────

/**
 * Open a {@link TranscriptIndex} at the default path, run the provided
 * callback, then close the DB — ensuring the connection is always released.
 *
 * Contract: `fn` must be synchronous. The DB is closed unconditionally in a
 * `finally` block regardless of whether `fn` throws.
 */
export function withTranscriptIndex<T>(
  fn: (idx: TranscriptIndex) => T,
  indexDir?: string,
  transcriptsDir?: string,
): T {
  const idx = new TranscriptIndex(indexDir, transcriptsDir);
  try {
    return fn(idx);
  } finally {
    idx.close();
  }
}
