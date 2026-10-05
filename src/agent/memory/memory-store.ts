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
 * Schema DDL, migrations, and WAL-mode setup: memory-store.schema.ts
 * WAL append/replay logic:                    memory-store.wal.ts
 * Procedure read/write helpers:               memory-store.procedures.ts
 * FTS query helpers:                          memory-store.fts.ts
 * Access-count queries:                       memory-store.access.ts
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
  copyFileSync,
  renameSync,
} from 'fs';
import { join } from 'path';
import { getMemoryDir } from '../../paths.js';
import { debugLog } from '../../utils/debug.js';
import { factsToResults, sanitizeFtsQuery } from './memory-store.fts.js';
import { queryUnaccessed, queryAccessStats } from './memory-store.access.js';
import { SCHEMA_VERSION, SCHEMA_SQL, runMigrations, enableWalMode } from './memory-store.schema.js';
import { appendWAL, replayWAL as replayWALImpl } from './memory-store.wal.js';
import { supersedeFact as supersededFactImpl } from './memory-store.facts.js';
import {
  writeProcedure as writeProcedureImpl,
  loadProcedure as loadProcedureImpl,
  searchProcedures as searchProceduresImpl,
  PROCEDURES_DIR,
} from './memory-store.procedures.js';
import type {
  AccessStats,
  Fact,
  NewFact,
  SearchOpts,
  MemorySearchResult,
  SessionRecord,
  NewSession,
  Procedure,
  SessionOutcome,
} from './types.js';

const HOT_FILE = 'HOT.md';
const HOT_BACKUP = 'HOT.md.bak';
const DB_FILE = 'memory.db';
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
    enableWalMode(this.db);

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
      runMigrations(this.db, existingVersion);
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
    appendWAL(this.dir, {
      type: 'fact',
      timestamp: now,
      data: { ...fact, created_at: now },
    });
    const stmt = this.db.prepare(`
      INSERT INTO facts (session_id, created_at, category, content, source_surface, evidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      fact.session_id ?? null,
      now,
      fact.category,
      fact.content,
      fact.source_surface,
      fact.evidence ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  supersedeFact(
    factId: number,
    newContent: string,
    category?: string,
    evidence?: string | null,
  ): number {
    return supersededFactImpl(this.db, this.dir, factId, newContent, category, evidence);
  }

  removeFact(factId: number): boolean {
    const result = this.db.prepare('DELETE FROM facts WHERE id = ?').run(factId);
    return result.changes > 0;
  }

  getFact(factId: number): Fact | null {
    const row = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(factId);
    return (row as Fact) ?? null;
  }

  /**
   * Returns non-superseded facts with `access_count = 0` that are older than
   * `minAgeDays` days (default 30). Read-only — no facts are modified or
   * deleted. Use as a dry-run signal for a future GC sweep.
   */
  getUnaccessed(minAgeDays?: number): Fact[] {
    return queryUnaccessed(this.db, minAgeDays);
  }

  /** Returns aggregate access-count statistics for the fact archive. */
  getAccessStats(): AccessStats {
    return queryAccessStats(this.db);
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

    // Activate access tracking: increment access_count and set last_accessed on
    // every fact returned by a search. Runs as a single bulk UPDATE so the
    // round-trip cost is O(1) rather than O(n). Wrapped in a try/catch so a
    // transient write failure never surfaces to the caller — reads degrading
    // gracefully is always preferable to throwing here.
    if (rows.length > 0) {
      const now = new Date().toISOString();
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      try {
        this.db
          .prepare(
            `UPDATE facts
               SET access_count = access_count + 1,
                   last_accessed = ?
             WHERE id IN (${placeholders})`,
          )
          .run(now, ...ids);
      } catch (err) {
        debugLog('memory-store: access tracking update failed (non-fatal):', String(err));
      }
    }

    // Strip the FTS5 `rank` column — it is a query-time artifact and must not
    // leak into the public Fact[] return type.
    return rows.map(({ rank: _rank, ...fact }) => fact as Fact);
  }

  // ── Sessions ────────────────────────────────────────────────

  startSession(session: NewSession): void {
    const now = new Date().toISOString();
    appendWAL(this.dir, {
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
    appendWAL(this.dir, {
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
    writeProcedureImpl(this.dir, name, content, sessionId);
  }

  loadProcedure(name: string): Procedure | null {
    return loadProcedureImpl(this.dir, name);
  }

  searchProcedures(query: string): Procedure[] {
    return searchProceduresImpl(this.dir, query);
  }

  // ── Combined search ─────────────────────────────────────────

  search(query: string, opts?: SearchOpts): MemorySearchResult[] {
    let factResults: MemorySearchResult[];
    try {
      factResults = factsToResults(this.searchFacts(query, opts));
    } catch (err) {
      // FTS5 MATCH syntax can fail on queries with bareword characters that FTS5
      // treats as operators or column names (hyphens, colons, slashes, dots).
      // Retry once with a sanitized query that wraps problematic bare tokens in
      // double-quotes while preserving explicit FTS5 operators (AND, OR, NOT,
      // quoted phrases, prefix*). If the sanitized query also fails, rethrow so
      // the handler in memory-tools.ts can surface a diagnostic error instead of
      // returning a silent empty result indistinguishable from a true miss.
      const sanitized = sanitizeFtsQuery(query);
      if (sanitized !== query) {
        debugLog('memory-store: FTS5 query failed, retrying with sanitized form:', sanitized);
        factResults = factsToResults(this.searchFacts(sanitized, opts)); // throws → propagates
      } else {
        throw err; // No sanitization possible; surface the error to the handler.
      }
    }
    // Invariant: `results` aliases `factResults` (no defensive copy).
    // The array is consumed exactly once (push + slice below) and never read
    // from again. Add a spread copy here if a second reader ever appears.
    const results: MemorySearchResult[] = factResults;

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
    return replayWALImpl(this.db, this.dir);
  }

  close(): void {
    this.db.close();
  }
}
