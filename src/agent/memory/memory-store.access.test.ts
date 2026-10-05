/**
 * Unit tests for the access-pattern reporting helpers (memory-store.access.ts)
 * introduced in issue #1848, step 1.
 *
 * All tests use an isolated in-memory / temp-dir SQLite database so they
 * never touch the real ~/.afk/memory/memory.db.
 *
 * @module agent/memory/memory-store.access.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { MemoryStore } from './memory-store.js';
import type { AccessStats } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: MemoryStore;

/**
 * Backdate `created_at` for one or more fact rows via a direct SQL UPDATE so
 * that `getUnaccessed(N)` cutoff logic is deterministic regardless of
 * sub-millisecond timing jitter.  The store's own connection remains open;
 * better-sqlite3 in WAL mode allows concurrent readers, so we open a short-
 * lived second connection purely for the UPDATE and close it immediately.
 */
function backdateFacts(ids: number[], pastIso: string): void {
  const db = new Database(join(tmpDir, 'memory.db'));
  try {
    const stmt = db.prepare('UPDATE facts SET created_at = ? WHERE id = ?');
    for (const id of ids) stmt.run(pastIso, id);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `afk-mem-access-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  store = new MemoryStore(tmpDir);
});

afterEach(() => {
  store.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getAccessStats — empty archive
// ---------------------------------------------------------------------------

describe('getAccessStats — empty archive', () => {
  it('returns all-zero stats when no facts exist', () => {
    const stats: AccessStats = store.getAccessStats();
    expect(stats.total).toBe(0);
    expect(stats.neverAccessed).toBe(0);
    expect(stats.accessed).toBe(0);
    expect(stats.totalAccessEvents).toBe(0);
    expect(stats.maxAccessCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getAccessStats — populated archive
// ---------------------------------------------------------------------------

describe('getAccessStats — populated archive', () => {
  it('counts total, neverAccessed, and accessed correctly', () => {
    // Store two facts; search returns one of them (the other stays at 0).
    store.storeFact({ category: 'preference', content: 'uses pnpm', source_surface: 'test' });
    store.storeFact({ category: 'convention', content: 'strict TypeScript', source_surface: 'test' });

    // Search for 'pnpm' — should match fact 1 only.
    store.searchFacts('pnpm');

    const stats = store.getAccessStats();
    expect(stats.total).toBe(2);
    expect(stats.neverAccessed).toBe(1);
    expect(stats.accessed).toBe(1);
    expect(stats.totalAccessEvents).toBe(1); // one search hit
    expect(stats.maxAccessCount).toBe(1);
  });

  it('accumulates totalAccessEvents and maxAccessCount across multiple searches', () => {
    store.storeFact({ category: 'preference', content: 'uses pnpm for packages', source_surface: 'test' });

    store.searchFacts('pnpm');
    store.searchFacts('pnpm');
    store.searchFacts('packages');

    const stats = store.getAccessStats();
    expect(stats.total).toBe(1);
    expect(stats.neverAccessed).toBe(0);
    expect(stats.accessed).toBe(1);
    expect(stats.totalAccessEvents).toBe(3);
    expect(stats.maxAccessCount).toBe(3);
  });

  it('does not count superseded facts toward totals', () => {
    const id = store.storeFact({
      category: 'preference',
      content: 'original preference',
      source_surface: 'test',
    });
    // Supersede the fact — the old row should not appear in active stats.
    store.supersedeFact(id, 'updated preference');

    const stats = store.getAccessStats();
    // Only the new (non-superseded) fact counts.
    expect(stats.total).toBe(1);
    expect(stats.neverAccessed).toBe(1);
    expect(stats.totalAccessEvents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getUnaccessed — minAgeDays filter
// ---------------------------------------------------------------------------

describe('getUnaccessed — minAgeDays filter', () => {
  it('returns an empty array when no facts exist', () => {
    expect(store.getUnaccessed(0)).toEqual([]);
    expect(store.getUnaccessed(30)).toEqual([]);
  });

  it('returns a fact whose created_at is backdated past the cutoff when minAgeDays = 0', () => {
    // Backdate the fact 1 second into the past so the minAgeDays=0 cutoff
    // (computed as Date.now()) is guaranteed to be strictly after created_at.
    // This eliminates the sub-millisecond race where a fact stored "now" might
    // not yet satisfy created_at < cutoff depending on execution timing.
    const id = store.storeFact({
      category: 'learning',
      content: 'freshly stored fact',
      source_surface: 'test',
    });
    const oneSecondAgo = new Date(Date.now() - 1000).toISOString();
    backdateFacts([id], oneSecondAgo);

    const results = store.getUnaccessed(0);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(id);
  });

  it('excludes facts that have been accessed (access_count > 0)', () => {
    store.storeFact({
      category: 'preference',
      content: 'always use TypeScript',
      source_surface: 'test',
    });
    // Access the fact via search.
    store.searchFacts('TypeScript');

    // Even with minAgeDays = 0, an accessed fact must never appear.
    const unaccessed = store.getUnaccessed(0);
    expect(unaccessed).toHaveLength(0);
  });

  it('excludes superseded facts', () => {
    const id = store.storeFact({
      category: 'decision',
      content: 'old decision that got superseded',
      source_surface: 'test',
    });
    store.supersedeFact(id, 'revised decision');

    const unaccessed = store.getUnaccessed(0);
    // Only the new (non-superseded) fact could appear; the old one is excluded.
    const ids = unaccessed.map((f) => f.id);
    expect(ids).not.toContain(id);
  });

  it('returns facts ordered by created_at ascending (oldest first)', () => {
    // Store multiple facts, then backdate them with distinct timestamps spread
    // 1 second apart so the ORDER BY is deterministic regardless of wall-clock
    // resolution.  All three are backdated far enough in the past that
    // getUnaccessed(0) will include them.
    const idA = store.storeFact({ category: 'preference', content: 'fact alpha', source_surface: 'test' });
    const idB = store.storeFact({ category: 'preference', content: 'fact beta', source_surface: 'test' });
    const idC = store.storeFact({ category: 'preference', content: 'fact gamma', source_surface: 'test' });

    const base = Date.now() - 10_000; // 10 s ago
    backdateFacts([idA], new Date(base).toISOString());
    backdateFacts([idB], new Date(base + 1000).toISOString());
    backdateFacts([idC], new Date(base + 2000).toISOString());

    const unaccessed = store.getUnaccessed(0);
    expect(unaccessed).toHaveLength(3);
    const ids = unaccessed.map((f) => f.id);
    expect(ids).toEqual([idA, idB, idC]);
  });
});
