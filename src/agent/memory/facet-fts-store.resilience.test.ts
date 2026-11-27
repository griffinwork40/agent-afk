/**
 * Failure and convergence behaviour of the facet FTS index: open failures,
 * a locked index, a rebuild interrupted partway, bounded rebuild batches, and
 * late enrichment that lands after the SessionEnd write.
 */
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSessionsDir } from '../../paths.js';
import { writeRecord } from '../outcomes/store.js';
import { FacetFtsStore } from './facet-fts-store.js';
import { reindexSessionFacet } from './facet-fts-store.reindex.js';
import { MemoryStore } from './memory-store.js';

const V3 = 'facets-fts.v3.db';
let root: string;
let memoryDir: string;
let cacheDir: string;

function writeFacet(id: string, summary: string): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${id}.json`), JSON.stringify({ session_id: id, brief_summary: summary }));
}

function indexedCount(): number {
  const db = new Database(join(memoryDir, V3), { readonly: true });
  try {
    return (db.prepare('SELECT count(*) AS n FROM facets_index').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Hold the index's write lock from a second connection. */
function lockIndex(): () => void {
  new FacetFtsStore(memoryDir).close(); // Create the schema first.
  const db = new Database(join(memoryDir, V3));
  db.exec('BEGIN IMMEDIATE');
  return () => {
    db.exec('ROLLBACK');
    db.close();
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-facet-resilience-'));
  memoryDir = join(root, 'memory');
  cacheDir = join(root, 'facets');
  mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('facet FTS index failures stay non-fatal', () => {
  it('degrades to no session results when the index file cannot be opened', () => {
    mkdirSync(join(memoryDir, V3)); // A directory where the database file belongs.
    writeFacet('s-open', 'unopenable index');
    const store = new MemoryStore(memoryDir, cacheDir);
    try {
      store.storeFact({ category: 'learning', content: 'unopenable fact', source_surface: 'test' });
      expect(store.search('unopenable').map((r) => r.type)).toEqual(['fact']);
      expect(() => store.indexFacet({ session_id: 's-open', brief_summary: 'x' })).not.toThrow();
    } finally {
      store.close();
    }
  });

  it('constructs MemoryStore and skips the batch while another process holds the write lock', () => {
    writeFacet('s-locked', 'contended rebuild');
    const release = lockIndex();
    try {
      const store = new MemoryStore(memoryDir, cacheDir);
      store.close();
    } finally {
      release();
    }
    expect(indexedCount()).toBe(0);
    // The skipped batch is not marked done, so the next open indexes it.
    new MemoryStore(memoryDir, cacheDir).close();
    expect(indexedCount()).toBe(1);
  });

  it('skips a late re-index without waiting when the index is locked', () => {
    writeFacet('s-busy', 'busy reindex');
    const release = lockIndex();
    try {
      const started = Date.now();
      expect(() => reindexSessionFacet('s-busy', { memoryDir, cacheDir })).not.toThrow();
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      release();
    }
    expect(indexedCount()).toBe(0);
  });

  it('indexes the rest of a batch when one cached facet fails partway through', () => {
    writeFacet('s-before', 'partial alpha');
    mkdirSync(join(cacheDir, 's-broken.json')); // Reading it throws EISDIR.
    writeFacet('s-after', 'partial omega');
    expect(() => new MemoryStore(memoryDir, cacheDir).close()).not.toThrow();
    const store = new FacetFtsStore(memoryDir);
    try {
      expect(store.isIndexed('s-before')).toBe(true);
      expect(store.isIndexed('s-after')).toBe(true);
      expect(store.backfill(cacheDir)).toBe(0); // The broken file is not retried forever.
    } finally {
      store.close();
    }
  });
});

describe('facet FTS rebuild is bounded and converges', () => {
  it('indexes at most one batch per open and completes over later opens', () => {
    for (let i = 0; i < 250; i++) writeFacet(`s-batch-${i}`, `batch facet ${i}`);
    new MemoryStore(memoryDir, cacheDir).close();
    expect(indexedCount()).toBe(200);
    new MemoryStore(memoryDir, cacheDir).close();
    expect(indexedCount()).toBe(250);
  });
});

describe('late enrichment reaches the index', () => {
  it('re-indexes commit subjects from a later outcome record, and a thin projection never erases them', () => {
    const id = 's-late';
    writeFacet(id, 'late enrichment');
    mkdirSync(getSessionsDir(), { recursive: true });
    writeFileSync(join(getSessionsDir(), `${id}.json`), JSON.stringify({ turns: [{ user: 'hello' }] }));
    reindexSessionFacet(id, { memoryDir, cacheDir });
    const store = new FacetFtsStore(memoryDir);
    try {
      expect(store.search('quasarsubject')).toEqual([]);
      writeRecord({
        schema_version: 1, session_id: id, label: 'unknown', confidence: 0,
        state: 'provisional', settles_after: null, session_kind: 'mutating', self_report: 'none',
        artifacts: { commits: [], prs: [], repo: null }, votes: [], history: [],
        outcomes: {
          schemaVersion: 1, cwd: 'workspace', startHead: null, endHead: null,
          commits: [{ source: 'git_log', repo: 'workspace', sha: 'abcdef1', subject: 'Add quasarsubject' }],
          prs: [], filesChanged: ['src/nebula-file.ts'], filesChangedTruncated: false,
          schedules: [], services: [], terminalState: null,
        },
      });
      reindexSessionFacet(id, { memoryDir, cacheDir });
      expect(store.search('quasarsubject').map((r) => r.source_session)).toEqual([id]);
      expect(store.search('nebula-file').map((r) => r.source_session)).toEqual([id]);
      // A projection that saw neither the session file nor the outcome record
      // (e.g. MemoryStore.indexFacet on a raw facet) must not replace the row.
      const memory = new MemoryStore(memoryDir, cacheDir);
      try {
        memory.indexFacet({ session_id: id, brief_summary: 'thin replacement' });
      } finally {
        memory.close();
      }
      expect(store.search('quasarsubject').map((r) => r.source_session)).toEqual([id]);
    } finally {
      store.close();
    }
  });
});
