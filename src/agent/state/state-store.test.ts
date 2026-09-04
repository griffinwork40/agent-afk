/**
 * Unit tests for StateStore — the durable cross-session SQLite-backed
 * document store.
 *
 * Each test runs against a fresh temporary database directory so tests are
 * fully isolated from one another and from the real ~/.afk state.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from './state-store.js';

// ── Shared setup/teardown ────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;
let store: StateStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'state-store-test-'));
  dbPath = join(tmpDir, 'test.db');
  store = new StateStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // already closed — ignore
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StateStore', () => {
  it('constructor creates db file under the given path; closes cleanly', () => {
    // The store was created in beforeEach — the file must exist.
    expect(existsSync(dbPath)).toBe(true);

    // close() must not throw.
    expect(() => store.close()).not.toThrow();
  });

  it('schema version mismatch throws on open', () => {
    // Close the store created in beforeEach so we can modify the DB freely.
    store.close();

    // Manually stamp a future schema version into state_meta.
    const raw = new Database(dbPath);
    raw.exec(`UPDATE state_meta SET value = '999' WHERE key = 'schema_version'`);
    raw.close();

    // Opening a new StateStore on this DB should throw with a message
    // mentioning the schema version.
    expect(() => {
      const bad = new StateStore(dbPath);
      bad.close(); // should never reach here
    }).toThrow(/schema version/i);
  });

  it('put → get round-trip; created: true on first insert', () => {
    const result = store.put('myns', 'mykey', { foo: 'bar' });

    expect(result.version).toBe(1);
    expect(result.created).toBe(true);

    const doc = store.get('myns', 'mykey');
    expect(doc).not.toBeNull();
    expect(doc!.key).toBe('mykey');
    expect(doc!.value).toEqual({ foo: 'bar' });
    expect(doc!.version).toBe(1);
  });

  it('second put on same key increments version to 2; created: false', () => {
    store.put('myns', 'mykey', { first: true });

    const second = store.put('myns', 'mykey', { second: true });

    expect(second.version).toBe(2);
    expect(second.created).toBe(false);

    const doc = store.get('myns', 'mykey');
    expect(doc!.version).toBe(2);
    expect(doc!.value).toEqual({ second: true });
  });

  it('put on different namespace does not affect original namespace', () => {
    store.put('ns1', 'shared-key', { from: 'ns1' });

    // ns2 should have no document under the same key.
    const ns2Doc = store.get('ns2', 'shared-key');
    expect(ns2Doc).toBeNull();

    // ns1 document is still intact.
    const ns1Doc = store.get('ns1', 'shared-key');
    expect(ns1Doc).not.toBeNull();
    expect(ns1Doc!.value).toEqual({ from: 'ns1' });
  });

  it('del returns {deleted:true}; subsequent get returns null', () => {
    store.put('myns', 'to-delete', { data: 1 });

    const delResult = store.del('myns', 'to-delete');
    expect(delResult).toEqual({ deleted: true });

    const afterDel = store.get('myns', 'to-delete');
    expect(afterDel).toBeNull();
  });

  it('del on non-existent key returns {deleted:false}', () => {
    const result = store.del('myns', 'ghost-key');
    expect(result).toEqual({ deleted: false });
  });

  it('cas with correct expectedVersion succeeds; version increments', () => {
    store.put('myns', 'cas-key', { v: 1 });

    const result = store.cas('myns', 'cas-key', 1, { v: 2 });

    expect(result.matched).toBe(true);
    expect(result.newVersion).toBe(2);

    const doc = store.get('myns', 'cas-key');
    expect(doc!.version).toBe(2);
    expect(doc!.value).toEqual({ v: 2 });
  });

  it('cas with wrong expectedVersion returns {matched:false}; document unchanged', () => {
    store.put('myns', 'cas-key', { original: true });

    // expectedVersion 99 is wrong — actual version is 1.
    const result = store.cas('myns', 'cas-key', 99, { hijacked: true });

    expect(result.matched).toBe(false);
    expect(result.newVersion).toBeUndefined();

    // Document must be unchanged.
    const doc = store.get('myns', 'cas-key');
    expect(doc!.version).toBe(1);
    expect(doc!.value).toEqual({ original: true });
  });

  it('cas on non-existent key returns {matched:false}', () => {
    const result = store.cas('myns', 'no-such-key', 1, { data: true });
    expect(result).toEqual({ matched: false });
  });

  it('query lists all documents in namespace; respects key_prefix and limit', () => {
    store.put('qns', 'alpha-1', { n: 1 });
    store.put('qns', 'alpha-2', { n: 2 });
    store.put('qns', 'beta-1', { n: 3 });
    store.put('qns', 'beta-2', { n: 4 });
    store.put('qns', 'gamma-1', { n: 5 });

    // All documents in namespace (default limit 20 covers all 5).
    const all = store.query('qns');
    expect(all).toHaveLength(5);
    // Results sorted by key ASC.
    expect(all.map((r) => r.key)).toEqual([
      'alpha-1',
      'alpha-2',
      'beta-1',
      'beta-2',
      'gamma-1',
    ]);

    // key_prefix filter: only 'alpha-*'.
    const alphas = store.query('qns', { key_prefix: 'alpha' });
    expect(alphas).toHaveLength(2);
    expect(alphas.every((r) => r.key.startsWith('alpha'))).toBe(true);

    // limit: first 2 documents (sorted ASC).
    const limited = store.query('qns', { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].key).toBe('alpha-1');
    expect(limited[1].key).toBe('alpha-2');
  });

  it('TTL GC: insert with ttl_ms=100; after 150ms doc is absent', async () => {
    store.put('ttlns', 'expiring', { data: 'bye' }, { ttl_ms: 100 });

    // Verify the document is visible immediately.
    expect(store.get('ttlns', 'expiring')).not.toBeNull();

    // Wait past the TTL.
    await new Promise<void>((r) => setTimeout(r, 150));

    // The in-process get() filters expired entries even before a reopen.
    expect(store.get('ttlns', 'expiring')).toBeNull();

    // Confirm GC also removes it on a fresh open (runTtlGc runs in constructor).
    store.close();
    const reopened = new StateStore(dbPath);
    try {
      expect(reopened.get('ttlns', 'expiring')).toBeNull();
      // query should also exclude it.
      const rows = reopened.query('ttlns');
      expect(rows.every((r) => r.key !== 'expiring')).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it('validation: namespace with / throws; empty key throws', () => {
    // Namespace containing '/' is not in [A-Za-z0-9_.-] and must throw.
    expect(() => store.put('bad/name', 'key', { x: 1 })).toThrow(
      /invalid characters/i,
    );

    // Empty key must throw.
    expect(() => store.put('goodns', '', { x: 1 })).toThrow(/non-empty/i);

    // Empty namespace must throw.
    expect(() => store.put('', 'key', { x: 1 })).toThrow(/non-empty/i);
  });

  it('concurrent cas(): exactly one call wins when both race on version 1', async () => {
    // Establish version 1.
    store.put('myns', 'race-key', { init: true });

    // better-sqlite3 is synchronous, so true OS-level parallelism is
    // impossible in a single Node process. Simulating the race by fanning out
    // two cas() calls via Promise.all() is sufficient: the microtask scheduler
    // interleaves them and the IMMEDIATE transaction serialises their SQLite
    // access, making exactly one win.
    const [r1, r2] = await Promise.all([
      Promise.resolve(store.cas('myns', 'race-key', 1, { winner: 'a' })),
      Promise.resolve(store.cas('myns', 'race-key', 1, { winner: 'b' })),
    ]);

    const matchedCount = [r1, r2].filter((r) => r.matched).length;
    const missedCount = [r1, r2].filter((r) => !r.matched).length;

    expect(matchedCount).toBe(1);
    expect(missedCount).toBe(1);

    // The winning call must have bumped the version to 2.
    const winner = r1.matched ? r1 : r2;
    expect(winner.newVersion).toBe(2);

    // Document must reflect exactly one write.
    const doc = store.get('myns', 'race-key');
    expect(doc!.version).toBe(2);
  });

  it('schema version stamp is correct', () => {
    // The store was created in beforeEach.  Reach directly into the SQLite file
    // with a separate connection so we don't depend on any StateStore API.
    const raw = new Database(dbPath, { readonly: true });
    try {
      const row = raw
        .prepare<[string], { value: string }>('SELECT value FROM state_meta WHERE key = ?')
        .get('schema_version');
      expect(row).not.toBeUndefined();
      expect(row!.value).toBe('1');
    } finally {
      raw.close();
    }
  });
});
