/**
 * Unit tests for configureSqliteConnection.
 *
 * Uses an in-memory SQLite database (':memory:') which supports WAL mode
 * reads (journal_mode pragma returns 'memory' for in-memory DBs, but the
 * busy_timeout pragma is still applied and readable). For WAL mode assertion
 * we use a real temp-file database.
 *
 * @module agent/storage/sqlite.test
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSqliteConnection } from './sqlite.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function openMemoryDb(): Database.Database {
  return new Database(':memory:');
}

let tmpDir: string | undefined;

function openFileDb(name: string): Database.Database {
  tmpDir = mkdtempSync(join(tmpdir(), `afk-sqlite-test-${name}-`));
  return new Database(join(tmpDir, 'test.db'));
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('configureSqliteConnection', () => {
  describe('busy_timeout', () => {
    it('applies default busy_timeout of 5000 ms on an in-memory DB', () => {
      const db = openMemoryDb();
      configureSqliteConnection(db);
      const timeout = db.pragma('busy_timeout', { simple: true }) as number;
      expect(timeout).toBe(5000);
      db.close();
    });

    it('applies a custom busyTimeoutMs', () => {
      const db = openMemoryDb();
      configureSqliteConnection(db, { busyTimeoutMs: 1234 });
      const timeout = db.pragma('busy_timeout', { simple: true }) as number;
      expect(timeout).toBe(1234);
      db.close();
    });

    it('applies busy_timeout = 0 when explicitly set to 0', () => {
      const db = openMemoryDb();
      configureSqliteConnection(db, { busyTimeoutMs: 0 });
      const timeout = db.pragma('busy_timeout', { simple: true }) as number;
      expect(timeout).toBe(0);
      db.close();
    });
  });

  describe('WAL mode (file-backed DB)', () => {
    it('switches a new file-backed DB into WAL mode', () => {
      const db = openFileDb('wal');
      configureSqliteConnection(db);
      const mode = db.pragma('journal_mode', { simple: true }) as string;
      expect(mode).toBe('wal');
      db.close();
    });

    it('is idempotent — calling twice does not throw and leaves mode as wal', () => {
      const db = openFileDb('wal-idempotent');
      configureSqliteConnection(db);
      expect(() => configureSqliteConnection(db)).not.toThrow();
      const mode = db.pragma('journal_mode', { simple: true }) as string;
      expect(mode).toBe('wal');
      db.close();
    });

    it('leaves busy_timeout set after a second call with different value', () => {
      const db = openFileDb('wal-two-calls');
      configureSqliteConnection(db, { busyTimeoutMs: 1000 });
      configureSqliteConnection(db, { busyTimeoutMs: 2000 });
      const timeout = db.pragma('busy_timeout', { simple: true }) as number;
      expect(timeout).toBe(2000);
      db.close();
    });
  });

  describe('in-memory DB (WAL not persisted)', () => {
    it('does not throw on an in-memory DB even though WAL is not persisted', () => {
      const db = openMemoryDb();
      expect(() => configureSqliteConnection(db)).not.toThrow();
      db.close();
    });

    it('busy_timeout is applied regardless of whether WAL mode was set', () => {
      const db = openMemoryDb();
      configureSqliteConnection(db, { busyTimeoutMs: 3000 });
      const timeout = db.pragma('busy_timeout', { simple: true }) as number;
      expect(timeout).toBe(3000);
      db.close();
    });
  });

  describe('non-BUSY errors are re-thrown', () => {
    it('throws immediately on a non-BUSY error from pragma (simulated via closed DB)', () => {
      const db = openFileDb('err');
      db.close(); // closing before configure causes operations to throw
      expect(() => configureSqliteConnection(db)).toThrow();
    });

    it('re-throws a non-BUSY error from the WAL switch on the first attempt (no retry)', () => {
      const db = openFileDb('wal-nobusy');
      const pragmaNames: string[] = [];
      const mockPragma = (name: string): unknown => {
        pragmaNames.push(name);
        if (name === 'journal_mode') return 'delete'; // not WAL → proceeds to switch
        if (name === 'journal_mode = WAL') {
          throw Object.assign(new Error('SQLITE_CORRUPT: file is not a database'), {
            code: 'SQLITE_CORRUPT',
          });
        }
        return []; // busy_timeout = 5000
      };
      vi.spyOn(db, 'pragma').mockImplementation(mockPragma as typeof db.pragma);
      expect(() => configureSqliteConnection(db)).toThrowError('file is not a database');
      // Exactly ONE WAL-switch attempt — a BUSY error would have looped up to
      // walMaxAttempts; this proves the WAL non-BUSY branch re-throws at once.
      expect(pragmaNames.filter((n) => n === 'journal_mode = WAL')).toHaveLength(1);
      db.close();
    });
  });
});
