/**
 * Q episodes store — schema v1.
 *
 * A lightweight SQLite store that holds episode records ingested from the AFK
 * memory archive. Q reads this store as a read-only consumer of episode facts;
 * all writes flow through the ingest adapter (`q-ingest.ts`), never directly
 * from the synthesis path.
 *
 * Schema (v1):
 *   episodes          — one row per session, keyed by session_id.
 *   episodes_fts      — FTS5 virtual table on (goal, narrative) for keyword search.
 *   q_episodes_meta   — single-row watermark table for idempotent incremental ingest.
 *
 * Idempotency: upsertEpisode() uses INSERT OR REPLACE so re-ingesting an
 * already-known session updates all fields without creating duplicates.
 * `recursive_triggers` is enabled so the episodes_ad trigger fires during the
 * internal DELETE that INSERT OR REPLACE performs, keeping FTS5 in sync.
 *
 * Watermark: the ingest adapter stores the highest `synthesized_at` ISO timestamp
 * it processed. Subsequent runs query only facts synthesized after that mark,
 * so the ingest cost is O(new episodes) not O(all episodes).
 *
 * @module agent/episodes/q-store
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { getMemoryDir } from '../../paths.js';
import { configureSqliteConnection } from '../storage/sqlite.js';

/** Schema version — increment on backward-incompatible changes. */
export const Q_EPISODES_SCHEMA_VERSION = 1;

const DB_FILE = 'q-episodes.db';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS episodes (
  session_id     TEXT PRIMARY KEY,
  goal           TEXT NOT NULL DEFAULT '',
  narrative      TEXT NOT NULL DEFAULT '',
  tags_json      TEXT NOT NULL DEFAULT '[]',
  files_json     TEXT NOT NULL DEFAULT '[]',
  synthesized_at TEXT NOT NULL,
  ingested_at    TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  goal,
  narrative,
  content='episodes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, goal, narrative)
    VALUES (new.rowid, new.goal, new.narrative);
END;

CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, goal, narrative)
    VALUES ('delete', old.rowid, old.goal, old.narrative);
END;

CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE OF goal, narrative ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, goal, narrative)
    VALUES ('delete', old.rowid, old.goal, old.narrative);
  INSERT INTO episodes_fts(rowid, goal, narrative)
    VALUES (new.rowid, new.goal, new.narrative);
END;

CREATE TABLE IF NOT EXISTS q_episodes_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** A stored episode row. */
export interface QEpisodeRow {
  session_id: string;
  goal: string;
  narrative: string;
  tags_json: string;
  files_json: string;
  synthesized_at: string;
  ingested_at: string;
}

/** Input shape for upserting one episode. */
export interface QEpisodeInput {
  sessionId: string;
  goal: string;
  narrative: string;
  tags: string[];
  files: string[];
  synthesizedAt: string;
}

export class QEpisodesStore {
  private readonly dir: string;
  private readonly db: BetterSqlite3.Database;

  constructor(storeDir?: string) {
    this.dir = storeDir ?? getMemoryDir();
    mkdirSync(this.dir, { recursive: true });

    this.db = new Database(join(this.dir, DB_FILE));
    configureSqliteConnection(this.db);
    // Enable recursive triggers so episodes_ad fires during the internal DELETE
    // that INSERT OR REPLACE performs, keeping FTS5 postings in sync.
    this.db.pragma('recursive_triggers = ON');

    const existingVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (existingVersion === 0) {
      this.db.exec(SCHEMA_SQL);
      this.db.pragma(`user_version = ${Q_EPISODES_SCHEMA_VERSION}`);
    } else if (existingVersion < Q_EPISODES_SCHEMA_VERSION) {
      // History: v1 is the initial schema — existingVersion < 1 is handled above (=0).
      // Add per-version ALTER TABLE / CREATE TABLE migration DDL here when bumping
      // Q_EPISODES_SCHEMA_VERSION. Never re-run SCHEMA_SQL wholesale.
      throw new Error(
        `q-episodes.db schema upgrade from v${existingVersion} to ` +
        `v${Q_EPISODES_SCHEMA_VERSION} is not implemented.`,
      );
    }
    // existingVersion === Q_EPISODES_SCHEMA_VERSION → no-op
    // existingVersion > Q_EPISODES_SCHEMA_VERSION → DB was created by a newer
    // version of agent-afk; we continue read-only-safe but writes may fail.
  }

  // ── Watermark ────────────────────────────────────────────────────────────

  /** Return the last ingested `synthesized_at` ISO timestamp, or null on first run. */
  getWatermark(): string | null {
    const row = this.db
      .prepare('SELECT value FROM q_episodes_meta WHERE key = ?')
      .get('watermark') as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Persist the new high-water mark. */
  setWatermark(ts: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO q_episodes_meta (key, value) VALUES (?, ?)',
      )
      .run('watermark', ts);
  }

  // ── Upsert ───────────────────────────────────────────────────────────────

  /**
   * Idempotently upsert one episode.
   * Uses INSERT OR REPLACE so re-ingesting an already-known session updates
   * all fields in place without creating duplicates.
   * recursive_triggers ensures the FTS5 delete trigger fires on the internal
   * DELETE, keeping the search index consistent.
   */
  upsertEpisode(input: QEpisodeInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO episodes
           (session_id, goal, narrative, tags_json, files_json, synthesized_at, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.goal,
        input.narrative,
        JSON.stringify(input.tags),
        JSON.stringify(input.files),
        input.synthesizedAt,
        now,
      );
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /** Fetch one episode by session ID, or null if not found. */
  getEpisode(sessionId: string): QEpisodeRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM episodes WHERE session_id = ?')
        .get(sessionId) as QEpisodeRow | undefined) ?? null
    );
  }

  /**
   * List episodes, optionally filtered by domain tag and/or a since cutoff.
   *
   * @param opts.domain  — match episodes whose tags_json contains this string
   *                       (% and _ are escaped so they are treated as literals)
   * @param opts.since   — ISO timestamp lower bound on synthesized_at
   * @param opts.limit   — max rows (default 20)
   */
  listEpisodes(opts: {
    domain?: string;
    since?: string;
    limit?: number;
  } = {}): QEpisodeRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.since) {
      conditions.push('synthesized_at >= ?');
      params.push(opts.since);
    }
    if (opts.domain) {
      // Escape LIKE special characters so domain values are matched literally.
      const escaped = opts.domain
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
      // tags_json is a JSON array; a simple LIKE check is sufficient for tags.
      conditions.push("tags_json LIKE ? ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 20;
    params.push(limit);

    return this.db
      .prepare(
        `SELECT * FROM episodes ${where} ORDER BY synthesized_at DESC LIMIT ?`,
      )
      .all(...params) as QEpisodeRow[];
  }

  /**
   * FTS5 keyword search over goal and narrative.
   *
   * Returns [] on malformed FTS5 query strings instead of throwing.
   *
   * @param query  FTS5 match expression (e.g. "auth refactor")
   * @param limit  max results (default 10)
   */
  searchEpisodes(query: string, limit = 10): QEpisodeRow[] {
    try {
      return this.db
        .prepare(
          `SELECT e.*
             FROM episodes e
             JOIN episodes_fts ON episodes_fts.rowid = e.rowid
            WHERE episodes_fts MATCH ?
            ORDER BY rank
            LIMIT ?`,
        )
        .all(query, limit) as QEpisodeRow[];
    } catch {
      return [];
    }
  }

  /** Total episode count — useful for ingest summaries. */
  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM episodes')
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
