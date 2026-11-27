import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getFacetCacheDir, getMemoryDir, getSessionsDir } from '../../paths.js';
import { writeSessionMeta } from '../session/session-meta.js';
import { writeRecord } from '../outcomes/store.js';
import { MemoryStore } from './memory-store.js';

const startTime = '2024-01-02T03:04:05.000Z';

function writeFixture(dir: string, id: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(data));
}

describe('facet FTS upgrade', () => {
  it('rebuilds v2 rows from retained sidecars and falls back to cached facets', async () => {
    const memoryDir = getMemoryDir();
    const cacheDir = getFacetCacheDir();
    const sessionsDir = getSessionsDir();
    const id = 'sdk-rich';
    const sidecarId = 'file-rich'; // A sidecar filename can differ from the SDK id.
    mkdirSync(memoryDir, { recursive: true });
    const oldDb = new Database(join(memoryDir, 'facets-fts.db'));
    try {
      oldDb.exec(`
        PRAGMA user_version = 2;
        CREATE TABLE facets_index (session_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL,
          brief_summary TEXT, underlying_goal TEXT, primary_success TEXT, decisions TEXT);
        CREATE VIRTUAL TABLE facets_fts USING fts5(session_id UNINDEXED, text_blob,
          content=facets_index, content_rowid=rowid, tokenize='porter');
        INSERT INTO facets_index (session_id, indexed_at, brief_summary)
          VALUES ('sdk-rich', '2026-01-01T00:00:00.000Z', 'staleindexword');
        INSERT INTO facets_fts (rowid, session_id, text_blob) VALUES (1, 'sdk-rich', 'staleindexword');
      `);
    } finally {
      oldDb.close();
    }
    writeFixture(cacheDir, sidecarId, {
      session_id: id,
      brief_summary: 'Investigated queue performance',
      start_time: startTime,
      yield_tracking: { pr_url: 'https://github.com/test/orchard/pull/123' },
      evidence_pointers: ['src/queue-sieve.ts', join(sessionsDir, `${sidecarId}.json`)],
      source_session_path: join(sessionsDir, `${sidecarId}.json`),
    });
    writeFixture(sessionsDir, sidecarId, {
      sessionId: id,
      cwd: join('workspace', 'bayberry'),
      startedAt: Date.parse(startTime),
      turns: [
        { user: 'Opening request' },
        { user: 'Explain monotonic backpressure', assistant: 'assistantonlyword',
          toolEvents: [{ toolName: 'bash', result: 'toolonlyword' }] },
      ],
    });
    await writeSessionMeta({
      v: 1, sessionId: id, model: 'test',
      gitHead: { branch: 'feature/canary-braid', headSha: null, capturedAt: Date.parse(startTime) },
    });
    writeRecord({
      schema_version: 1, session_id: id, label: 'unknown', confidence: 0,
      state: 'provisional', settles_after: null, session_kind: 'mutating', self_report: 'none',
      artifacts: { commits: [], prs: [], repo: null }, votes: [], history: [],
      outcomes: {
        schemaVersion: 1, cwd: 'workspace', startHead: null, endHead: null,
        commits: [{ source: 'git_log', repo: 'workspace', sha: 'abcdef1', subject: 'Make retries idempotent' }],
        prs: [], filesChanged: [], filesChangedTruncated: false, schedules: [], services: [], terminalState: null,
      },
    });
    writeFixture(cacheDir, 'thin', { session_id: 'thin', brief_summary: 'Archived sequoia', start_time: startTime });
    expect(readdirSync(sessionsDir)).not.toContain('thin.json');

    const store = new MemoryStore(memoryDir, cacheDir);
    try {
      for (const query of ['monotonic', 'bayberry', 'canary-braid', 'queue-sieve.ts', 'orchard/pull/123', 'idempotent']) {
        expect(store.search(query).map((result) => result.source_session)).toEqual([id]);
      }
      for (const query of ['assistantonlyword', 'toolonlyword', 'staleindexword', 'file-rich.json']) {
        expect(store.search(query)).toEqual([]);
      }
      const [thin] = store.search('sequoia');
      expect(thin).toMatchObject({ type: 'session', source_session: 'thin', created_at: startTime });
      expect(thin?.content).not.toContain('Cwd:');
    } finally {
      store.close();
    }
    const reopened = new Database(join(memoryDir, 'facets-fts.db'), { readonly: true });
    try {
      expect(reopened.pragma('user_version', { simple: true })).toBe(3);
    } finally {
      reopened.close();
    }
  });
});
