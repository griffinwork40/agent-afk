/**
 * Shared SQLite connection helpers for AFK stores.
 *
 * Three stores (state-store, workspace-store, memory-store) hand-roll the
 * same WAL-enable + busy_timeout setup. This module centralises that logic
 * so the pattern lives in one place and the stores stay under the 350-line
 * ceiling.
 *
 * Design notes
 * ------------
 * - No store superclass: the helper is a plain function, not a base class.
 * - All parameters are explicit; callers supply values so each store retains
 *   full visibility into what is being configured.
 * - Enabling WAL requires a brief EXCLUSIVE lock. SQLite does NOT honour
 *   busy_timeout for the journal-mode change itself, so a contended cold-open
 *   can still throw SQLITE_BUSY immediately. The retry loop handles that
 *   narrow window: read the mode first (lock-free), skip if already 'wal',
 *   otherwise retry up to maxAttempts times with a short backoff.
 *
 * @module agent/storage/sqlite
 */

import type BetterSqlite3 from 'better-sqlite3';
import { sleepSync } from '../../utils/sleep-sync.js';

export interface ConfigureSqliteOptions {
  /**
   * Milliseconds passed to `PRAGMA busy_timeout`. Sets how long ordinary
   * reads/writes wait on a lock before throwing SQLITE_BUSY.
   * @default 5000
   */
  busyTimeoutMs?: number;

  /**
   * Maximum retry attempts for the WAL-mode switch when SQLITE_BUSY is thrown.
   * @default 50
   */
  walMaxAttempts?: number;

  /**
   * Milliseconds to sleep between WAL-switch retry attempts.
   * @default 20
   */
  walBackoffMs?: number;
}

/**
 * Apply standard AFK connection settings to an already-opened SQLite database.
 *
 * Call immediately after `new Database(path)`, before any schema work:
 *
 * ```ts
 * const db = new Database(dbPath);
 * configureSqliteConnection(db);
 * ```
 *
 * What this does, in order:
 * 1. Sets `busy_timeout` so contended reads/writes wait rather than failing fast.
 * 2. Switches the database into WAL journal mode, with a bounded retry loop to
 *    handle concurrent cold-open races (see module note above).
 *
 * @param db      - An open better-sqlite3 Database instance.
 * @param options - Optional overrides for timeout/retry knobs.
 */
export function configureSqliteConnection(
  db: BetterSqlite3.Database,
  options: ConfigureSqliteOptions = {},
): void {
  const {
    busyTimeoutMs = 5000,
    walMaxAttempts = 50,
    walBackoffMs = 20,
  } = options;

  // Step 1: busy_timeout — must be set before any schema work so it covers
  // all subsequent reads and writes.
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // Step 2: WAL mode with bounded retry for concurrent cold-open races.
  for (let attempt = 1; ; attempt++) {
    try {
      if (db.pragma('journal_mode', { simple: true }) === 'wal') return;
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      const busy = (err as { code?: string } | null)?.code === 'SQLITE_BUSY';
      if (!busy || attempt >= walMaxAttempts) throw err;
      sleepSync(walBackoffMs);
    }
  }
}
