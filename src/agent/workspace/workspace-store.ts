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

CREATE INDEX IF NOT EXISTS idx_ws_session_seq ON workspace_entries(session_id, seq);
`;

// ── Store class ───────────────────────────────────────────────────────────────

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
  }

  /**
   * Query entries relevant to the given task prompt.
   *
   * Relevance: subject keyword overlap with `taskPrompt` words (≥3 chars).
   * Falls back to all session entries when no subject matches.
   * Always ordered by seq descending (most recent first). Capped at `limit`.
   */
  queryRelevant(sessionId: string, taskPrompt: string, limit = 50): WorkspaceEntry[] {
    const keywords = extractKeywords(taskPrompt);

    if (keywords.length > 0) {
      // Build a LIKE filter for subject overlap
      const conditions = keywords.map(() => `LOWER(COALESCE(subject,'')) LIKE ?`).join(' OR ');
      const params: unknown[] = keywords.map((k) => `%${k}%`);

      const sql = `
        SELECT * FROM workspace_entries
        WHERE session_id = ? AND (${conditions})
        ORDER BY seq DESC
        LIMIT ?
      `;
      const rows = this.db.prepare(sql).all(sessionId, ...params, limit) as WorkspaceEntry[];
      if (rows.length > 0) return rows;
    }

    // Fallback: all entries for the session, most recent first
    return this.db
      .prepare(
        'SELECT * FROM workspace_entries WHERE session_id = ? ORDER BY seq DESC LIMIT ?',
      )
      .all(sessionId, limit) as WorkspaceEntry[];
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

/** Extract lowercase search keywords (≥3 chars) from a prompt string. */
function extractKeywords(prompt: string): string[] {
  return [
    ...new Set(
      prompt
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length >= 3),
    ),
  ];
}
