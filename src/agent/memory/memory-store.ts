/**
 * Cross-session memory store.
 *
 * Wraps SQLite (via better-sqlite3) for the session archive + facts tables,
 * a flat HOT.md file for system-prompt-injected hot memory, and a procedures/
 * directory for agent-authored procedural memory.
 *
 * WAL-mode SQLite with busy_timeout for safe concurrent access across surfaces.
 * A JSONL write-ahead log provides crash recovery: facts are appended to the
 * WAL before the SQLite insert, and replayed on next open if SQLite is behind.
 *
 * @module agent/memory/memory-store
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
  unlinkSync,
  copyFileSync,
  renameSync,
} from 'fs';
import { join, basename, resolve, relative } from 'path';
import { getMemoryDir } from '../../paths.js';
import { debugLog } from '../../utils/debug.js';
import type {
  Fact,
  NewFact,
  SearchOpts,
  MemorySearchResult,
  SessionRecord,
  NewSession,
  Procedure,
  SessionOutcome,
  WALEntry,
} from './types.js';

const HOT_FILE = 'HOT.md';
const HOT_BACKUP = 'HOT.md.bak';
const DB_FILE = 'memory.db';
const WAL_FILE = 'memory-wal.jsonl';
const PROCEDURES_DIR = 'procedures';
const HOT_TMP = 'HOT.md.tmp';
const MAX_HOT_CHARS = 5250; // ~1,500 tokens at 3.5 chars/token
const HOT_TOKEN_CAP = Math.ceil(MAX_HOT_CHARS / 3.5); // 1500 — surfaced in usage reports

/**
 * Protected identity region. When HOT.md overflows, `saveHot` truncates from
 * the END (keeping content from the start — the prompt convention is
 * "most-durable first, least-durable last") and never sacrifices the first
 * HOT_HEAD_CHARS to the complete-line cut. Guarantees identity survives any
 * overflow regardless of how the rest of the blob is shaped.
 */
const HOT_HEAD_CHARS = 600;

/** Soft-warning threshold (fraction of the cap) surfaced to the agent on hot writes. */
export const HOT_SOFT_WARN_RATIO = 0.8;

/** Appended to HOT.md when truncation fires, so the cut is auditable in-file. */
const HOT_TRUNCATION_SENTINEL =
  '<!-- HOT TRUNCATED to fit the ~1,500-token cap; move durable detail to the fact archive (memory_update target:"fact"). -->';

/**
 * Increment this constant whenever the schema changes in a backward-incompatible way.
 * The constructor guards against opening a DB written by a newer version of the code,
 * and throws a clear error for older schemas so users know to migrate.
 *
 * v1 → v2: Added UNIQUE index on facts(content, created_at, session_id, category)
 *          to prevent same-ms duplicate inserts from breaking WAL fingerprint
 *          lookups. Migration deduplicates any existing colliding rows.
 * v2 → v3: Added a nullable `actor` column to sessions ('main' | 'subagent'
 *          execution role). ALTER ADD COLUMN with no default → existing rows
 *          read back NULL, so the migration cannot fail on stored data.
 */
const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
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
  last_accessed TEXT
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

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Usage report for hot memory (HOT.md), returned by {@link MemoryStore.saveHot}
 * and {@link MemoryStore.hotUsage}. Lets callers surface a budget signal — and
 * whether truncation occurred — to the agent without re-reading the file.
 */
export interface HotUsage {
  /** Characters actually written to HOT.md. */
  chars: number;
  /** Estimated token count of the written content. */
  tokens: number;
  /** Hard token cap (~1,500). */
  maxTokens: number;
  /** Percent of the cap used (0–100, clamped). */
  pct: number;
  /** Whether the input was truncated to fit the cap. */
  truncated: boolean;
}

export class MemoryStore {
  private readonly dir: string;
  private readonly db: BetterSqlite3.Database;

  constructor(memoryDir?: string) {
    this.dir = memoryDir ?? getMemoryDir();
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(join(this.dir, PROCEDURES_DIR), { recursive: true });

    this.db = new Database(join(this.dir, DB_FILE));
    // busy_timeout makes ordinary contended reads/writes wait up to 5s rather
    // than failing fast; set it first so it covers everything below.
    this.db.pragma('busy_timeout = 5000');
    this.enableWalMode();

    // Schema versioning guard — prevents silent corruption when the schema
    // evolves across agent-afk versions.
    const existingVersion = this.db.pragma('user_version', { simple: true }) as number;
    if (existingVersion === 0) {
      // Fresh database: apply schema then stamp the version.
      this.db.exec(SCHEMA_SQL);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } else if (existingVersion === SCHEMA_VERSION) {
      // Expected version — no migration needed.
    } else if (existingVersion < SCHEMA_VERSION) {
      // Incremental migrations — applied in ascending order so a DB at ANY
      // supported older version catches up to SCHEMA_VERSION within a single
      // open (a v1 DB runs v1→v2 then v2→v3; a v2 DB runs only v2→v3). Each
      // step is guarded by the version it migrates FROM and stamps user_version
      // on completion. The chain is exhaustive over [1, SCHEMA_VERSION); a
      // future step appends a new `if (existingVersion < N)` block.
      if (existingVersion < 2) {
        // v1 → v2: add UNIQUE index on facts(content, created_at, session_id, category).
        // First, deduplicate any colliding rows keeping the lowest id.
        this.db.exec(`
          DELETE FROM facts
          WHERE id NOT IN (
            SELECT MIN(id)
            FROM facts
            GROUP BY content, created_at, COALESCE(session_id, ''), category
          );
        `);
        // Rebuild FTS index after the dedup deletes.
        this.db.exec(`INSERT INTO facts_fts(facts_fts) VALUES('rebuild');`);
        // Apply the new unique index.
        this.db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_fingerprint
            ON facts(content, created_at, COALESCE(session_id, ''), category);
        `);
        this.db.pragma(`user_version = 2`);
        debugLog('memory-store: migrated schema v1 → v2 (added fingerprint UNIQUE index)');
      }
      if (existingVersion < 3) {
        // v2 → v3: add a NULLABLE `actor` column to sessions ('main' |
        // 'subagent' execution role). No default → existing rows read back
        // NULL, so the migration cannot fail on stored data. (The column is
        // additive, but the SCHEMA_VERSION guard above still rejects a v3 DB
        // from older builds — see the deployment note.)
        //
        // SQLite has no `ADD COLUMN IF NOT EXISTS`. The table_info check is
        // cheap and covers sequential re-runs. It is NOT atomic across
        // processes, though — this global DB is cold-opened concurrently by
        // every AFK surface, so two new-build processes can race the ALTER and
        // the loser throws "duplicate column name". Wrap it: treat an
        // already-present column (re-checked via table_info, not the error
        // text) as success; re-throw if the column stayed absent.
        const hasActor = (): boolean =>
          (this.db.pragma('table_info(sessions)') as Array<{ name: string }>).some(
            (col) => col.name === 'actor',
          );
        if (!hasActor()) {
          try {
            this.db.exec(`ALTER TABLE sessions ADD COLUMN actor TEXT;`);
          } catch (err) {
            if (!hasActor()) throw err;
          }
        }
        this.db.pragma(`user_version = 3`);
        debugLog('memory-store: migrated schema v2 → v3 (added sessions.actor column)');
      }
    } else {
      // existingVersion > SCHEMA_VERSION: DB was written by a newer build.
      this.db.close();
      throw new Error(
        `memory.db schema version ${existingVersion} is newer than this build supports (${SCHEMA_VERSION}). ` +
          `Upgrade agent-afk to a version that understands schema v${existingVersion}.`,
      );
    }

    this.replayWAL();
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
        sleepSync(BACKOFF_MS);
      }
    }
  }

  // ── Hot memory ──────────────────────────────────────────────

  loadHot(): string | null {
    const path = join(this.dir, HOT_FILE);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  }

  // Invariant: the bytes written to HOT.md never exceed MAX_HOT_CHARS, because
  // every future session injects this file verbatim into its system prompt.
  // Oversize input is TRUNCATED, never rejected — a hard throw here is a
  // dead-end for the agent (the write fails, nothing persists) and forces a
  // destructive manual re-trim. The truncation covenant instead degrades
  // gracefully:
  //   - Tail-truncation keeps content from the start, so the leading region
  //     (identity, by the "most-durable first" prompt convention) survives.
  //   - The first HOT_HEAD_CHARS are never sacrificed to the complete-line cut.
  //   - A visible sentinel marks the cut so it is auditable in-file.
  //   - The write is atomic (temp + rename) so a crash mid-write can never
  //     leave a partial HOT.md that every future session would then inject.
  // Returns usage of the bytes actually written (incl. whether truncation
  // fired) so callers can surface a budget signal to the agent.
  saveHot(content: string): HotUsage {
    const path = join(this.dir, HOT_FILE);
    let toWrite = content;
    let truncated = false;

    if (content.length > MAX_HOT_CHARS) {
      truncated = true;
      // Reserve room for the sentinel + joining newlines so the final file
      // still fits MAX_HOT_CHARS.
      const budget = MAX_HOT_CHARS - HOT_TRUNCATION_SENTINEL.length - 2;
      let kept = content.slice(0, budget);
      // Prefer cutting at the last complete line (no half-lines) — but only
      // when that cut preserves the protected head. If the sole newline sits
      // inside the head region, keep the raw char-slice rather than dropping
      // identity content.
      const lastNewline = kept.lastIndexOf('\n');
      if (lastNewline >= HOT_HEAD_CHARS) {
        kept = kept.slice(0, lastNewline);
      }
      toWrite = `${kept.replace(/\s+$/, '')}\n${HOT_TRUNCATION_SENTINEL}\n`;
    }

    // Single-level backup of the prior version before overwriting.
    if (existsSync(path)) {
      copyFileSync(path, join(this.dir, HOT_BACKUP));
    }
    // Atomic write: write a temp file in the same directory, then rename it
    // over HOT.md. renameSync is atomic on POSIX, so a concurrent reader (or a
    // crash) never observes a partially-written file.
    const tmp = join(this.dir, HOT_TMP);
    writeFileSync(tmp, toWrite, 'utf-8');
    renameSync(tmp, path);

    return this.computeHotUsage(toWrite, truncated);
  }

  /** Report current HOT.md usage without modifying the file. */
  hotUsage(): HotUsage {
    const content = this.loadHot() ?? '';
    return this.computeHotUsage(content, content.includes(HOT_TRUNCATION_SENTINEL));
  }

  private computeHotUsage(content: string, truncated: boolean): HotUsage {
    const chars = content.length;
    return {
      chars,
      tokens: estimateTokens(content),
      maxTokens: HOT_TOKEN_CAP,
      pct: Math.min(100, Math.round((chars / MAX_HOT_CHARS) * 100)),
      truncated,
    };
  }

  // ── Facts ───────────────────────────────────────────────────

  storeFact(fact: NewFact): number {
    const now = new Date().toISOString();
    // Trust boundary: agent-authored content is stored verbatim. This is a
    // local-only store; do not surface this content to other agents/users
    // without escaping.
    this.appendWAL({
      type: 'fact',
      timestamp: now,
      data: { ...fact, created_at: now },
    });
    const stmt = this.db.prepare(`
      INSERT INTO facts (session_id, created_at, category, content, source_surface)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      fact.session_id ?? null,
      now,
      fact.category,
      fact.content,
      fact.source_surface,
    );
    return Number(result.lastInsertRowid);
  }

  supersedeFact(factId: number, newContent: string, category?: string): number {
    const old = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(factId) as Fact | undefined;
    if (!old) throw new Error(`Fact ${factId} not found`);

    const now = new Date().toISOString();
    const resolvedCategory = category ?? old.category;

    this.appendWAL({
      type: 'fact',
      timestamp: now,
      data: {
        session_id: old.session_id,
        created_at: now,
        category: resolvedCategory,
        content: newContent,
        source_surface: old.source_surface,
      },
    });

    const stmt = this.db.prepare(`
      INSERT INTO facts (session_id, created_at, category, content, source_surface, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let newId: number;
    try {
      const result = stmt.run(
        old.session_id,
        now,
        resolvedCategory,
        newContent,
        old.source_surface,
        1.0,
      );
      newId = Number(result.lastInsertRowid);
    } catch (e: unknown) {
      // UNIQUE constraint failure: the exact same (content, created_at,
      // session_id, category) fingerprint already exists — this is a WAL
      // replay re-applying a supersede that already landed.  Locate the
      // existing row and return its id so the superseded_by pointer is still
      // wired correctly (idempotent).
      if (
        e instanceof Error &&
        e.message.includes('UNIQUE constraint failed')
      ) {
        const existing = this.db
          .prepare(
            `SELECT id FROM facts
               WHERE content = ?
                 AND created_at = ?
                 AND COALESCE(session_id, '') = COALESCE(?, '')
                 AND category = ?
               LIMIT 1`,
          )
          .get(newContent, now, old.session_id ?? null, resolvedCategory) as
          | { id: number }
          | undefined;
        if (existing) {
          newId = existing.id;
        } else {
          throw e; // Unexpected — surface to caller.
        }
      } else {
        throw e;
      }
    }

    this.db.prepare('UPDATE facts SET superseded_by = ? WHERE id = ?').run(newId, factId);
    // C9: store 4-field fingerprints (content + created_at + session_id +
    // category) — the same fields covered by the UNIQUE index added in v2 —
    // so the supersede relationship survives a crash-then-replay scenario.
    // Including session_id and category avoids ambiguity when the same content
    // string appears under different categories or sessions.
    this.appendWAL({
      type: 'supersede',
      timestamp: now,
      data: {
        old_content: old.content,
        old_created_at: old.created_at,
        old_session_id: old.session_id ?? null,
        old_category: old.category,
        new_content: newContent,
        new_created_at: now,
        new_session_id: old.session_id ?? null,
        new_category: resolvedCategory,
        // Legacy fields kept for readers that haven't yet upgraded; can be
        // removed in a future cleanup pass once all WAL files have been replayed.
        old_fact_id: factId,
        new_fact_id: newId,
      },
    });
    return newId;
  }

  removeFact(factId: number): boolean {
    const result = this.db.prepare('DELETE FROM facts WHERE id = ?').run(factId);
    return result.changes > 0;
  }

  getFact(factId: number): Fact | null {
    const row = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(factId);
    return (row as Fact) ?? null;
  }

  searchFacts(query: string, opts?: SearchOpts): Fact[] {
    const limit = opts?.limit ?? 10;
    const conditions: string[] = ['facts_fts MATCH ?'];
    const params: unknown[] = [query];

    if (opts?.category) {
      conditions.push('f.category = ?');
      params.push(opts.category);
    }
    if (opts?.since) {
      conditions.push('f.created_at >= ?');
      params.push(opts.since);
    }
    conditions.push('f.superseded_by IS NULL');

    const sql = `
      SELECT f.*, facts_fts.rank
      FROM facts f
      JOIN facts_fts ON facts_fts.rowid = f.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY facts_fts.rank
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as (Fact & { rank: number })[];
    return rows;
  }

  // ── Sessions ────────────────────────────────────────────────

  startSession(session: NewSession): void {
    const now = new Date().toISOString();
    this.appendWAL({
      type: 'session_start',
      timestamp: now,
      data: { ...session, started_at: now },
    });
    this.db.prepare(`
      INSERT OR IGNORE INTO sessions (session_id, surface, started_at, actor)
      VALUES (?, ?, ?, ?)
    `).run(session.session_id, session.surface, now, session.actor ?? null);
  }

  endSession(
    sessionId: string,
    summary: string,
    outcome: SessionOutcome,
    tokenCount?: number,
    costUsd?: number,
  ): void {
    const now = new Date().toISOString();
    this.appendWAL({
      type: 'session_end',
      timestamp: now,
      data: { session_id: sessionId, summary, outcome, ended_at: now },
    });
    this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, summary = ?, outcome = ?, token_count = ?, cost_usd = ?
      WHERE session_id = ?
    `).run(now, summary, outcome, tokenCount ?? null, costUsd ?? null, sessionId);
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    return (row as SessionRecord) ?? null;
  }

  recentSessions(limit: number = 5): SessionRecord[] {
    return this.db.prepare(
      'SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as SessionRecord[];
  }

  // ── Procedures ──────────────────────────────────────────────

  writeProcedure(name: string, content: string, sessionId?: string): void {
    const safeName = validateProcedureName(name);
    const procDir = resolve(join(this.dir, PROCEDURES_DIR));
    const filePath = resolve(procDir, `${safeName}.md`);
    assertWithinDir(filePath, procDir);

    const frontmatter = [
      '---',
      `name: ${safeName}`,
      `created: ${new Date().toISOString()}`,
      `source_session: ${sessionId ?? 'unknown'}`,
      `access_count: 0`,
      '---',
      '',
    ].join('\n');
    writeFileSync(filePath, frontmatter + content, 'utf-8');
  }

  loadProcedure(name: string): Procedure | null {
    const safeName = validateProcedureName(name);
    const procDir = resolve(join(this.dir, PROCEDURES_DIR));
    const path = resolve(procDir, `${safeName}.md`);
    assertWithinDir(path, procDir);
    if (!existsSync(path)) return null;
    try {
      return parseProcedureFile(path, readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }

  searchProcedures(query: string): Procedure[] {
    const procDir = join(this.dir, PROCEDURES_DIR);
    if (!existsSync(procDir)) return [];
    const terms = query.toLowerCase().split(/\s+/);
    const results: Procedure[] = [];

    for (const file of readdirSync(procDir)) {
      if (!file.endsWith('.md')) continue;
      const raw = readFileSync(join(procDir, file), 'utf-8');
      const lower = raw.toLowerCase();
      if (terms.some((t) => lower.includes(t))) {
        const proc = parseProcedureFile(file, raw);
        if (proc) results.push(proc);
      }
    }
    return results;
  }

  // ── Combined search ─────────────────────────────────────────

  search(query: string, opts?: SearchOpts): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];

    try {
      const facts = this.searchFacts(query, opts);
      for (const f of facts) {
        results.push({
          type: 'fact',
          content: f.content,
          category: f.category as MemorySearchResult['category'],
          created_at: f.created_at,
          source_session: f.session_id,
          confidence: f.confidence,
        });
      }
    } catch {
      // FTS5 match syntax can fail on malformed queries — degrade gracefully
    }

    if (!opts?.category) {
      const procs = this.searchProcedures(query);
      for (const p of procs) {
        results.push({
          type: 'procedure',
          content: p.content,
          created_at: p.created,
          source_session: p.source_session,
          confidence: 1.0,
        });
      }
    }

    const limit = opts?.limit ?? 10;
    return results.slice(0, limit);
  }

  // ── WAL recovery ────────────────────────────────────────────

  replayWAL(): number {
    const walPath = join(this.dir, WAL_FILE);
    if (!existsSync(walPath)) return 0;

    let replayed = 0;
    try {
      const raw = readFileSync(walPath, 'utf-8').trim();
      if (!raw) {
        unlinkSync(walPath);
        return 0;
      }

      const lines = raw.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!isValidWALEntry(parsed)) {
            debugLog('WAL replay: skipping invalid entry:', line.slice(0, 200));
            continue;
          }
          const entry = parsed;
          if (entry.type === 'session_start') {
            const d = entry.data;
            this.db.prepare(`
              INSERT OR IGNORE INTO sessions (session_id, surface, started_at, actor)
              VALUES (?, ?, ?, ?)
            `).run(d['session_id'], d['surface'], d['started_at'], d['actor'] ?? null);
            replayed++;
          } else if (entry.type === 'session_end') {
            const d = entry.data;
            this.db.prepare(`
              UPDATE sessions SET ended_at = ?, summary = ?, outcome = ?
              WHERE session_id = ? AND ended_at IS NULL
            `).run(d['ended_at'], d['summary'], d['outcome'], d['session_id']);
            replayed++;
          } else if (entry.type === 'fact') {
            const d = entry.data;
            // Use 4-field idempotency check matching the UNIQUE index (v2+).
            const existing = this.db.prepare(
              'SELECT id FROM facts WHERE content = ? AND created_at = ? AND COALESCE(session_id,\'\') = ? AND category = ?',
            ).get(d['content'], d['created_at'], d['session_id'] ?? '', d['category'] ?? '');
            if (!existing) {
              this.db.prepare(`
                INSERT INTO facts (session_id, created_at, category, content, source_surface)
                VALUES (?, ?, ?, ?, ?)
              `).run(
                d['session_id'] ?? null,
                d['created_at'],
                d['category'],
                d['content'],
                d['source_surface'] ?? 'cli',
              );
              replayed++;
            }
          } else if (entry.type === 'supersede') {
            const d = entry.data;

            // C9 (v2): prefer 4-field fingerprints (content + created_at +
            // session_id + category) matching the UNIQUE index added in v2.
            // Fall back to 2-field (content + created_at only) for WAL entries
            // written by the v1 fix, then to raw rowids for legacy entries.
            let resolvedOldId: number | undefined;
            let resolvedNewId: number | undefined;

            if (typeof d['old_content'] === 'string' && typeof d['old_created_at'] === 'string') {
              let oldRow: { id: number } | undefined;
              if (
                typeof d['old_session_id'] !== 'undefined' ||
                typeof d['old_category'] === 'string'
              ) {
                // 4-field lookup (v2+ WAL entries).
                oldRow = this.db.prepare(
                  'SELECT id FROM facts WHERE content = ? AND created_at = ? AND COALESCE(session_id,\'\') = ? AND category = ?',
                ).get(
                  d['old_content'],
                  d['old_created_at'],
                  d['old_session_id'] ?? '',
                  d['old_category'] ?? '',
                ) as { id: number } | undefined;
              }
              if (!oldRow) {
                // 2-field fallback (v1 WAL entries).
                oldRow = this.db.prepare(
                  'SELECT id FROM facts WHERE content = ? AND created_at = ?',
                ).get(d['old_content'], d['old_created_at']) as { id: number } | undefined;
              }
              resolvedOldId = oldRow?.id;
            } else if (typeof d['old_fact_id'] === 'number') {
              resolvedOldId = d['old_fact_id'];
            }

            if (typeof d['new_content'] === 'string' && typeof d['new_created_at'] === 'string') {
              let newRow: { id: number } | undefined;
              if (
                typeof d['new_session_id'] !== 'undefined' ||
                typeof d['new_category'] === 'string'
              ) {
                // 4-field lookup (v2+ WAL entries).
                newRow = this.db.prepare(
                  'SELECT id FROM facts WHERE content = ? AND created_at = ? AND COALESCE(session_id,\'\') = ? AND category = ?',
                ).get(
                  d['new_content'],
                  d['new_created_at'],
                  d['new_session_id'] ?? '',
                  d['new_category'] ?? '',
                ) as { id: number } | undefined;
              }
              if (!newRow) {
                // 2-field fallback (v1 WAL entries).
                newRow = this.db.prepare(
                  'SELECT id FROM facts WHERE content = ? AND created_at = ?',
                ).get(d['new_content'], d['new_created_at']) as { id: number } | undefined;
              }
              resolvedNewId = newRow?.id;
            } else if (typeof d['new_fact_id'] === 'number') {
              resolvedNewId = d['new_fact_id'];
            }

            if (typeof resolvedOldId === 'number' && typeof resolvedNewId === 'number') {
              this.db.prepare(
                'UPDATE facts SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL',
              ).run(resolvedNewId, resolvedOldId);
              replayed++;
            }
          }
        } catch (err) {
          debugLog('WAL replay: skipping malformed line:', String(err));
        }
      }
      unlinkSync(walPath);
    } catch (err) {
      debugLog('WAL file unreadable, skipping recovery:', String(err));
    }
    return replayed;
  }

  close(): void {
    this.db.close();
  }

  // ── Private ─────────────────────────────────────────────────

  private appendWAL(entry: WALEntry): void {
    const walPath = join(this.dir, WAL_FILE);
    try {
      appendFileSync(walPath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      debugLog('WAL append failed (non-fatal):', String(err));
    }
  }
}

/**
 * Block the current thread for `ms` without a busy loop, via a never-notified
 * Atomics.wait on a private SharedArrayBuffer. Used only to back off a
 * contended WAL-mode switch during MemoryStore construction (rare, bounded).
 * Node permits Atomics.wait on the main thread (unlike browsers).
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const SAFE_PROCEDURE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function validateProcedureName(name: string): string {
  if (!name || name.length > 100 || !SAFE_PROCEDURE_NAME.test(name)) {
    throw new Error(
      `Invalid procedure name "${name}": must be 1-100 chars, alphanumeric/hyphens/underscores only`,
    );
  }
  return name;
}

const VALID_WAL_TYPES = new Set(['fact', 'session_start', 'session_end', 'supersede']);
const VALID_CATEGORIES = new Set(['preference', 'convention', 'decision', 'learning']);

function isValidWALEntry(entry: unknown): entry is WALEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  if (typeof e['type'] !== 'string' || !VALID_WAL_TYPES.has(e['type'])) return false;
  if (typeof e['timestamp'] !== 'string') return false;
  if (!e['data'] || typeof e['data'] !== 'object') return false;
  if (e['type'] === 'fact') {
    const d = e['data'] as Record<string, unknown>;
    if (typeof d['category'] !== 'string' || !VALID_CATEGORIES.has(d['category'])) return false;
  }
  return true;
}

function assertWithinDir(filePath: string, dir: string): void {
  const rel = relative(dir, filePath);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error('Path traversal detected');
  }
}

function parseProcedureFile(filename: string, raw: string): Procedure | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return {
      name: basename(filename, '.md'),
      content: raw,
      created: '',
      source_session: null,
      access_count: 0,
    };
  }
  const fm = fmMatch[1] ?? '';
  const body = fmMatch[2] ?? '';

  const getName = (s: string) => s.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? basename(filename, '.md');
  const getCreated = (s: string) => s.match(/^created:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const getSession = (s: string) => s.match(/^source_session:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const getCount = (s: string) => {
    const m = s.match(/^access_count:\s*(\d+)$/m);
    return m ? parseInt(m[1]!, 10) : 0;
  };

  return {
    name: getName(fm),
    content: body.trim(),
    created: getCreated(fm),
    source_session: getSession(fm),
    access_count: getCount(fm),
  };
}
