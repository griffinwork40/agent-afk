/**
 * Unit tests for the soft-delete GC sweep (memory-gc-sweep.ts).
 *
 * Issue #1848, step 2. All tests use isolated tmp-dir SQLite databases so
 * they never touch the real ~/.afk/state/memory/memory.db.
 *
 * @module agent/memory/memory-gc-sweep.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import BetterSqlite3 from 'better-sqlite3';
import { MemoryStore } from './memory-store.js';
import {
  sweepMemoryGc,
  MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
  GC_EXCLUDED_CATEGORIES,
} from './memory-gc-sweep.js';

// ---------------------------------------------------------------------------
// Test-local helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: MemoryStore;

/** Backdated ISO timestamp, `days` days ago. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Directly patch a fact's created_at via a sibling DB handle so it appears
 * old enough to be eligible for GC. MemoryStore doesn't expose a setter.
 */
function backdateFactSync(factId: number, createdAt: string): void {
  const db = new BetterSqlite3(join(tmpDir, 'memory.db'));
  db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(createdAt, factId);
  db.close();
}

/** Set access_count on a fact directly via a sibling DB handle. */
function setAccessCount(factId: number, count: number): void {
  const db = new BetterSqlite3(join(tmpDir, 'memory.db'));
  db.prepare('UPDATE facts SET access_count = ? WHERE id = ?').run(count, factId);
  db.close();
}

/** Read superseded_by for a fact directly. */
function readSupersededBy(factId: number): number | null {
  const db = new BetterSqlite3(join(tmpDir, 'memory.db'), { readonly: true });
  const row = db.prepare('SELECT superseded_by FROM facts WHERE id = ?').get(factId) as
    | { superseded_by: number | null }
    | undefined;
  db.close();
  return row?.superseded_by ?? null;
}

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `afk-mem-gc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  store = new MemoryStore(tmpDir);
  // Enable the GC sweep for most tests.
  vi.stubEnv('AFK_MEMORY_GC_SWEEP_ENABLE', '1');
});

afterEach(() => {
  store.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Disabled by default
// ---------------------------------------------------------------------------

describe('sweepMemoryGc — disabled by default', () => {
  it('returns skipped=true with skipReason=disabled when env var is not set', async () => {
    vi.stubEnv('AFK_MEMORY_GC_SWEEP_ENABLE', '');
    const result = await sweepMemoryGc({ memoryDir: tmpDir, force: true });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('disabled');
    expect(result.archived).toBe(0);
  });

  it('returns skipped=true when env var is 0', async () => {
    vi.stubEnv('AFK_MEMORY_GC_SWEEP_ENABLE', '0');
    const result = await sweepMemoryGc({ memoryDir: tmpDir, force: true });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('disabled');
  });

  it('runs when env var is 1', async () => {
    vi.stubEnv('AFK_MEMORY_GC_SWEEP_ENABLE', '1');
    const result = await sweepMemoryGc({ memoryDir: tmpDir, force: true });
    expect(result.skipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Eligibility selection
// ---------------------------------------------------------------------------

describe('sweepMemoryGc — eligibility: never-accessed + old enough', () => {
  it('archives a never-accessed fact older than minAgeDays', async () => {
    const id = store.storeFact({
      category: 'decision',
      content: 'We use PostgreSQL for the main DB.',
      source_surface: 'cli',
    });
    backdateFactSync(id, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 10));

    const result = await sweepMemoryGc({
      memoryDir: tmpDir,
      minAgeDays: MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
      force: true,
    });

    expect(result.skipped).toBe(false);
    expect(result.candidates).toBe(1);
    expect(result.archived).toBe(1);
  });

  it('does NOT archive a fact that was accessed (access_count > 0)', async () => {
    const id = store.storeFact({
      category: 'decision',
      content: 'We deploy with Docker.',
      source_surface: 'cli',
    });
    backdateFactSync(id, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 10));
    setAccessCount(id, 3);

    const result = await sweepMemoryGc({
      memoryDir: tmpDir,
      minAgeDays: MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
      force: true,
    });

    expect(result.candidates).toBe(0);
    expect(result.archived).toBe(0);
  });

  it('does NOT archive a fact younger than minAgeDays', async () => {
    store.storeFact({
      category: 'learning',
      content: 'Async generators are useful for streams.',
      source_surface: 'cli',
    });
    // No backdating — fact is brand new.

    const result = await sweepMemoryGc({
      memoryDir: tmpDir,
      minAgeDays: MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
      force: true,
    });

    expect(result.candidates).toBe(0);
    expect(result.archived).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Excluded categories
// ---------------------------------------------------------------------------

describe('sweepMemoryGc — excluded categories', () => {
  it('never archives preference facts', async () => {
    const id = store.storeFact({
      category: 'preference',
      content: 'I prefer dark mode.',
      source_surface: 'cli',
    });
    backdateFactSync(id, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 30));

    const result = await sweepMemoryGc({
      memoryDir: tmpDir,
      minAgeDays: MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
      force: true,
    });

    expect(result.candidates).toBe(0);
    expect(result.archived).toBe(0);
  });

  it('does archive convention / decision / learning facts that are eligible', async () => {
    const ids = [
      store.storeFact({ category: 'convention', content: 'Use kebab-case for filenames.', source_surface: 'cli' }),
      store.storeFact({ category: 'decision', content: 'We chose pnpm over npm.', source_surface: 'cli' }),
      store.storeFact({ category: 'learning', content: 'SQLite WAL mode improves concurrency.', source_surface: 'cli' }),
    ];
    for (const id of ids) {
      backdateFactSync(id, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 5));
    }

    const result = await sweepMemoryGc({
      memoryDir: tmpDir,
      minAgeDays: MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
      force: true,
    });

    expect(result.candidates).toBe(3);
    expect(result.archived).toBe(3);
  });

  it('GC_EXCLUDED_CATEGORIES includes "preference"', () => {
    expect(GC_EXCLUDED_CATEGORIES.has('preference')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Soft-delete semantics
// ---------------------------------------------------------------------------

describe('sweepMemoryGc — soft-delete: rows are recoverable', () => {
  it('sets superseded_by to the fact\'s own id (self-reference sentinel) on archived rows', async () => {
    const id = store.storeFact({
      category: 'convention',
      content: 'Use ESM for new modules.',
      source_surface: 'cli',
    });
    backdateFactSync(id, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 1));

    await sweepMemoryGc({
      memoryDir: tmpDir,
      minAgeDays: MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
      force: true,
    });

    // Soft-delete uses superseded_by = id (self-reference), not a negative sentinel.
    expect(readSupersededBy(id)).toBe(id);
  });

  it('archived facts are excluded from subsequent searches', async () => {
    const id = store.storeFact({
      category: 'convention',
      content: 'Use ESM for new modules unique99887.',
      source_surface: 'cli',
    });
    backdateFactSync(id, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 1));

    await sweepMemoryGc({
      memoryDir: tmpDir,
      minAgeDays: MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
      force: true,
    });

    // searchFacts already filters superseded_by IS NULL — sentinel qualifies.
    const results = store.searchFacts('ESM modules unique99887');
    expect(results).toHaveLength(0);
  });

  it('does not archive already-superseded facts', async () => {
    const id1 = store.storeFact({
      category: 'decision',
      content: 'Old decision about tooling.',
      source_surface: 'cli',
    });
    // Supersede the fact normally via MemoryStore.
    store.supersedeFact(id1, 'New decision about tooling.', 'decision');
    backdateFactSync(id1, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 1));

    const result = await sweepMemoryGc({
      memoryDir: tmpDir,
      minAgeDays: MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
      force: true,
    });

    // id1 has superseded_by != NULL so it must not be a candidate.
    expect(result.candidates).toBe(0);
    expect(result.archived).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Throttle (stamp file)
// ---------------------------------------------------------------------------

describe('sweepMemoryGc — throttle: at most once per interval', () => {
  it('skips when stamp is fresh (force=false)', async () => {
    // Write a stamp that looks recent.
    writeFileSync(join(tmpDir, '.last-gc-sweep'), new Date().toISOString());

    const result = await sweepMemoryGc({ memoryDir: tmpDir });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('too-soon');
  });

  it('runs when force=true even with a fresh stamp', async () => {
    writeFileSync(join(tmpDir, '.last-gc-sweep'), new Date().toISOString());

    const result = await sweepMemoryGc({ memoryDir: tmpDir, force: true });
    expect(result.skipped).toBe(false);
  });

  it('runs when no stamp exists', async () => {
    // No .last-gc-sweep file — sweep should run.
    const result = await sweepMemoryGc({ memoryDir: tmpDir, force: false });
    expect(result.skipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Never throws
// ---------------------------------------------------------------------------

describe('sweepMemoryGc — never throws', () => {
  it('returns a zero result when the DB does not exist (no-db)', async () => {
    const emptyDir = join(
      tmpdir(),
      `afk-mem-gc-nodb-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(emptyDir, { recursive: true });
    try {
      const result = await sweepMemoryGc({ memoryDir: emptyDir, force: true });
      // Must NOT throw; zero result or 'no-db' skip are both fine.
      expect(result.archived).toBe(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('does not throw on a missing / unreadable directory', async () => {
    await expect(
      sweepMemoryGc({
        memoryDir: join(tmpdir(), `afk-gc-nonexistent-${Date.now()}`),
        force: true,
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Mixed fact set — only eligible ones are swept
// ---------------------------------------------------------------------------

describe('sweepMemoryGc — mixed eligibility', () => {
  it('archives only the eligible subset out of a mixed fact set', async () => {
    // Fact A: old + never accessed + sweepable category → should be archived.
    const idA = store.storeFact({
      category: 'convention',
      content: 'Archive candidate A.',
      source_surface: 'cli',
    });
    backdateFactSync(idA, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 1));

    // Fact B: old + never accessed + preference → excluded.
    const idB = store.storeFact({
      category: 'preference',
      content: 'Dark mode preference.',
      source_surface: 'cli',
    });
    backdateFactSync(idB, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 1));

    // Fact C: young + never accessed + sweepable → too young.
    store.storeFact({
      category: 'decision',
      content: 'Recent decision, should stay.',
      source_surface: 'cli',
    });

    // Fact D: old + accessed + sweepable → has been accessed.
    const idD = store.storeFact({
      category: 'learning',
      content: 'Old but accessed learning fact.',
      source_surface: 'cli',
    });
    backdateFactSync(idD, daysAgo(MEMORY_GC_MIN_AGE_DAYS_DEFAULT + 1));
    setAccessCount(idD, 1);

    const result = await sweepMemoryGc({
      memoryDir: tmpDir,
      minAgeDays: MEMORY_GC_MIN_AGE_DAYS_DEFAULT,
      force: true,
    });

    expect(result.candidates).toBe(1);
    expect(result.archived).toBe(1);
  });
});
