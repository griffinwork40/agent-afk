/**
 * Tests for session-source.ts — the `afk web` session enumerator.
 *
 * Isolation: `vitest.config.ts` already redirects AFK_HOME to a per-test-file
 * sentinel temp dir via `src/__test-utils__/redirect-paths-env.ts`. This file
 * additionally overrides AFK_HOME per-test (same idiom as
 * `awareness/presence.test.ts`) to a fresh `mkdtempSync` dir it fully
 * controls, so fixtures never land anywhere near the real `~/.afk`. Path
 * helpers (`getSessionsDir`, presence dir) resolve `AFK_HOME` lazily at
 * call-time, so overriding the env var before each call is sufficient even
 * though this file imports the modules under test statically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listWebSessions, DEFAULT_SESSION_LIMIT } from './session-source.js';
import { getSessionsDir } from '../paths.js';
import { writePresenceFileSync } from '../agent/awareness/presence.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let origAfkHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-websess-test-'));
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origAfkHome === undefined) {
    delete process.env['AFK_HOME'];
  } else {
    process.env['AFK_HOME'] = origAfkHome;
  }
});

const NULL_WS = { branch: null, headSha: null, dirty: null, dirtyCount: null, remoteUrl: null };

function metaLine(sessionId: string, opts: { cwd?: string; surface?: string } = {}): string {
  return JSON.stringify({ v: 1, ts: Date.now(), kind: 'meta', sessionId, model: 'test-model', ...opts });
}

function userLine(text: string): string {
  return JSON.stringify({ v: 1, ts: Date.now(), kind: 'user', text });
}

/** Write a synthetic `events.jsonl` ledger for `sessionId`, resolved under the current (already-overridden) AFK_HOME. */
function writeLedger(sessionId: string, lines: string[], mtimeMs?: number): void {
  const dir = path.join(getSessionsDir(), sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'events.jsonl');
  fs.writeFileSync(filePath, lines.map((l) => `${l}\n`).join(''), 'utf8');
  if (mtimeMs !== undefined) {
    const d = new Date(mtimeMs);
    fs.utimesSync(filePath, d, d);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listWebSessions', () => {
  it('tags owned session ids as live and everything else as readonly', async () => {
    writeLedger('owned-1', [metaLine('owned-1', { cwd: '/tmp/a', surface: 'cli' }), userLine('hi')]);
    writeLedger('foreign-1', [metaLine('foreign-1', { cwd: '/tmp/b', surface: 'telegram' }), userLine('yo')]);

    const results = await listWebSessions(new Set(['owned-1']));
    const byId = new Map(results.map((r) => [r.id, r]));

    expect(byId.get('owned-1')?.mode).toBe('live');
    expect(byId.get('foreign-1')?.mode).toBe('readonly');
    expect(byId.get('owned-1')?.cwd).toBe('/tmp/a');
    expect(byId.get('foreign-1')?.surface).toBe('telegram');
  });

  it('includes an owned session with no on-disk ledger yet, still marked live', async () => {
    const results = await listWebSessions(new Set(['brand-new-owned']));
    const entry = results.find((r) => r.id === 'brand-new-owned');

    expect(entry).toBeDefined();
    expect(entry?.mode).toBe('live');
    expect(entry?.updatedAt).toBeUndefined();
  });

  it('does not throw and still lists a session whose ledger is malformed', async () => {
    writeLedger('malformed-1', ['not json at all', '{"broken":', '']);
    writeLedger('healthy-1', [metaLine('healthy-1', { cwd: '/tmp/h' }), userLine('ok')]);

    await expect(listWebSessions(new Set())).resolves.toBeDefined();
    const results = await listWebSessions(new Set());
    const malformed = results.find((r) => r.id === 'malformed-1');
    const healthy = results.find((r) => r.id === 'healthy-1');

    expect(malformed).toBeDefined();
    expect(malformed?.title).toBeUndefined();
    expect(malformed?.cwd).toBeUndefined();
    expect(healthy?.cwd).toBe('/tmp/h');
  });

  it('truncates a long first user message to ~80 chars with an ellipsis', async () => {
    const longText = 'x'.repeat(120);
    writeLedger('long-title-1', [metaLine('long-title-1'), userLine(longText)]);

    const results = await listWebSessions(new Set());
    const entry = results.find((r) => r.id === 'long-title-1');

    expect(entry?.title).toBeDefined();
    expect(entry!.title!.length).toBe(81); // 80 chars + ellipsis
    expect(entry!.title!.endsWith('…')).toBe(true);
  });

  it('leaves a short first user message untruncated', async () => {
    writeLedger('short-title-1', [metaLine('short-title-1'), userLine('hello there')]);

    const results = await listWebSessions(new Set());
    const entry = results.find((r) => r.id === 'short-title-1');

    expect(entry?.title).toBe('hello there');
  });

  it('sorts sessions newest-first by updatedAt', async () => {
    const now = Date.now();
    writeLedger('oldest', [metaLine('oldest')], now - 10_000);
    writeLedger('middle', [metaLine('middle')], now - 5_000);
    writeLedger('newest', [metaLine('newest')], now);

    const results = await listWebSessions(new Set());
    const ids = results.map((r) => r.id);

    expect(ids.indexOf('newest')).toBeLessThan(ids.indexOf('middle'));
    expect(ids.indexOf('middle')).toBeLessThan(ids.indexOf('oldest'));
  });

  it('marks a foreign session alive when a live presence record exists, and not alive otherwise', async () => {
    writeLedger('foreign-alive', [metaLine('foreign-alive')]);
    writeLedger('foreign-dead', [metaLine('foreign-dead')]);

    writePresenceFileSync({
      sessionId: 'foreign-alive',
      surface: 'cli',
      cwd: '/tmp/alive',
      startedAt: new Date().toISOString(),
      model: { provider: 'anthropic-direct', name: 'test-model' },
      workspace: NULL_WS,
      pid: process.pid,
    });

    const results = await listWebSessions(new Set());
    const alive = results.find((r) => r.id === 'foreign-alive');
    const dead = results.find((r) => r.id === 'foreign-dead');

    expect(alive?.alive).toBe(true);
    expect(dead?.alive).toBe(false);
  });

  it('never annotates alive on an owned/live session', async () => {
    writeLedger('owned-alive-check', [metaLine('owned-alive-check')]);

    const results = await listWebSessions(new Set(['owned-alive-check']));
    const entry = results.find((r) => r.id === 'owned-alive-check');

    expect(entry?.mode).toBe('live');
    expect(entry?.alive).toBeUndefined();
  });
  // A long-lived install accumulates tens of thousands of session dirs. Before
  // the cap, listing them took ~810ms and produced a 2.4MB payload on a real
  // machine — per sidebar load, growing without bound.
  it('caps foreign sessions at the default limit, newest first', async () => {
    for (let i = 0; i < DEFAULT_SESSION_LIMIT + 25; i++) {
      writeLedger(`bulk-${String(i).padStart(4, '0')}`, [metaLine(`bulk-${i}`)]);
    }

    const results = await listWebSessions(new Set());
    expect(results.length).toBe(DEFAULT_SESSION_LIMIT);

    const times = results.map((r) => r.updatedAt ?? '');
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('honours an explicit limit', async () => {
    for (let i = 0; i < 10; i++) writeLedger(`lim-${i}`, [metaLine(`lim-${i}`)]);

    expect((await listWebSessions(new Set(), 3)).length).toBe(3);
  });

  // Owned sessions are live and always actionable — the cap must never hide one.
  it('always includes owned sessions regardless of the limit', async () => {
    for (let i = 0; i < 10; i++) writeLedger(`f-${i}`, [metaLine(`f-${i}`)]);
    writeLedger('my-live-session', [metaLine('my-live-session')]);

    const results = await listWebSessions(new Set(['my-live-session']), 2);
    const mine = results.find((r) => r.id === 'my-live-session');

    expect(mine).toBeDefined();
    expect(mine?.mode).toBe('live');
  });
});
