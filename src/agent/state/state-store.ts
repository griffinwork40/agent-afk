/**
 * Durable cross-session structured state store.
 *
 * A namespaced JSON document store backed by a SQLite file (`~/.afk/state/kv/kv.db`).
 * Provides get/put/cas/delete/query operations with optional TTL and CAS semantics.
 *
 * WAL-mode SQLite with busy_timeout for safe concurrent access across surfaces.
 *
 * @module agent/state/state-store
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const SCHEMA_VERSION = 1;
const NS_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const NS_KEY_MAX = 128;

export interface PutResult {
  version: number;
  created: boolean;
}

export interface CasResult {
  matched: boolean;
  newVersion?: number;
}

export interface DelResult {
  deleted: boolean;
}

export interface QueryRow {
  key: string;
  value: unknown;
  version: number;
  updated_at: number;
}

export interface PutOpts {
  ttl_ms?: number;
  metadata?: unknown;
}

/**
 * Validate a namespace or key string. Throws if the string does not match
 * the allowed pattern or exceeds the maximum length.
 */
function validateNamespaceOrKey(s: string, label = 'namespace or key'): void {
  if (!s || s.length === 0) {
    throw new Error(`StateStore: ${label} must be non-empty`);
  }
  if (s.length > NS_KEY_MAX) {
    throw new Error(
      `StateStore: ${label} exceeds max length of ${NS_KEY_MAX} characters (got ${s.length})`,
    );
  }
  if (!NS_KEY_PATTERN.test(s)) {
    throw new Error(
      `StateStore: ${label} contains invalid characters. ` +
        `Only [A-Za-z0-9_.-] are allowed, got: "${s}"`,
    );
  }
}

/**
 * Validate that a value is JSON-serializable. Throws if not.
 */
function validateJson(v: unknown): void {
  try {
    JSON.stringify(v);
  } catch {
    throw new Error(`StateStore: value is not JSON-serializable`);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Durable cross-session key-value document store.
 *
 * Documents are namespaced (namespace + key) JSON values. Each document
 * tracks a monotonically incrementing version number for optimistic
 * concurrency (CAS operations). Optional TTL is enforced at open time via
 * a GC sweep, not continuously.
 */
export class StateStore {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    // busy_timeout makes ordinary contended reads/writes wait up to 5s rather
    // than immediately throwing SQLITE_BUSY on the first lock conflict.
    this.db.pragma('busy_timeout = 5000');
    this.enableWalMode();
    this.initSchema();
    this.runTtlGc();
  }

  /**
   * Switch the database into WAL mode, tolerant of concurrent cold opens.
   * Mirrors the pattern in memory-store.ts to handle SQLITE_BUSY races.
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

  /**
   * Initialize the schema.
   * Order: create state_meta → check schema version → create state_documents + indexes.
   */
  private initSchema(): void {
    // Step 1: Create meta table and stamp version (idempotent).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO state_meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
    `);

    // Step 2: Read and validate schema version.
    const row = this.db
      .prepare<[string], { value: string }>('SELECT value FROM state_meta WHERE key = ?')
      .get('schema_version');
    const existingVersion = row ? parseInt(row.value, 10) : 0;

    if (existingVersion > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(
        `StateStore: database schema version ${existingVersion} is newer than this build supports (${SCHEMA_VERSION}). ` +
          `Upgrade agent-afk to open this database.`,
      );
    }
    // existingVersion === SCHEMA_VERSION: no migration needed.
    // existingVersion < SCHEMA_VERSION: future migrations would go here.

    // Step 3: Create documents table and indexes (idempotent).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_documents (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        producer TEXT,
        metadata TEXT,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS idx_state_ns ON state_documents(namespace);
      CREATE INDEX IF NOT EXISTS idx_state_expires ON state_documents(expires_at)
        WHERE expires_at IS NOT NULL;
    `);
  }

  /**
   * Delete expired documents. Runs at open time so callers see a consistent
   * view without expired entries.
   */
  private runTtlGc(): void {
    this.db
      .prepare('DELETE FROM state_documents WHERE expires_at IS NOT NULL AND expires_at < ?')
      .run(Date.now());
  }

  /**
   * Retrieve a document by namespace + key. Returns null if not found or expired.
   */
  get(namespace: string, key: string): QueryRow | null {
    validateNamespaceOrKey(namespace, 'namespace');
    validateNamespaceOrKey(key, 'key');

    const row = this.db
      .prepare<[string, string], {
        key: string;
        value: string;
        version: number;
        updated_at: number;
        expires_at: number | null;
      }>(`
        SELECT key, value, version, updated_at, expires_at
        FROM state_documents
        WHERE namespace = ? AND key = ?
      `)
      .get(namespace, key);

    if (!row) return null;
    // Filter out expired entries not yet GC'd (between GC sweeps)
    if (row.expires_at !== null && row.expires_at < Date.now()) return null;
    return {
      key: row.key,
      value: JSON.parse(row.value),
      version: row.version,
      updated_at: row.updated_at,
    };
  }

  /**
   * Write a document. Creates on first insert (version=1) and increments
   * version on subsequent updates.
   */
  put(
    namespace: string,
    key: string,
    value: unknown,
    opts?: PutOpts,
    producer?: string,
  ): PutResult {
    validateNamespaceOrKey(namespace, 'namespace');
    validateNamespaceOrKey(key, 'key');
    validateJson(value);

    const now = Date.now();
    const expires_at = opts?.ttl_ms !== undefined ? now + opts.ttl_ms : null;
    const metadata = opts?.metadata !== undefined ? JSON.stringify(opts.metadata) : null;
    const serialized = JSON.stringify(value);

    return this.db.transaction((): PutResult => {
      // Check if document already exists to determine created flag.
      const existing = this.db
        .prepare<[string, string], { version: number } | undefined>(`
          SELECT version FROM state_documents WHERE namespace = ? AND key = ?
        `)
        .get(namespace, key);

      this.db
        .prepare(`
          INSERT INTO state_documents
            (namespace, key, value, version, created_at, updated_at, expires_at, producer, metadata)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
          ON CONFLICT(namespace, key) DO UPDATE SET
            value    = excluded.value,
            version  = version + 1,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at,
            producer = excluded.producer,
            metadata = excluded.metadata
        `)
        .run(namespace, key, serialized, now, now, expires_at, producer ?? null, metadata);

      // Read back actual version (handles the UPSERT version increment).
      const after = this.db
        .prepare<[string, string], { version: number }>(`
          SELECT version FROM state_documents WHERE namespace = ? AND key = ?
        `)
        .get(namespace, key)!;

      return { version: after.version, created: !existing };
    })();
  }

  /**
   * Compare-and-swap. Updates the document only when its current version
   * matches expectedVersion. Returns {matched: false} if the version
   * doesn't match or the document doesn't exist.
   */
  cas(
    namespace: string,
    key: string,
    expectedVersion: number,
    value: unknown,
    opts?: PutOpts,
    producer?: string,
  ): CasResult {
    validateNamespaceOrKey(namespace, 'namespace');
    validateNamespaceOrKey(key, 'key');
    validateJson(value);

    const txn = this.db.transaction((): CasResult => {
      const row = this.db
        .prepare<[string, string], {
          version: number;
          expires_at: number | null;
        }>(`
          SELECT version, expires_at FROM state_documents WHERE namespace = ? AND key = ?
        `)
        .get(namespace, key);

      if (!row) return { matched: false };
      // Treat expired docs as non-existent
      if (row.expires_at !== null && row.expires_at < Date.now()) return { matched: false };
      if (row.version !== expectedVersion) return { matched: false };

      const now = Date.now();
      const newVersion = row.version + 1;
      const expires_at = opts?.ttl_ms !== undefined ? now + opts.ttl_ms : null;
      const metadata = opts?.metadata !== undefined ? JSON.stringify(opts.metadata) : null;
      const serialized = JSON.stringify(value);

      this.db
        .prepare(`
          UPDATE state_documents SET
            value = ?,
            version = ?,
            updated_at = ?,
            expires_at = ?,
            producer = ?,
            metadata = ?
          WHERE namespace = ? AND key = ?
        `)
        .run(serialized, newVersion, now, expires_at, producer ?? null, metadata, namespace, key);

      return { matched: true, newVersion };
    });

    return txn.immediate();
  }

  /**
   * Delete a document. Returns {deleted: true} if found and removed.
   */
  del(namespace: string, key: string): DelResult {
    validateNamespaceOrKey(namespace, 'namespace');
    validateNamespaceOrKey(key, 'key');

    const result = this.db
      .prepare(`DELETE FROM state_documents WHERE namespace = ? AND key = ?`)
      .run(namespace, key);

    return { deleted: result.changes > 0 };
  }

  /**
   * Query documents in a namespace, with optional key_prefix filter and
   * limit/offset pagination.
   */
  query(
    namespace: string,
    opts?: { key_prefix?: string; limit?: number; offset?: number },
  ): QueryRow[] {
    validateNamespaceOrKey(namespace, 'namespace');

    const now = Date.now();
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;

    let sql: string;
    let rows: Array<{
      key: string;
      value: string;
      version: number;
      updated_at: number;
      expires_at: number | null;
    }>;

    if (opts?.key_prefix) {
      // Use LIKE with escaped prefix — no user data in % patterns since
      // we control the suffix.
      const prefix = opts.key_prefix.replace(/[%_\\]/g, '\\$&');
      sql = `
        SELECT key, value, version, updated_at, expires_at
        FROM state_documents
        WHERE namespace = ?
          AND key LIKE ? ESCAPE '\\'
          AND (expires_at IS NULL OR expires_at >= ?)
        ORDER BY key ASC
        LIMIT ? OFFSET ?
      `;
      rows = this.db
        .prepare<[string, string, number, number, number], typeof rows extends Array<infer R> ? R : never>(sql)
        .all(namespace, `${prefix}%`, now, limit, offset) as typeof rows;
    } else {
      sql = `
        SELECT key, value, version, updated_at, expires_at
        FROM state_documents
        WHERE namespace = ?
          AND (expires_at IS NULL OR expires_at >= ?)
        ORDER BY key ASC
        LIMIT ? OFFSET ?
      `;
      rows = this.db
        .prepare<[string, number, number, number], typeof rows extends Array<infer R> ? R : never>(sql)
        .all(namespace, now, limit, offset) as typeof rows;
    }

    return rows.map((r) => ({
      key: r.key,
      value: JSON.parse(r.value),
      version: r.version,
      updated_at: r.updated_at,
    }));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore close errors (already closed)
    }
  }
}
