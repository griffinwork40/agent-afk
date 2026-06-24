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
// No per-row sync triggers: reindex() is the only write path and rebuilds the
// whole FTS index in bulk via the FTS5 'rebuild' command (see reindex()), so
// INSERT/DELETE triggers would be redundant work on every full reindex.
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
   * Matching excerpt with surrounding context, produced by FTS5 `snippet()`
   * (~16 tokens around the best match, whitespace-collapsed for one-line
   * display). Callers that want the full body should read the file directly via
   * `getTranscriptsDir()`.
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
/** Stored in `session_at` when a filename is not a recognizable ISO stamp. */
const UNKNOWN_SESSION_AT = 'unknown';

function filenameToIso(filename: string): string {
  // Strip the .md suffix, then un-mangle the time portion.
  // The date part (YYYY-MM-DD) already uses '-' legitimately; only the
  // characters after 'T' need restoring: colons and the millisecond dot.
  const stem = basename(filename, '.md');
  // Pattern: after the 'T' separator, replace the first two '-' separating
  // HH-MM-SS with ':', and the third '-' separating SS-mmm with '.'.
  // The trailing 'Z' is preserved as-is.
  const iso = stem.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, 'T$1:$2:$3.$4');
  // A no-op replace (iso === stem) means the filename was not a recognized
  // stamp (a stray or legacy file). Return a sentinel rather than store a
  // non-ISO string in `session_at` that callers would render as a timestamp.
  return iso === stem ? UNKNOWN_SESSION_AT : iso;
}

// ── TranscriptIndex class ──────────────────────────────────────────────────

export class TranscriptIndex {
  private readonly indexDir: string;
  private readonly transcriptsDir: string;
  private readonly db: BetterSqlite3.Database;

  constructor(indexDir?: string, transcriptsDir?: string) {
    this.indexDir = indexDir ?? join(getAfkStateDir(), INDEX_DIR_NAME);
    this.transcriptsDir = transcriptsDir ?? getTranscriptsDir();
    // The index DB holds a full copy of every transcript's content, which the
    // transcript writer deliberately stores at mode 0o600. better-sqlite3
    // creates index.db (+ -wal/-shm) at the process umask (often 0o644), so a
    // 0o700 dir is what keeps that duplicated content unreadable by other users.
    mkdirSync(this.indexDir, { recursive: true, mode: 0o700 });

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
   * Invariant (FTS5 external-content rebuild): content-table rows must be
   * written before the FTS index is rebuilt, because an external-content FTS5
   * table (`content=transcripts`) does not self-populate. reindex() therefore
   * (1) clears the content table, (2) inserts every transcript from disk, then
   * (3) runs the FTS5 'rebuild' command to reconstruct the index from the
   * now-current content rows. The bulk rebuild is the single sync point — no
   * per-row triggers are used.
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

    // Invariant (ordered operation sequence): with external-content FTS5 the
    // index is rebuilt from the content table, so the order is:
    //   1. DELETE all rows from `transcripts` (content table)
    //   2. INSERT new rows from disk (no ON CONFLICT needed — the table is empty)
    //   3. Rebuild the FTS index from the updated content table
    // All inside one transaction for atomicity.
    const doReindex = this.db.transaction(() => {
      this.db.exec(`DELETE FROM transcripts;`);

      const insert = this.db.prepare<[string, string, string]>(`
        INSERT INTO transcripts (filename, session_at, content)
        VALUES (?, ?, ?)
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
   * - Each result includes an FTS5 `snippet()` excerpt around the best match.
   * - Callers should call {@link reindex} at least once before searching.
   *
   * @param query  FTS5 query string
   * @param limit  Maximum results to return (default 10)
   */
  search(query: string, limit = 10): TranscriptSearchResult[] {
    // Contract: empty or whitespace-only query returns nothing (avoids an FTS5
    // parse error on an empty MATCH expression).
    if (!query.trim()) return [];

    // Use FTS5 snippet() to return the matching excerpt (not the file header)
    // and to avoid transferring full `content` per row just to slice it.
    // snippet(table, colIdx 0, startMark '', endMark '', ellipsis '…', tokens).
    const sql = `
      SELECT t.filename, t.session_at,
             snippet(transcripts_fts, 0, '', '', '…', 16) AS snippet,
             transcripts_fts.rank
      FROM transcripts t
      JOIN transcripts_fts ON transcripts_fts.rowid = t.id
      WHERE transcripts_fts MATCH ?
      ORDER BY transcripts_fts.rank
      LIMIT ?
    `;

    let rows: Array<{ filename: string; session_at: string; snippet: string; rank: number }>;
    try {
      rows = this.db.prepare(sql).all(query, limit) as typeof rows;
    } catch (err) {
      // Note: the user-supplied query is intentionally not echoed into the
      // message; the SQLite error text already pinpoints the parse failure.
      throw new Error(
        `Transcript FTS5 query failed: ${String(err)}. ` +
          `Use FTS5 syntax — wrap phrases in "quotes", use * for prefix, AND/OR for boolean.`,
      );
    }

    return rows.map((row) => ({
      filename: row.filename,
      session_at: row.session_at,
      // Collapse whitespace/newlines so the one-line CLI display stays clean.
      snippet: row.snippet.replace(/\s+/g, ' ').trim(),
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
