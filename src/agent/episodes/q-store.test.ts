/**
 * Tests for QEpisodesStore (q-store.ts).
 *
 * Uses a tmp directory for each test so runs are isolated.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { QEpisodesStore, Q_EPISODES_SCHEMA_VERSION } from './q-store.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'afk-q-store-test-'));
}

function makeStore(dir: string): QEpisodesStore {
  return new QEpisodesStore(dir);
}

const BASE_EPISODE = {
  sessionId: 'session-abc',
  goal: 'Refactor the auth module',
  narrative: 'The agent refactored auth successfully.',
  tags: ['refactor', 'auth'],
  files: ['src/auth.ts'],
  synthesizedAt: '2026-01-01T00:00:00.000Z',
};

describe('QEpisodesStore', () => {
  let dir: string;
  let store: QEpisodesStore;

  beforeEach(() => {
    dir = makeTmpDir();
    store = makeStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('schema version constant is correct', () => {
    expect(Q_EPISODES_SCHEMA_VERSION).toBe(1);
  });

  it('returns null watermark on first open', () => {
    expect(store.getWatermark()).toBeNull();
  });

  it('persists and retrieves a watermark', () => {
    const ts = '2026-06-01T12:00:00.000Z';
    store.setWatermark(ts);
    expect(store.getWatermark()).toBe(ts);
  });

  it('overwrites watermark on repeated set', () => {
    store.setWatermark('2026-01-01T00:00:00.000Z');
    store.setWatermark('2026-06-01T12:00:00.000Z');
    expect(store.getWatermark()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('upserts an episode and retrieves it by session_id', () => {
    store.upsertEpisode(BASE_EPISODE);
    const row = store.getEpisode('session-abc');
    expect(row).not.toBeNull();
    expect(row!.goal).toBe('Refactor the auth module');
    expect(row!.narrative).toBe('The agent refactored auth successfully.');
    expect(JSON.parse(row!.tags_json)).toEqual(['refactor', 'auth']);
    expect(JSON.parse(row!.files_json)).toEqual(['src/auth.ts']);
    expect(row!.synthesized_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null for unknown session_id', () => {
    expect(store.getEpisode('nonexistent')).toBeNull();
  });

  it('upsert is idempotent — re-inserting same session_id updates in place', () => {
    store.upsertEpisode(BASE_EPISODE);
    store.upsertEpisode({ ...BASE_EPISODE, goal: 'Updated goal' });
    expect(store.count()).toBe(1);
    expect(store.getEpisode('session-abc')!.goal).toBe('Updated goal');
  });

  it('count returns 0 on empty store', () => {
    expect(store.count()).toBe(0);
  });

  it('count increments on each distinct session_id', () => {
    store.upsertEpisode(BASE_EPISODE);
    store.upsertEpisode({ ...BASE_EPISODE, sessionId: 'session-xyz', synthesizedAt: '2026-02-01T00:00:00.000Z' });
    expect(store.count()).toBe(2);
  });

  it('listEpisodes returns all episodes ordered by synthesized_at DESC', () => {
    store.upsertEpisode({ ...BASE_EPISODE, synthesizedAt: '2026-01-01T00:00:00.000Z' });
    store.upsertEpisode({ ...BASE_EPISODE, sessionId: 'session-xyz', synthesizedAt: '2026-03-01T00:00:00.000Z' });
    const rows = store.listEpisodes();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.session_id).toBe('session-xyz'); // most recent first
  });

  it('listEpisodes filters by since cutoff', () => {
    store.upsertEpisode({ ...BASE_EPISODE, synthesizedAt: '2026-01-01T00:00:00.000Z' });
    store.upsertEpisode({ ...BASE_EPISODE, sessionId: 'session-new', synthesizedAt: '2026-06-01T00:00:00.000Z' });
    const rows = store.listEpisodes({ since: '2026-03-01T00:00:00.000Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe('session-new');
  });

  it('listEpisodes filters by domain tag', () => {
    store.upsertEpisode({ ...BASE_EPISODE, tags: ['auth', 'refactor'] });
    store.upsertEpisode({ ...BASE_EPISODE, sessionId: 'session-other', tags: ['deploy'], synthesizedAt: '2026-02-01T00:00:00.000Z' });
    const rows = store.listEpisodes({ domain: 'auth' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe('session-abc');
  });

  it('listEpisodes respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.upsertEpisode({ ...BASE_EPISODE, sessionId: `session-${i}`, synthesizedAt: `2026-0${i + 1}-01T00:00:00.000Z` });
    }
    expect(store.listEpisodes({ limit: 3 })).toHaveLength(3);
  });

  it('searchEpisodes finds by goal keyword', () => {
    store.upsertEpisode(BASE_EPISODE);
    store.upsertEpisode({ ...BASE_EPISODE, sessionId: 'session-deploy', goal: 'Deploy the service', narrative: 'Deployed.', synthesizedAt: '2026-02-01T00:00:00.000Z' });
    const hits = store.searchEpisodes('auth');
    expect(hits.some((r) => r.session_id === 'session-abc')).toBe(true);
    expect(hits.every((r) => r.session_id !== 'session-deploy')).toBe(true);
  });

  it('searchEpisodes finds by narrative keyword', () => {
    store.upsertEpisode(BASE_EPISODE);
    const hits = store.searchEpisodes('refactored');
    expect(hits).toHaveLength(1);
  });
});
