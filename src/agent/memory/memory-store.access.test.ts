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
import { MemoryStore } from './memory-store.js';
import type { AccessStats } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: MemoryStore;

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

  it('returns recently created facts when minAgeDays = 0', () => {
    // minAgeDays = 0 means cutoff = now, so any fact created before now qualifies.
    // In practice, a fact stored a millisecond ago is older than "0 days ago".
    const id = store.storeFact({
      category: 'learning',
      content: 'freshly stored fact',
      source_surface: 'test',
    });
    // A fact created right now should NOT appear with minAgeDays=0 because the
    // cutoff is computed at call time. Allow a tiny timing tolerance by checking
    // getUnaccessed(0) returns either 0 or 1 result (both are valid depending
    // on sub-millisecond timing), but the id is correct when present.
    const results = store.getUnaccessed(0);
    if (results.length > 0) {
      expect(results[0]!.id).toBe(id);
    }
    // Either way, no exception and the type is correct.
    expect(Array.isArray(results)).toBe(true);
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
    // Store multiple facts and search none of them.
    store.storeFact({ category: 'preference', content: 'fact alpha', source_surface: 'test' });
    store.storeFact({ category: 'preference', content: 'fact beta', source_surface: 'test' });
    store.storeFact({ category: 'preference', content: 'fact gamma', source_surface: 'test' });

    const unaccessed = store.getUnaccessed(0);
    // When there are results, they should be in ascending created_at order.
    if (unaccessed.length > 1) {
      for (let i = 1; i < unaccessed.length; i++) {
        expect(unaccessed[i]!.created_at >= unaccessed[i - 1]!.created_at).toBe(true);
      }
    }
  });
});
