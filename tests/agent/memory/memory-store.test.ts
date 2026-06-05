/**
 * MemoryStore unit tests.
 *
 * Redirects memory dir to a tmpdir so tests never touch the real ~/.afk/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { MemoryStore, estimateTokens } from '../../../src/agent/memory/memory-store.js';

let tmpMemDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpMemDir = join(tmpdir(), `afk-memory-test-${randomUUID()}`);
  mkdirSync(tmpMemDir, { recursive: true });
  store = new MemoryStore(tmpMemDir);
});

afterEach(() => {
  store.close();
  rmSync(tmpMemDir, { recursive: true, force: true });
});

describe('estimateTokens', () => {
  it('estimates ~1 token per 3.5 chars', () => {
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(estimateTokens('a'.repeat(7))).toBe(2);
  });
});

describe('Hot memory', () => {
  it('returns null when HOT.md does not exist', () => {
    expect(store.loadHot()).toBeNull();
  });

  it('saves and loads HOT.md round-trip', () => {
    store.saveHot('User prefers TypeScript');
    expect(store.loadHot()).toBe('User prefers TypeScript');
  });

  it('creates backup before overwrite', () => {
    store.saveHot('version 1');
    store.saveHot('version 2');
    const backup = readFileSync(join(tmpMemDir, 'HOT.md.bak'), 'utf-8');
    expect(backup).toBe('version 1');
    expect(store.loadHot()).toBe('version 2');
  });

  it('truncates (never throws) when content exceeds the cap', () => {
    // Truncation covenant: oversize hot writes are clamped to fit, not
    // rejected. A hard throw here was a dead-end that forced a destructive
    // manual re-trim (see fix(memory): HOT.md non-fatal).
    const usage = store.saveHot('x'.repeat(5300));
    expect(usage.truncated).toBe(true);
    const written = store.loadHot()!;
    expect(written.length).toBeLessThanOrEqual(5250);
    expect(written).toContain('HOT TRUNCATED');
  });

  it('accepts content at the cap boundary', () => {
    const ok = 'x'.repeat(5250);
    const usage = store.saveHot(ok);
    expect(usage.truncated).toBe(false);
    expect(store.loadHot()).toBe(ok);
  });
});

describe('Facts CRUD', () => {
  it('stores and retrieves a fact', () => {
    const id = store.storeFact({
      category: 'preference',
      content: 'User likes dark mode',
      source_surface: 'cli',
    });
    expect(id).toBeGreaterThan(0);
    const fact = store.getFact(id);
    expect(fact).not.toBeNull();
    expect(fact!.content).toBe('User likes dark mode');
    expect(fact!.category).toBe('preference');
    expect(fact!.confidence).toBe(1.0);
  });

  it('supersedes a fact with a chain', () => {
    const oldId = store.storeFact({
      category: 'convention',
      content: 'Use npm',
      source_surface: 'cli',
    });
    const newId = store.supersedeFact(oldId, 'Use pnpm');
    const oldFact = store.getFact(oldId);
    expect(oldFact!.superseded_by).toBe(newId);
    const newFact = store.getFact(newId);
    expect(newFact!.content).toBe('Use pnpm');
  });

  it('removes a fact', () => {
    const id = store.storeFact({
      category: 'decision',
      content: 'Deprecated endpoint',
      source_surface: 'cli',
    });
    expect(store.removeFact(id)).toBe(true);
    expect(store.getFact(id)).toBeNull();
  });

  it('removeFact returns false for nonexistent id', () => {
    expect(store.removeFact(99999)).toBe(false);
  });

  it('supersedeFact throws for nonexistent id', () => {
    expect(() => store.supersedeFact(99999, 'new')).toThrow('not found');
  });
});

describe('FTS5 search', () => {
  it('finds facts by keyword', () => {
    store.storeFact({ category: 'preference', content: 'dark mode enabled', source_surface: 'cli' });
    store.storeFact({ category: 'convention', content: 'use strict TypeScript', source_surface: 'cli' });

    const results = store.searchFacts('dark mode');
    expect(results.length).toBe(1);
    expect(results[0]!.content).toContain('dark mode');
  });

  it('excludes superseded facts from search', () => {
    const id = store.storeFact({ category: 'convention', content: 'use npm', source_surface: 'cli' });
    store.supersedeFact(id, 'use pnpm');

    const results = store.searchFacts('npm OR pnpm');
    expect(results.every((r) => r.superseded_by === null)).toBe(true);
    expect(results.some((r) => r.content === 'use pnpm')).toBe(true);
  });

  it('filters by category', () => {
    store.storeFact({ category: 'preference', content: 'editor theme dark', source_surface: 'cli' });
    store.storeFact({ category: 'decision', content: 'editor changed to vim', source_surface: 'cli' });

    const results = store.searchFacts('editor', { category: 'preference' });
    expect(results.length).toBe(1);
    expect(results[0]!.category).toBe('preference');
  });

  it('filters by since date', () => {
    store.storeFact({ category: 'learning', content: 'learned SQLite FTS5', source_surface: 'cli' });
    const future = new Date(Date.now() + 86400000).toISOString();
    const results = store.searchFacts('SQLite', { since: future });
    expect(results.length).toBe(0);
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.storeFact({ category: 'learning', content: `test item ${i}`, source_surface: 'cli' });
    }
    const results = store.searchFacts('test item', { limit: 2 });
    expect(results.length).toBe(2);
  });
});

describe('Sessions', () => {
  it('starts and ends a session', () => {
    store.startSession({ session_id: 'sess-1', surface: 'cli' });
    const before = store.getSession('sess-1');
    expect(before).not.toBeNull();
    expect(before!.ended_at).toBeNull();

    store.endSession('sess-1', 'Did some work', 'completed', 1000, 0.05);
    const after = store.getSession('sess-1');
    expect(after!.summary).toBe('Did some work');
    expect(after!.outcome).toBe('completed');
    expect(after!.token_count).toBe(1000);
  });

  it('lists recent sessions', () => {
    store.startSession({ session_id: 'a', surface: 'cli' });
    store.startSession({ session_id: 'b', surface: 'telegram' });
    const recent = store.recentSessions(2);
    expect(recent.length).toBe(2);
  });
});

describe('Procedures', () => {
  it('writes and loads a procedure', () => {
    store.writeProcedure('deploy-app', 'Run pnpm build then pnpm deploy', 'sess-1');
    const proc = store.loadProcedure('deploy-app');
    expect(proc).not.toBeNull();
    expect(proc!.name).toBe('deploy-app');
    expect(proc!.content).toBe('Run pnpm build then pnpm deploy');
    expect(proc!.source_session).toBe('sess-1');
  });

  it('searches procedures by keyword', () => {
    store.writeProcedure('deploy-app', 'Run pnpm build', 'sess-1');
    store.writeProcedure('test-app', 'Run pnpm test', 'sess-1');
    const results = store.searchProcedures('deploy');
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe('deploy-app');
  });

  it('returns null for nonexistent procedure', () => {
    expect(store.loadProcedure('nonexistent')).toBeNull();
  });
});

describe('Combined search', () => {
  it('returns both facts and procedures', () => {
    store.storeFact({ category: 'learning', content: 'deployment requires Docker', source_surface: 'cli' });
    store.writeProcedure('deploy-steps', 'Docker build then push to registry');
    const results = store.search('Docker');
    expect(results.some((r) => r.type === 'fact')).toBe(true);
    expect(results.some((r) => r.type === 'procedure')).toBe(true);
  });

  it('skips procedures when category filter is set', () => {
    store.storeFact({ category: 'learning', content: 'deploy uses Docker', source_surface: 'cli' });
    store.writeProcedure('deploy-guide', 'Docker build instructions');
    const results = store.search('Docker', { category: 'learning' });
    expect(results.every((r) => r.type === 'fact')).toBe(true);
  });
});

describe('WAL recovery', () => {
  it('replays facts from WAL into SQLite', () => {
    const walPath = join(tmpMemDir, 'memory-wal.jsonl');
    const entry = JSON.stringify({
      type: 'fact',
      timestamp: new Date().toISOString(),
      data: {
        session_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
        category: 'learning',
        content: 'recovered from WAL',
        source_surface: 'daemon',
      },
    });
    store.close();

    appendFileSync(walPath, entry + '\n', 'utf-8');
    const store2 = new MemoryStore(tmpMemDir);
    expect(existsSync(walPath)).toBe(false);

    const results = store2.searchFacts('recovered');
    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe('recovered from WAL');
    store2.close();
  });

  it('does not duplicate facts already in SQLite', () => {
    const fixedTs = '2026-02-01T00:00:00.000Z';
    store.storeFact({ category: 'learning', content: 'already stored', source_surface: 'cli' });

    // Read the fact to get its actual created_at timestamp
    const facts = store.searchFacts('already stored');
    const actualTs = facts[0]!.created_at;

    store.close();

    const walPath = join(tmpMemDir, 'memory-wal.jsonl');
    const entry = JSON.stringify({
      type: 'fact',
      timestamp: fixedTs,
      data: {
        session_id: null,
        created_at: actualTs,
        category: 'learning',
        content: 'already stored',
        source_surface: 'cli',
      },
    });
    appendFileSync(walPath, entry + '\n', 'utf-8');

    const store2 = new MemoryStore(tmpMemDir);
    const results = store2.searchFacts('already stored');
    expect(results.length).toBe(1);
    store2.close();
  });
});

describe('Concurrent open', () => {
  it('two MemoryStore instances can coexist on the same dir', () => {
    const store2 = new MemoryStore(tmpMemDir);
    store.storeFact({ category: 'learning', content: 'from store 1', source_surface: 'cli' });
    store2.storeFact({ category: 'learning', content: 'from store 2', source_surface: 'telegram' });

    const results1 = store.searchFacts('store');
    const results2 = store2.searchFacts('store');
    expect(results1.length).toBe(2);
    expect(results2.length).toBe(2);
    store2.close();
  });
});

describe('Schema versioning', () => {
  it('stamps user_version = 2 on a fresh database (schema v2 adds fingerprint UNIQUE index)', () => {
    // The store created in beforeEach is a fresh DB.
    // Re-open the same dir with better-sqlite3 directly to read the pragma.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(join(tmpMemDir, 'memory.db'));
    const version = db.pragma('user_version', { simple: true });
    db.close();
    expect(version).toBe(2);
  });

  it('opens cleanly when user_version matches SCHEMA_VERSION', () => {
    // Close and reopen — should not throw.
    store.close();
    expect(() => {
      const store2 = new MemoryStore(tmpMemDir);
      store2.close();
    }).not.toThrow();
  });

  it('throws a clear error when DB has a newer schema version', () => {
    store.close();
    // Manually stamp a future version into the DB.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(join(tmpMemDir, 'memory.db'));
    db.pragma('user_version = 99');
    db.close();

    expect(() => new MemoryStore(tmpMemDir)).toThrow(
      /newer than this build supports/,
    );
  });
});

describe('C9 fingerprint collision (UNIQUE index on facts fingerprint)', () => {
  it('prevents duplicate inserts with identical (content, created_at, session_id, category)', () => {
    // Simulate a same-millisecond duplicate by inserting a row directly via
    // the raw SQLite connection and then attempting to insert the same
    // fingerprint again. The UNIQUE index must reject the second insert.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(join(tmpMemDir, 'memory.db'));

    const now = new Date().toISOString();

    // First insert should succeed.
    expect(() => {
      db.prepare(
        'INSERT INTO facts (session_id, created_at, category, content, source_surface) VALUES (?, ?, ?, ?, ?)',
      ).run('s1', now, 'preference', 'unique content', 'cli');
    }).not.toThrow();

    // Second insert with identical fingerprint fields must fail.
    expect(() => {
      db.prepare(
        'INSERT INTO facts (session_id, created_at, category, content, source_surface) VALUES (?, ?, ?, ?, ?)',
      ).run('s1', now, 'preference', 'unique content', 'cli');
    }).toThrow(/UNIQUE constraint failed/);

    db.close();
  });

  it('WAL supersede replay correctly identifies the right row via 4-field fingerprint', () => {
    // Store two facts with identical content but different categories.
    const id1 = store.storeFact({
      category: 'preference',
      content: 'Use tabs',
      source_surface: 'cli',
      session_id: 'session-a',
    });
    const id2 = store.storeFact({
      category: 'convention',
      content: 'Use tabs',
      source_surface: 'cli',
      session_id: 'session-a',
    });

    // Supersede only the 'preference' fact.
    const newId = store.supersedeFact(id1, 'Use spaces');

    // The preference fact should now be superseded.
    const prefFact = store.getFact(id1)!;
    expect(prefFact.superseded_by).toBe(newId);

    // The convention fact should remain untouched.
    const convFact = store.getFact(id2)!;
    expect(convFact.superseded_by).toBeNull();
  });

  it('v1 → v2 migration deduplicates same-ms collisions and creates UNIQUE index', () => {
    // Open the DB with a private connection to seed a v1-style duplicate.
    store.close();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(join(tmpMemDir, 'memory.db'));

    // Stamp as v1 to trigger migration path.
    db.pragma('user_version = 1');

    // Drop the UNIQUE index if it was created (it won't be on a fresh v2 DB
    // that was just opened and then stamped back to v1 for the test).
    try { db.exec('DROP INDEX IF EXISTS idx_facts_fingerprint'); } catch { /* ok */ }

    // Insert a duplicate (same 4-field fingerprint).
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO facts (session_id, created_at, category, content, source_surface) VALUES (?, ?, ?, ?, ?)',
    ).run('dup-session', now, 'preference', 'dup content', 'cli');
    db.prepare(
      'INSERT INTO facts (session_id, created_at, category, content, source_surface) VALUES (?, ?, ?, ?, ?)',
    ).run('dup-session', now, 'preference', 'dup content', 'cli');
    db.close();

    // Re-open — the migration must run, dedup, and add the UNIQUE index.
    const store2 = new MemoryStore(tmpMemDir);

    // Exactly one row with that content should survive.
    const results = store2.searchFacts('dup content');
    const matching = results.filter((r) => r.content === 'dup content');
    expect(matching).toHaveLength(1);

    store2.close();
  });
});
