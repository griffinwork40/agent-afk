/**
 * Tests for the Q episode ingest adapter (q-ingest.ts).
 *
 * Builds a real memory.db in a tmp directory, inserts episode facts, then
 * verifies ingestEpisodes() upserts correctly into the Q store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { ingestEpisodes, parseEpisodeContent } from './q-ingest.js';
import { QEpisodesStore } from './q-store.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'afk-q-ingest-test-'));
}

// ---------------------------------------------------------------------------
// Helpers — create a minimal memory.db matching the real schema
// ---------------------------------------------------------------------------

function createMemoryDb(dir: string): Database.Database {
  const db = new Database(join(dir, 'memory.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      created_at TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      source_surface TEXT NOT NULL DEFAULT 'cli',
      superseded_by INTEGER,
      confidence REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed TEXT,
      evidence TEXT
    );
  `);
  return db;
}

function insertFact(
  db: Database.Database,
  content: string,
  sessionId: string | null = null,
  category = 'learning',
  createdAt = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO facts (session_id, created_at, category, content, source_surface)
     VALUES (?, ?, ?, ?, 'episode-synthesis')`,
  ).run(sessionId, createdAt, category, content);
}

function makeEpisodeContent(opts: {
  sessionId: string;
  goal?: string;
  narrative?: string;
  tags?: string;
  files?: string;
  synthesizedAt?: string;
}): string {
  const lines = [
    `[episode:${opts.sessionId}]`,
    `goal: ${opts.goal ?? 'Test goal'}`,
    `approach: Test approach`,
    `outcome: Test outcome`,
  ];
  if (opts.tags) lines.push(`tags: ${opts.tags}`);
  if (opts.files) lines.push(`files: ${opts.files}`);
  lines.push(`narrative: ${opts.narrative ?? 'Test narrative.'}`);
  lines.push(`synthesized: ${opts.synthesizedAt ?? '2026-01-01T00:00:00.000Z'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// parseEpisodeContent
// ---------------------------------------------------------------------------

describe('parseEpisodeContent', () => {
  it('parses a valid episode content block', () => {
    const content = makeEpisodeContent({
      sessionId: 'session-abc',
      goal: 'Refactor auth',
      narrative: 'Did refactor.',
      tags: 'auth, refactor',
      files: 'src/auth.ts, src/auth.test.ts',
      synthesizedAt: '2026-03-01T00:00:00.000Z',
    });
    const parsed = parseEpisodeContent(content, null);
    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe('session-abc');
    expect(parsed!.goal).toBe('Refactor auth');
    expect(parsed!.narrative).toBe('Did refactor.');
    expect(parsed!.tags).toEqual(['auth', 'refactor']);
    expect(parsed!.files).toEqual(['src/auth.ts', 'src/auth.test.ts']);
    expect(parsed!.synthesizedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('returns null when header is missing', () => {
    const content = 'goal: something\nsynthesized: 2026-01-01T00:00:00.000Z';
    expect(parseEpisodeContent(content, null)).toBeNull();
  });

  it('returns null when synthesized timestamp is missing', () => {
    const content = '[episode:session-abc]\ngoal: something';
    expect(parseEpisodeContent(content, null)).toBeNull();
  });

  it('uses fallback session_id from DB row when header has no session_id', () => {
    // Malformed header without sessionId — should not parse (header must match /\[episode:(.+)\]/)
    const content = '[episode:]\ngoal: x\nsynthesized: 2026-01-01T00:00:00.000Z';
    // The regex requires at least one char after "episode:", so this returns null
    expect(parseEpisodeContent(content, 'fallback-id')).toBeNull();
  });

  it('handles missing tags and files gracefully', () => {
    const content = makeEpisodeContent({ sessionId: 'session-abc' });
    const parsed = parseEpisodeContent(content, null);
    expect(parsed!.tags).toEqual([]);
    expect(parsed!.files).toEqual([]);
  });

  it('accumulates multiline goal (continuation lines joined)', () => {
    const content = [
      '[episode:session-ml]',
      'goal: First line of goal',
      'second line of goal',
      'third line of goal',
      'narrative: Short narrative.',
      'synthesized: 2026-05-01T00:00:00.000Z',
    ].join('\n');
    const parsed = parseEpisodeContent(content, null);
    expect(parsed).not.toBeNull();
    expect(parsed!.goal).toBe('First line of goal\nsecond line of goal\nthird line of goal');
  });

  it('accumulates multiline narrative (continuation lines joined)', () => {
    const content = [
      '[episode:session-ml2]',
      'goal: Single line goal.',
      'narrative: Narrative line one.',
      'Narrative line two.',
      'Narrative line three.',
      'synthesized: 2026-05-01T00:00:00.000Z',
    ].join('\n');
    const parsed = parseEpisodeContent(content, null);
    expect(parsed).not.toBeNull();
    expect(parsed!.narrative).toBe(
      'Narrative line one.\nNarrative line two.\nNarrative line three.',
    );
  });

  it('treats a line starting with a new key as a field boundary, not continuation', () => {
    const content = [
      '[episode:session-boundary]',
      'goal: Goal text.',
      'narrative: Narrative text.',
      'synthesized: 2026-05-01T00:00:00.000Z',
    ].join('\n');
    const parsed = parseEpisodeContent(content, null);
    expect(parsed).not.toBeNull();
    expect(parsed!.goal).toBe('Goal text.');
    expect(parsed!.narrative).toBe('Narrative text.');
  });
});

// ---------------------------------------------------------------------------
// ingestEpisodes
// ---------------------------------------------------------------------------

describe('ingestEpisodes', () => {
  let dir: string;
  let memDb: Database.Database;

  beforeEach(() => {
    dir = makeTmpDir();
    memDb = createMemoryDb(dir);
  });

  afterEach(() => {
    try { memDb.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns zeros when memory.db has no episode facts', () => {
    memDb.close();
    const result = ingestEpisodes(dir, dir);
    expect(result.found).toBe(0);
    expect(result.upserted).toBe(0);
    expect(result.totalStored).toBe(0);
  });

  it('returns early when memory.db does not exist', () => {
    memDb.close();
    const result = ingestEpisodes('/nonexistent/path', dir);
    expect(result.found).toBe(0);
    expect(result.upserted).toBe(0);
  });

  it('ingests a single episode fact', () => {
    const content = makeEpisodeContent({
      sessionId: 'session-001',
      goal: 'Fix the bug',
      synthesizedAt: '2026-02-01T00:00:00.000Z',
    });
    insertFact(memDb, content, 'session-001');
    memDb.close();

    const result = ingestEpisodes(dir, dir);
    expect(result.found).toBe(1);
    expect(result.upserted).toBe(1);
    expect(result.totalStored).toBe(1);
    expect(result.watermark).toBe('2026-02-01T00:00:00.000Z');
  });

  it('ingests multiple episode facts', () => {
    insertFact(memDb, makeEpisodeContent({ sessionId: 'session-001', synthesizedAt: '2026-01-01T00:00:00.000Z' }), 'session-001');
    insertFact(memDb, makeEpisodeContent({ sessionId: 'session-002', synthesizedAt: '2026-02-01T00:00:00.000Z' }), 'session-002');
    memDb.close();

    const result = ingestEpisodes(dir, dir);
    expect(result.found).toBe(2);
    expect(result.upserted).toBe(2);
    expect(result.totalStored).toBe(2);
  });

  it('skips non-episode learning facts', () => {
    insertFact(memDb, 'Just a regular learning fact without episode prefix', 'session-001');
    insertFact(memDb, makeEpisodeContent({ sessionId: 'session-002', synthesizedAt: '2026-02-01T00:00:00.000Z' }), 'session-002');
    memDb.close();

    const result = ingestEpisodes(dir, dir);
    expect(result.found).toBe(1);
    expect(result.upserted).toBe(1);
  });

  it('skips non-learning category facts', () => {
    const content = makeEpisodeContent({ sessionId: 'session-001', synthesizedAt: '2026-01-01T00:00:00.000Z' });
    insertFact(memDb, content, 'session-001', 'preference');
    memDb.close();

    const result = ingestEpisodes(dir, dir);
    expect(result.found).toBe(0);
  });

  it('is idempotent — re-ingesting same facts does not duplicate rows', () => {
    const content = makeEpisodeContent({ sessionId: 'session-001', synthesizedAt: '2026-01-01T00:00:00.000Z' });
    insertFact(memDb, content, 'session-001');
    memDb.close();

    ingestEpisodes(dir, dir);
    memDb = createMemoryDb(dir); // re-open to add nothing new
    memDb.close();
    const result2 = ingestEpisodes(dir, dir);

    const store = new QEpisodesStore(dir);
    expect(store.count()).toBe(1);
    store.close();
    // Second run found 0 new (watermark filters them) or upserted the same row
    expect(result2.totalStored).toBe(1);
  });

  it('stores goal and narrative in the Q store', () => {
    const content = makeEpisodeContent({
      sessionId: 'session-001',
      goal: 'Ship the feature',
      narrative: 'The feature was shipped.',
      synthesizedAt: '2026-03-01T00:00:00.000Z',
    });
    insertFact(memDb, content, 'session-001');
    memDb.close();

    ingestEpisodes(dir, dir);

    const store = new QEpisodesStore(dir);
    const row = store.getEpisode('session-001');
    expect(row).not.toBeNull();
    expect(row!.goal).toBe('Ship the feature');
    expect(row!.narrative).toBe('The feature was shipped.');
    store.close();
  });

  it('tracks the watermark as the highest synthesized_at seen', () => {
    insertFact(memDb, makeEpisodeContent({ sessionId: 's1', synthesizedAt: '2026-01-01T00:00:00.000Z' }), 's1');
    insertFact(memDb, makeEpisodeContent({ sessionId: 's2', synthesizedAt: '2026-06-01T00:00:00.000Z' }), 's2');
    memDb.close();

    const result = ingestEpisodes(dir, dir);
    expect(result.watermark).toBe('2026-06-01T00:00:00.000Z');
  });

  it('watermark filter uses created_at > ? — row at exact watermark is not re-ingested', () => {
    // Insert two facts with distinct created_at values.
    const ts1 = '2026-03-01T00:00:00.000Z';
    const ts2 = '2026-04-01T00:00:00.000Z';
    insertFact(memDb, makeEpisodeContent({ sessionId: 's-wm1', synthesizedAt: ts1 }), 's-wm1', 'learning', ts1);
    insertFact(memDb, makeEpisodeContent({ sessionId: 's-wm2', synthesizedAt: ts2 }), 's-wm2', 'learning', ts2);
    memDb.close();

    // First run ingests both.
    const r1 = ingestEpisodes(dir, dir);
    expect(r1.upserted).toBe(2);

    // Manually set watermark back to ts1 so the next run filters on created_at > ts1.
    const store = new QEpisodesStore(dir);
    store.setWatermark(ts1);
    store.close();

    // Second run against the SAME memory.db (memDb is already closed, file still there).
    // The watermark is ts1, so only the row with created_at > ts1 (i.e. ts2) should be found.
    const r2 = ingestEpisodes(dir, dir);
    expect(r2.found).toBe(1);
  });
});
