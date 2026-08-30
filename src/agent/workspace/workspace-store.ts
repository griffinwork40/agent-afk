/**
 * Per-session workspace store — SQLite-backed, ephemeral shared scratchpad.
 *
 * Lets sibling sub-agents publish structured findings (findings, evidence,
 * hypotheses, decisions, artifacts, status) to a shared SQLite store for the
 * duration of a session. Default path is `:memory:` — no persistence across
 * sessions.
 *
 * WAL mode + busy_timeout mirror the cross-session memory-store pattern for
 * safe concurrent access when multiple agents share one file-backed instance.
 *
 * @module agent/workspace/workspace-store
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────────

export type WorkspaceEntryType =
  | 'finding'
  | 'evidence'
  | 'hypothesis'
  | 'decision'
  | 'artifact'
  | 'status';

export type WorkspaceRelationType =
  | 'supports'
  | 'contradicts'
  | 'depends_on'
  | 'supersedes';

/** A fully-hydrated workspace entry as returned by query methods. */
export interface WorkspaceEntry {
  id: number;
  session_id: string;
  type: WorkspaceEntryType;
  subject: string | null;
  content: string;
  /** JSON-encoded array of file:line references, or null. */
  evidence: string | null;
  confidence: number;
  agent_id: string | null;
  /** JSON-encoded array of related entry IDs, or null. */
  relates_to: string | null;
  relation_type: WorkspaceRelationType | null;
  created_at: string;
  seq: number;
}

/** Input type for publishing a new entry — id/created_at/seq are auto-set. */
export interface WorkspacePublishInput {
  session_id: string;
  type: WorkspaceEntryType;
  subject?: string;
  content: string;
  /** File:line references, stored as a JSON array. */
  evidence?: string[];
  confidence?: number;
  agent_id?: string;
  /** IDs of related entries. */
  relates_to?: number[];
  relation_type?: WorkspaceRelationType;
}

// ── Schema ───────────────────────────────────────────────────────────────────

// Invariant: workspace_entries is append-only. The FTS5 external-content table
// (workspace_fts) has only synchronization triggers — AFTER INSERT, DELETE, and
// UPDATE. If the append-only contract ever changes (e.g. adding a DELETE or
// UPDATE query path on workspace_entries), the FTS triggers below already handle
// it per SQLite FTS5 docs section 4.4.2. The triggers exist defensively; the
// absence of mutation methods on WorkspaceStore is the primary guard.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('finding','evidence','hypothesis','decision','artifact','status')),
  subject TEXT,
  content TEXT NOT NULL,
  evidence TEXT,
  confidence REAL DEFAULT 1.0,
  agent_id TEXT,
  relates_to TEXT,
  relation_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  seq INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_session_seq ON workspace_entries(session_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS workspace_fts USING fts5(
  subject,
  content,
  content=workspace_entries,
  content_rowid=id,
  tokenize='porter'
);

CREATE TRIGGER IF NOT EXISTS ws_fts_ai AFTER INSERT ON workspace_entries BEGIN
  INSERT INTO workspace_fts(rowid, subject, content) VALUES (new.id, new.subject, new.content);
END;

CREATE TRIGGER IF NOT EXISTS ws_fts_ad AFTER DELETE ON workspace_entries BEGIN
  INSERT INTO workspace_fts(workspace_fts, rowid, subject, content)
    VALUES ('delete', old.id, old.subject, old.content);
END;

CREATE TRIGGER IF NOT EXISTS ws_fts_au AFTER UPDATE ON workspace_entries BEGIN
  INSERT INTO workspace_fts(workspace_fts, rowid, subject, content)
    VALUES ('delete', old.id, old.subject, old.content);
  INSERT INTO workspace_fts(rowid, subject, content)
    VALUES (new.id, new.subject, new.content);
END;
`;

// ── Store class ───────────────────────────────────────────────────────────────

// Invariant: WorkspaceStore deliberately exposes no update() or delete() method.
// workspace_entries is append-only by design. The FTS5 DELETE/UPDATE triggers
// above exist as a defensive safety net, not because mutations are expected.
export class WorkspaceStore {
  private readonly db: BetterSqlite3.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? ':memory:');
    // busy_timeout: concurrent writers wait up to 5s rather than failing fast.
    this.db.pragma('busy_timeout = 5000');
    this.enableWalMode();
    this.db.exec(SCHEMA_SQL);
  }

  /**
   * WAL mode — tolerant of concurrent cold opens (same pattern as memory-store).
   * Reads journal_mode first (lock-free) and skips the switch when already 'wal'.
   */
  private enableWalMode(): void {
    const MAX_ATTEMPTS = 50;
    const BACKOFF_MS = 20;
    for (let attempt = 1; ; attempt++) {
      try {
        if (this.db.pragma('journal_mode', { simple: true }) === 'wal') return;
        this.db.pragma('journal_mode = WAL');
        return;
      } catch (err) {
        const busy = (err as { code?: string } | null)?.code === 'SQLITE_BUSY';
        if (!busy || attempt >= MAX_ATTEMPTS) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BACKOFF_MS);
      }
    }
  }

  /**
   * Publish a new workspace entry. Returns the assigned row id.
   * `seq` is auto-incremented per session (max existing seq + 1, starting at 1).
   */
  publish(entry: WorkspacePublishInput): number {
    const txn = this.db.transaction(() => {
      const nextSeq = this.nextSeq(entry.session_id);
      const stmt = this.db.prepare(`
        INSERT INTO workspace_entries
          (session_id, type, subject, content, evidence, confidence, agent_id, relates_to, relation_type, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        entry.session_id,
        entry.type,
        entry.subject ?? null,
        entry.content,
        entry.evidence !== undefined ? JSON.stringify(entry.evidence) : null,
        entry.confidence ?? 1.0,
        entry.agent_id ?? null,
        entry.relates_to !== undefined ? JSON.stringify(entry.relates_to) : null,
        entry.relation_type ?? null,
        nextSeq,
      );
      return Number(result.lastInsertRowid);
    });
    return txn();
  }

  /**
   * Query entries relevant to the given task prompt.
   *
   * Relevance: FTS5 full-text search over `subject` (weighted 10x) and
   * `content`, ranked by BM25. Falls back to all entries when no FTS match
   * or on malformed query. Capped at `limit`.
   *
   * When `sessionId` is `null`, the query scans all entries in the store
   * regardless of which child published them. This is the correct mode for
   * the fork-child-config preamble injection path: the store is already
   * scoped to one root session (one `WorkspaceStore` instance per top-level
   * session), and children publish under their own session IDs, so a
   * session-filtered query would miss sibling findings.
   */
  queryRelevant(sessionId: string | null, taskPrompt: string, limit = 50): WorkspaceEntry[] {
    const ftsQuery = buildFtsQuery(taskPrompt);

    if (ftsQuery.length > 0) {
      try {
        // Invariant: bm25() weights are negative (lower = better match).
        // Subject is weighted 10x content so subject-matched entries rank first.
        const sessionClause = sessionId !== null ? 'AND e.session_id = ?' : '';
        const sql = `
          SELECT e.*, bm25(workspace_fts, 10.0, 1.0) AS rank
          FROM workspace_entries e
          JOIN workspace_fts ON workspace_fts.rowid = e.id
          WHERE workspace_fts MATCH ?
          ${sessionClause}
          ORDER BY rank
          LIMIT ?
        `;
        const params: unknown[] = sessionId !== null
          ? [ftsQuery, sessionId, limit]
          : [ftsQuery, limit];
        const rows = this.db.prepare(sql).all(...params) as WorkspaceEntry[];
        if (rows.length > 0) return rows;
      } catch {
        // FTS5 parse error on malformed query — fall through to recency fallback
      }
    }

    // Fallback: all entries (optionally filtered by session), most recent first
    if (sessionId !== null) {
      return this.db
        .prepare(
          'SELECT * FROM workspace_entries WHERE session_id = ? ORDER BY seq DESC LIMIT ?',
        )
        .all(sessionId, limit) as WorkspaceEntry[];
    }
    return this.db
      .prepare('SELECT * FROM workspace_entries ORDER BY seq DESC LIMIT ?')
      .all(limit) as WorkspaceEntry[];
  }

  /** All entries for a session, ordered by seq ascending. */
  queryAll(sessionId: string): WorkspaceEntry[] {
    return this.db
      .prepare('SELECT * FROM workspace_entries WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as WorkspaceEntry[];
  }

  close(): void {
    this.db.close();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private nextSeq(sessionId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS max_seq FROM workspace_entries WHERE session_id = ?')
      .get(sessionId) as { max_seq: number | null } | undefined;
    return (row?.max_seq ?? 0) + 1;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Contract: FTS5 queries receive agent-generated natural language (tool call
// arguments), not user-typed FTS5 syntax. We tokenize into bare words joined
// by OR so any term can match. Double-quoting each token prevents FTS5
// operators embedded in agent text (AND, OR, NOT, NEAR, *, -) from being
// interpreted as query syntax.

/**
 * Build an FTS5 query string from a natural-language prompt.
 *
 * Tokenizes on non-word boundaries, drops words < 3 chars (stop-word
 * proxy), deduplicates, caps at 25 terms, and joins with OR. Each term
 * is double-quoted to neutralize FTS5 operators in agent text.
 * Returns empty string when no usable terms remain.
 */
export function buildFtsQuery(prompt: string): string {
  const tokens = [
    ...new Set(
      prompt
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length >= 3),
    ),
  ].slice(0, 25);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
