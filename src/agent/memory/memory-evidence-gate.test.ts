/**
 * Tests for the evidence gate on durable memory writes
 * (AFK_MEMORY_EVIDENCE_GATE — opt-in, prototype).
 *
 * Pins the contract from the four scoped acceptance criteria:
 *   1. a citable codebase fact (convention) WITH evidence → recalled verified
 *   2. a codebase fact WITHOUT evidence → recalled as [unverified]
 *   3. a user preference does NOT require file evidence (never gated)
 *   4. an agent reflection (learning) is NOT treated as factual codebase knowledge
 * plus two safety properties:
 *   - gate OFF is a byte-identical no-op (no provenance fields, no warnings)
 *   - the v3→v4 schema migration adds facts.evidence to a pre-existing DB
 *     without data loss
 *
 * @module agent/memory/memory-evidence-gate.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { MemoryStore } from './memory-store.js';
import { createMemoryHandlers } from './memory-tools.js';
import type { ToolHandler } from '../tools/types.js';
import type { MemorySearchResult } from './types.js';

let tmpDir: string;
let store: MemoryStore;
let update: ToolHandler;
let search: ToolHandler;

const signal = new AbortController().signal;

function freshTmpDir(label: string): string {
  return join(tmpdir(), `afk-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

beforeEach(() => {
  tmpDir = freshTmpDir('evidence-gate');
  mkdirSync(tmpDir, { recursive: true });
  store = new MemoryStore(tmpDir);
  const handlers = createMemoryHandlers(store, 'sess-1', 'test');
  update = handlers.get('memory_update')!;
  search = handlers.get('memory_search')!;
  // Gate ON by default; individual gate-off cases delete it mid-test.
  process.env['AFK_MEMORY_EVIDENCE_GATE'] = '1';
});

afterEach(() => {
  delete process.env['AFK_MEMORY_EVIDENCE_GATE'];
  store.close();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

async function setFact(
  category: string,
  content: string,
  evidence?: string,
): Promise<Record<string, unknown>> {
  const input: Record<string, unknown> = { target: 'fact', action: 'set', category, content };
  if (evidence !== undefined) input['evidence'] = evidence;
  const res = await update(input, signal);
  expect(res.isError).toBeFalsy();
  return JSON.parse(res.content) as Record<string, unknown>;
}

async function recallOne(query: string): Promise<MemorySearchResult> {
  const res = await search({ query }, signal);
  expect(res.isError).toBeFalsy();
  const results = JSON.parse(res.content) as MemorySearchResult[];
  const fact = results.find((r) => r.type === 'fact');
  expect(fact, `expected a fact result for query "${query}"`).toBeDefined();
  return fact!;
}

describe('memory evidence gate (AFK_MEMORY_EVIDENCE_GATE=1)', () => {
  it('1. a citable codebase fact (convention) with evidence is stored and recalled as verified', async () => {
    const out = await setFact(
      'convention',
      'zorptest the dispatcher routes via providerForModel',
      'src/agent/providers/index.ts:124',
    );
    expect(out['warning'], 'a cited fact must not warn').toBeUndefined();

    const fact = await recallOne('zorptest');
    expect(fact.verification).toBe('verified');
    expect(fact.evidence).toBe('src/agent/providers/index.ts:124');
    expect(fact.content).not.toContain('[unverified]');
  });

  it('2. a codebase fact without evidence is recalled as [unverified] (and warns on write)', async () => {
    const out = await setFact('convention', 'wibblegate the foo module owns bar');
    expect(out['warning'], 'an uncited codebase fact must warn').toBeDefined();
    expect(out['warning'] as string).toContain('[unverified]');
    // Not a hard reject — the fact is still stored.
    expect(out['id']).toBeTypeOf('number');

    const fact = await recallOne('wibblegate');
    expect(fact.verification).toBe('unverified');
    expect(fact.content.startsWith('[unverified]')).toBe(true);
    expect(fact.evidence ?? null).toBeNull();
  });

  it('3. a user preference does not require file evidence (no warning, never gated)', async () => {
    const out = await setFact('preference', 'flooberpref the user prefers pnpm over npm');
    expect(out['warning'], 'preferences must never warn').toBeUndefined();

    const fact = await recallOne('flooberpref');
    expect(fact.verification).toBe('not-applicable');
    expect(fact.content).not.toContain('[unverified]');
  });

  it('4. an agent reflection (learning) is not treated as factual codebase knowledge', async () => {
    const out = await setFact('learning', 'grumblelesson parallel subagents cut context bloat');
    expect(out['warning'], 'reflections must never warn').toBeUndefined();

    const fact = await recallOne('grumblelesson');
    // Never 'verified' (no false factual authority) and never 'unverified'
    // (it is not a codebase claim to be checked) — simply not-applicable.
    expect(fact.verification).toBe('not-applicable');
    expect(fact.content).not.toContain('[unverified]');
  });

  it('decision is treated as rationale, not a gated codebase fact', async () => {
    const out = await setFact('decision', 'snibbledecide chose Exa over Brave for search');
    expect(out['warning']).toBeUndefined();
    const fact = await recallOne('snibbledecide');
    expect(fact.verification).toBe('not-applicable');
  });
});

describe('memory evidence gate — OFF is a byte-identical no-op', () => {
  it('recall output carries no provenance fields when the gate is off', async () => {
    // Stored while ON (so evidence is persisted)...
    await setFact('convention', 'plonkoff the baz layer', 'src/x.ts:1');
    // ...recalled while OFF.
    delete process.env['AFK_MEMORY_EVIDENCE_GATE'];

    const res = await search({ query: 'plonkoff' }, signal);
    const fact = (JSON.parse(res.content) as MemorySearchResult[]).find((r) => r.type === 'fact')!;
    expect(fact).toBeDefined();
    expect('verification' in fact).toBe(false);
    expect('evidence' in fact).toBe(false);
    expect(fact.content).not.toContain('[unverified]');
  });

  it('an uncited codebase fact write returns no warning when the gate is off', async () => {
    delete process.env['AFK_MEMORY_EVIDENCE_GATE'];
    const out = await setFact('convention', 'snorgleoff a thing with no citation');
    expect(out['warning']).toBeUndefined();
    expect(out['id']).toBeTypeOf('number');
  });
});

describe('memory evidence gate — schema migration v3 → v4', () => {
  it('a fresh store is at schema v4 with a facts.evidence column', () => {
    const dir = freshTmpDir('evidence-fresh');
    mkdirSync(dir, { recursive: true });
    const s = new MemoryStore(dir);
    try {
      const id = s.storeFact({
        category: 'convention',
        content: 'freshschema cited fact',
        source_surface: 'cli',
        evidence: 'src/a.ts:1',
      });
      expect(s.getFact(id)!.evidence).toBe('src/a.ts:1');
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a pre-existing v3 database forward without data loss', () => {
    const dir = freshTmpDir('evidence-migrate');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'memory.db');

    // Build a v3-shaped DB by hand: facts table WITHOUT the evidence column,
    // plus the FTS mirror + triggers a real v3 DB carries, stamped user_version=3.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('preference', 'convention', 'decision', 'learning')),
        content TEXT NOT NULL,
        source_surface TEXT NOT NULL DEFAULT 'cli',
        superseded_by INTEGER REFERENCES facts(id),
        confidence REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed TEXT
      );
      CREATE VIRTUAL TABLE facts_fts USING fts5(
        content, category, content=facts, content_rowid=id, tokenize='porter'
      );
      CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
      END;
      CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
      END;
      CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, content, category) VALUES ('delete', old.id, old.content, old.category);
        INSERT INTO facts_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
      END;
      CREATE UNIQUE INDEX idx_facts_fingerprint
        ON facts(content, created_at, COALESCE(session_id, ''), category);
    `);
    raw
      .prepare(`INSERT INTO facts (created_at, category, content, source_surface) VALUES (?, ?, ?, ?)`)
      .run(new Date().toISOString(), 'convention', 'legacymigrate an old uncited fact', 'cli');
    raw.pragma('user_version = 3');
    raw.close();

    // Open via MemoryStore → runs the v3→v4 migration (adds facts.evidence).
    const migrated = new MemoryStore(dir);
    try {
      // The pre-existing row survives and reads back evidence = null (uncited).
      const old = migrated.searchFacts('legacymigrate');
      expect(old.length).toBeGreaterThan(0);
      expect(old[0]!.evidence ?? null).toBeNull();

      // A new write can now persist evidence.
      const id = migrated.storeFact({
        category: 'convention',
        content: 'freshmigrate a newly cited fact',
        source_surface: 'cli',
        evidence: 'src/b.ts:2',
      });
      expect(migrated.getFact(id)!.evidence).toBe('src/b.ts:2');
    } finally {
      migrated.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
