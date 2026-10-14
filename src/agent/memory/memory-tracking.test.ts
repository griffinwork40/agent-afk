import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MemoryStore } from './memory-store.js';
import { sweepMemoryGc } from './memory-gc-sweep.js';
import { runMigrations, SCHEMA_SQL } from './memory-store.schema.js';

let dir: string;
let store: MemoryStore;
let db: Database.Database;
const epoch = '2027-01-01T00:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(epoch));
  dir = mkdtempSync(join(tmpdir(), 'afk-memory-tracking-'));
  store = new MemoryStore(dir);
  db = new Database(join(dir, 'memory.db'));
  vi.stubEnv('AFK_MEMORY_GC_SWEEP_ENABLE', '1');
});
afterEach(() => {
  db.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function fact(content = 'tracking unique recall'): number {
  return store.storeFact({ content, category: 'learning', source_surface: 'test' });
}
function marker(): string {
  return (db.prepare('SELECT value FROM memory_metadata WHERE key = ?')
    .get('tracking_started_at') as { value: string }).value;
}

describe('per-database tracking epoch', () => {
  it('persists the first open time across handles and restarts', () => {
    expect(marker()).toBe(epoch);
    vi.setSystemTime(new Date('2027-02-15'));
    const second = new MemoryStore(dir);
    second.close();
    expect(marker()).toBe(epoch);
  });

  it('migrates v4 without trusting historical zero counts', async () => {
    // Seed a legacy row directly (not a new-build WAL entry).
    const id = Number(db.prepare(`INSERT INTO facts (created_at, content, category)
      VALUES ('2026-12-31T00:00:00.000Z', 'tracking unique recall', 'learning')`).run().lastInsertRowid);
    store.close();
    db.exec('DROP TABLE memory_metadata');
    db.pragma('user_version = 4');
    db.exec(`DROP TRIGGER facts_au;
      CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO facts_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
      END;`);
    store = new MemoryStore(dir);
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(marker()).toBe(epoch);
    vi.setSystemTime(new Date('2027-03-01'));
    expect((await sweepMemoryGc({ memoryDir: dir, force: true })).archived).toBe(0);
    expect(store.getFact(id)?.superseded_by).toBeNull();
  });

  it('waits the full 30 days for a tracked fact then archives recoverably', async () => {
    const id = fact();
    vi.setSystemTime(new Date('2027-01-31T00:00:00.000Z'));
    expect((await sweepMemoryGc({ memoryDir: dir, force: true })).archived).toBe(0);
    vi.setSystemTime(new Date('2027-02-01T00:00:00.000Z'));
    expect((await sweepMemoryGc({ memoryDir: dir, force: true })).archived).toBe(1);
    expect(store.getFact(id)?.content).toBe('tracking unique recall');
    expect(store.getFact(id)?.superseded_by).toBe(id);
    expect(store.searchFacts('unique')).toEqual([]);
    db.prepare('UPDATE facts SET superseded_by = NULL WHERE id = ?').run(id);
    expect(store.searchFacts('unique').map((row) => row.id)).toEqual([id]);
  });

  it.each(['missing', 'invalid', 'old-schema'])('skips safely with %s tracking metadata', async (state) => {
    fact();
    if (state === 'old-schema') db.exec('DROP TABLE memory_metadata');
    else if (state === 'missing') db.exec('DELETE FROM memory_metadata');
    else db.exec("UPDATE memory_metadata SET value = 'invalid'");
    expect(await sweepMemoryGc({ memoryDir: dir, force: true })).toMatchObject({
      skipped: true, skipReason: 'tracking-unknown', archived: 0,
    });
  });
});

describe('recall access accounting', () => {
  it('updates only returned IDs in one UPDATE without changing FTS ranking or rebuilding its index', () => {
    const first = fact('unique unique unique');
    fact('unique other words');
    const untouched = fact('different words');
    const ranked = () => db.prepare(`SELECT f.id, facts_fts.rank FROM facts f
      JOIN facts_fts ON facts_fts.rowid = f.id WHERE facts_fts MATCH 'unique' ORDER BY rank`).all();
    const before = ranked();
    const sql: string[] = [];
    const original = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, text: string) {
      sql.push(text);
      return original.call(this, text);
    });
    const trackingDb = (store as unknown as { db: Database.Database }).db;
    const totalChanges = () => (trackingDb.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const beforeChanges = totalChanges();
    store.searchFacts('unique', { limit: 1 });
    spy.mockRestore();
    expect(totalChanges() - beforeChanges).toBe(1); // No FTS trigger side effects.
    expect(sql.filter((text) => /UPDATE facts\s+SET access_count/.test(text))).toHaveLength(1);
    expect(ranked()).toEqual(before);
    expect(store.getFact(first)?.access_count).toBe(1);
    expect(store.getFact(untouched)?.access_count).toBe(0);
    // Content/category edits still synchronize the index.
    db.prepare('UPDATE facts SET content = ? WHERE id = ?').run('renamed', first);
    expect(store.searchFacts('renamed').map((row) => row.id)).toEqual([first]);
  });

  it('combined recall counts once; administrative reads and HOT.md do not count', () => {
    const id = fact();
    store.saveHot('Independent hot memory');
    store.loadHot();
    store.getFact(id);
    store.getAccessStats();
    store.getUnaccessed();
    expect(store.getFact(id)?.access_count).toBe(0);
    store.search('unique');
    expect(store.getFact(id)?.access_count).toBe(1);
  });

  it('preserves atomic increments across concurrent process searches', async () => {
    const id = fact();
    const moduleUrl = new URL('./memory-store.ts', import.meta.url).href;
    const script = `import { MemoryStore } from ${JSON.stringify(moduleUrl)};
      const store = new MemoryStore(${JSON.stringify(dir)});
      for (let i = 0; i < 10; i++) store.searchFacts('unique');
      store.close();`;
    await Promise.all([1, 2, 3].map(() => promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script])));
    expect(store.getFact(id)?.access_count).toBe(30);
    expect(store.getFact(id)?.last_accessed).not.toBeNull();
  }, 15000);
});

// ---------------------------------------------------------------------------
// Scope 1: canonical ISO guard in GC sweep
// ---------------------------------------------------------------------------

describe('GC sweep — canonical ISO guard rejects non-canonical tracking markers', () => {
  // Reject both unparseable values and parseable values that fail the
  // canonical ISO round trip, including normalized invalid calendar dates.
  it.each([
    ['parseable zero string (year-2000 in local TZ)', '0'],
    ['non-zero-padded date', '2027-1-1'],
    ['locale-style date string', '01 Jan 2027'],
    ['normalized invalid calendar date', '2027-02-30T00:00:00.000Z'],
    ['unix timestamp as string', '1735689600000'],
  ])('returns tracking-unknown for %s', async (_label, value) => {
    db.prepare('UPDATE memory_metadata SET value = ? WHERE key = ?')
      .run(value, 'tracking_started_at');
    const result = await sweepMemoryGc({ memoryDir: dir, force: true });
    expect(result).toMatchObject({ skipped: true, skipReason: 'tracking-unknown', archived: 0 });
  });

  it('does NOT archive an aged never-tracked row when marker is non-canonical', async () => {
    const id = fact();
    // Backdate so it would be eligible if the marker were canonical.
    db.prepare('UPDATE facts SET created_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', id);
    // Corrupt the marker to a parseable but non-canonical value.
    db.prepare('UPDATE memory_metadata SET value = ? WHERE key = ?')
      .run('0', 'tracking_started_at');
    const result = await sweepMemoryGc({ memoryDir: dir, force: true });
    expect(result).toMatchObject({ skipped: true, skipReason: 'tracking-unknown', archived: 0 });
    // Fact must be untouched — superseded_by stays NULL.
    const row = db.prepare('SELECT superseded_by FROM facts WHERE id = ?')
      .get(id) as { superseded_by: number | null };
    expect(row.superseded_by).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scope 2: migration seeds marker without relying on constructor
// ---------------------------------------------------------------------------

describe('runMigrations(db, 4) — v4→v5 seeds tracking_started_at', () => {
  it('seeds the marker inside the migration transaction (no constructor)', () => {
    // Build a v4 DB from scratch (fresh SCHEMA_SQL at v4 state — no metadata table).
    const migDir = mkdtempSync(join(tmpdir(), 'afk-migrate-v4-'));
    const migDb = new Database(join(migDir, 'memory.db'));
    try {
      migDb.exec(SCHEMA_SQL);
      // Drop the v5 additions to simulate a genuine v4 database.
      migDb.exec('DROP TABLE IF EXISTS memory_metadata');
      migDb.exec('DROP TRIGGER IF EXISTS facts_au');
      // Restore the v4-era trigger (fires on all UPDATE, not just content/category).
      migDb.exec(`CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO facts_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
      END;`);
      migDb.pragma('user_version = 4');

      // Fake timers are active from beforeEach — the seeded value must be epoch.
      runMigrations(migDb, 4);

      expect(migDb.pragma('user_version', { simple: true })).toBe(5);
      const row = migDb.prepare('SELECT value FROM memory_metadata WHERE key = ?')
        .get('tracking_started_at') as { value: string } | undefined;
      expect(row).toBeDefined();
      // Fake timer is set to epoch ('2027-01-01T00:00:00.000Z').
      expect(row!.value).toBe(epoch);
    } finally {
      migDb.close();
      rmSync(migDir, { recursive: true, force: true });
    }
  });

  it('preserves an existing marker on repeated stale-version migration (idempotent)', () => {
    // Simulate a v4 database that has already been migrated once (metadata table
    // exists with a value) but user_version was not bumped (e.g. crash mid-write).
    // Re-running runMigrations(db, 4) must not overwrite the existing marker.
    const migDir = mkdtempSync(join(tmpdir(), 'afk-migrate-idem-'));
    const migDb = new Database(join(migDir, 'memory.db'));
    try {
      migDb.exec(SCHEMA_SQL);
      // Simulate already-created metadata table with an existing marker (the
      // table was created by a prior partial run) but user_version still at 4.
      migDb.exec(`DELETE FROM memory_metadata`);
      migDb.prepare('INSERT INTO memory_metadata (key, value) VALUES (?, ?)')
        .run('tracking_started_at', epoch);
      migDb.exec('DROP TRIGGER IF EXISTS facts_au');
      migDb.exec(`CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO facts_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
      END;`);
      migDb.pragma('user_version = 4');

      // Advance fake time — migration must not overwrite the existing marker.
      vi.setSystemTime(new Date('2027-06-01T00:00:00.000Z'));
      runMigrations(migDb, 4);

      const row = migDb.prepare('SELECT value FROM memory_metadata WHERE key = ?')
        .get('tracking_started_at') as { value: string } | undefined;
      expect(row).toBeDefined();
      // INSERT OR IGNORE: the pre-existing epoch value must survive.
      expect(row!.value).toBe(epoch);
    } finally {
      migDb.close();
      rmSync(migDir, { recursive: true, force: true });
    }
  });
});
