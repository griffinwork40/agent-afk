import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getOrDeriveFacet, listSessionIds, loadStoredSession } from './store.js';
import type { StoredSessionInput } from './schema.js';

let sessionsDir: string;
let cacheDir: string;

function sampleSession(id: string, overrides: Partial<StoredSessionInput> = {}): StoredSessionInput {
  return {
    sessionId: id,
    name: 'sample-session',
    model: 'opus',
    startedAt: 1_000_000,
    savedAt: 1_000_000 + 60_000,
    totalTurns: 1,
    totalCostUsd: 0,
    totalTokens: 10,
    totalDurationMs: 60_000,
    turns: [
      {
        user: 'do the thing',
        assistant: 'done',
        timestamp: 1,
        toolEvents: [{ toolName: 'bash', toolUseId: 'a', input: JSON.stringify({ command: 'ls' }) }],
      },
    ],
    ...overrides,
  };
}

function writeSession(id: string, session: StoredSessionInput): string {
  const path = join(sessionsDir, `${id}.json`);
  writeFileSync(path, JSON.stringify(session), 'utf8');
  return path;
}

function readCache(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cacheDir, `${id}.json`), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), 'afk-facet-sessions-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'afk-facet-cache-'));
});

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('getOrDeriveFacet', () => {
  it('derives and writes a cache entry on first read', () => {
    writeSession('sess-a', sampleSession('sess-a'));
    const facet = getOrDeriveFacet('sess-a', { sessionsDir, cacheDir });
    expect(facet).toBeDefined();
    expect(facet?.session_id).toBe('sess-a');
    expect(existsSync(join(cacheDir, 'sess-a.json'))).toBe(true);
  });

  it('returns undefined for a missing session', () => {
    expect(getOrDeriveFacet('does-not-exist', { sessionsDir, cacheDir })).toBeUndefined();
  });

  it('returns the cached facet without rewriting an unchanged session', () => {
    writeSession('sess-b', sampleSession('sess-b'));
    getOrDeriveFacet('sess-b', { sessionsDir, cacheDir });

    // Tag the cache with a passthrough sentinel; a rewrite would erase it.
    const cached = readCache('sess-b');
    cached['_sentinel'] = 'keep';
    writeFileSync(join(cacheDir, 'sess-b.json'), JSON.stringify(cached), 'utf8');

    const second = getOrDeriveFacet('sess-b', { sessionsDir, cacheDir });
    expect((second as Record<string, unknown>)['_sentinel']).toBe('keep');
    expect(readCache('sess-b')['_sentinel']).toBe('keep');
  });

  it('re-derives when the session sidecar changes (staleness)', () => {
    const path = writeSession('sess-c', sampleSession('sess-c'));
    getOrDeriveFacet('sess-c', { sessionsDir, cacheDir });

    const cached = readCache('sess-c');
    cached['_sentinel'] = 'keep';
    writeFileSync(join(cacheDir, 'sess-c.json'), JSON.stringify(cached), 'utf8');

    // Bump the session mtime into the future to force a stale read.
    const future = new Date(Date.now() + 100_000);
    utimesSync(path, future, future);

    const second = getOrDeriveFacet('sess-c', { sessionsDir, cacheDir });
    expect(second).toBeDefined();
    expect((second as Record<string, unknown>)['_sentinel']).toBeUndefined();
    expect(readCache('sess-c')['_sentinel']).toBeUndefined();
  });

  it('force re-derives even when the cache is fresh', () => {
    writeSession('sess-d', sampleSession('sess-d'));
    getOrDeriveFacet('sess-d', { sessionsDir, cacheDir });

    const cached = readCache('sess-d');
    cached['_sentinel'] = 'keep';
    writeFileSync(join(cacheDir, 'sess-d.json'), JSON.stringify(cached), 'utf8');

    getOrDeriveFacet('sess-d', { sessionsDir, cacheDir, force: true });
    expect(readCache('sess-d')['_sentinel']).toBeUndefined();
  });
});

describe('loadStoredSession', () => {
  it('returns undefined on corrupt JSON', () => {
    writeFileSync(join(sessionsDir, 'broken.json'), 'not json {{{', 'utf8');
    expect(loadStoredSession('broken', sessionsDir)).toBeUndefined();
  });

  it('loads and validates a well-formed session', () => {
    writeSession('sess-e', sampleSession('sess-e'));
    const loaded = loadStoredSession('sess-e', sessionsDir);
    expect(loaded?.sessionId).toBe('sess-e');
    expect(loaded?.turns).toHaveLength(1);
  });
});

describe('listSessionIds', () => {
  it('enumerates session sidecar ids', () => {
    writeSession('sess-f', sampleSession('sess-f'));
    writeSession('sess-g', sampleSession('sess-g'));
    const ids = listSessionIds({ sessionsDir });
    expect(ids.sort()).toEqual(['sess-f', 'sess-g']);
  });

  it('returns an empty array for a missing directory', () => {
    expect(listSessionIds({ sessionsDir: join(sessionsDir, 'nope') })).toEqual([]);
  });
});
