/**
 * Tests for src/cli/session-store.ts
 *
 * Points HOME at a tmp dir so saves don't touch real ~/.afk/state/sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync, symlinkSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  saveSession,
  loadSession,
  findSession,
  listSessions,
  sdkSessionIdFor,
  forkStoredSession,
} from './session-store.js';
import { createSessionStats, recordTurn } from './slash/session-stats.js';
import { useUnsetAfkHome } from '../__test-utils__/unset-afk-home.js';

let tmpHome: string;
let originalHome: string | undefined;

// This suite asserts the unset-AFK_HOME fallback (store under $HOME/.afk) —
// drop the global sentinel AFK_HOME per test; HOME is redirected below.
useUnsetAfkHome();

beforeEach(() => {
  originalHome = process.env['HOME'];
  tmpHome = join(tmpdir(), `afk-sess-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
  if (originalHome !== undefined) process.env['HOME'] = originalHome;
});

describe('session-store', () => {
  it('saveSession writes a JSON file and returns its path', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello', 'hi', { totalCostUsd: 0.01, durationMs: 100, usage: { input_tokens: 10, output_tokens: 5 }, sessionId: 'sdk-abc' });
    const path = saveSession(stats);
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(raw['model']).toBe('sonnet');
    expect(raw['sessionId']).toBe('sdk-abc');
    expect((raw['turns'] as unknown[]).length).toBe(1);
  });

  it('loadSession round-trips saved data', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'q', 'a', { totalCostUsd: 0.02, durationMs: 200, usage: { input_tokens: 20, output_tokens: 10 }, sessionId: 'sdk-xyz' });
    const path = saveSession(stats, 'my-save');
    const loaded = loadSession(path);
    expect(loaded).toBeDefined();
    expect(loaded!.sessionId).toBe('sdk-xyz');
    expect(loaded!.totalTurns).toBe(1);
    expect(loaded!.turns[0]!.user).toBe('q');
  });

  it('loadSession returns undefined when not found', () => {
    expect(loadSession('nonexistent-session')).toBeUndefined();
  });

  it('loadSession can take a raw id (not a full path)', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'a', 'b', { sessionId: 'id-by-id' });
    saveSession(stats, 'named-session');
    const loaded = loadSession('named-session');
    expect(loaded).toBeDefined();
  });

  it('listSessions returns newest first', async () => {
    const s1 = createSessionStats('sonnet');
    recordTurn(s1, 'a', 'b', { sessionId: 'one' });
    saveSession(s1, 'older');
    await new Promise((r) => setTimeout(r, 5));
    const s2 = createSessionStats('sonnet');
    recordTurn(s2, 'c', 'd', { sessionId: 'two' });
    saveSession(s2, 'newer');
    const list = listSessions();
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe('newer');
    expect(list[1]!.id).toBe('older');
  });

  it('listSessions is empty before any save', () => {
    expect(listSessions()).toEqual([]);
  });

  it('sdkSessionIdFor resolves a saved id to its SDK session id', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'x', 'y', { sessionId: 'sdk-456' });
    saveSession(stats, 'alias');
    expect(sdkSessionIdFor('alias')).toBe('sdk-456');
  });

  it('findSession resolves either the sidecar id or SDK session id', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'x', 'y', { sessionId: 'sdk-find-me' });
    saveSession(stats, 'friendly-name');

    expect(findSession('friendly-name')?.id).toBe('friendly-name');
    expect(findSession('sdk-find-me')?.data.sessionId).toBe('sdk-find-me');
  });

  it('sdkSessionIdFor returns undefined for unknown id', () => {
    expect(sdkSessionIdFor('missing')).toBeUndefined();
  });

  it('round-trips tool events through save/load', () => {
    const stats = createSessionStats('sonnet');
    const tools = [
      { toolName: 'write_file', toolUseId: 'tu_1', input: '{"file_path":"x.ts"}', result: 'Wrote 10 bytes to x.ts' },
      { toolName: 'bash', toolUseId: 'tu_2', input: '{"command":"pnpm test"}', result: 'FAIL', isError: true },
    ];
    recordTurn(stats, 'build', 'done', { sessionId: 'sdk-tools' }, tools);
    const path = saveSession(stats, 'tool-test');
    const loaded = loadSession(path);
    expect(loaded).toBeDefined();
    expect(loaded!.turns[0]!.toolEvents).toHaveLength(2);
    expect(loaded!.turns[0]!.toolEvents![0]!.toolName).toBe('write_file');
    expect(loaded!.turns[0]!.toolEvents![1]!.isError).toBe(true);
  });

  // Regression: /resume returned zero sessions because sidecars were only
  // written on explicit /save. The interactive close handler now autosaves.
  // This test exercises the persistence contract /resume depends on.
  it('listSessions surfaces a saved session with a mid-session model switch', () => {
    // Start at sonnet, then simulate a /model opus_1m switch: stats.model is
    // mutated in place by the modelCmd handler (info.ts:223).
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello', 'hi', { sessionId: 'sdk-mid-switch' });
    stats.model = 'opus_1m';
    recordTurn(stats, 'now on opus', 'opus-reply', { sessionId: 'sdk-mid-switch' });

    saveSession(stats);

    const list = listSessions();
    expect(list.length).toBe(1);
    expect(list[0]!.model).toBe('opus_1m');
    expect(list[0]!.sessionId).toBe('sdk-mid-switch');
    expect(list[0]!.totalTurns).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Path-traversal hardening (PR #447 review M2/M3).
  //
  // safeResolvePath must reject:
  //   - relative-path escapes via overrideId ('../../evil') on writes
  //   - absolute paths outside sessionsDir on reads
  //   - symlinks inside sessionsDir whose target points outside the dir
  // -------------------------------------------------------------------------
  describe('path-traversal hardening', () => {
    it('saveSession rejects overrideId with relative traversal', () => {
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'q', 'a', { sessionId: 'sdk-trav' });
      expect(() => saveSession(stats, '../../../evil')).toThrow(/escapes sessions directory/);
    });

    it('saveSession rejects overrideId with absolute path outside sessions dir', () => {
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'q', 'a', { sessionId: 'sdk-trav-abs' });
      // Use an absolute path inside tmpdir but outside the sessions dir; the
      // join+resolve path will lexically equal that absolute path, then fail
      // the prefix check.
      const outside = join(tmpdir(), `afk-outside-${Date.now()}.json`);
      expect(() => saveSession(stats, outside)).toThrow(/escapes sessions directory/);
    });

    it('loadSession rejects symlink pointing outside sessions dir', () => {
      // First create a legitimate session so the sessions dir exists.
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'q', 'a', { sessionId: 'sdk-real' });
      const realPath = saveSession(stats, 'real-session');

      // Plant a secret file outside the sessions dir and a symlink to it
      // inside the sessions dir. realpathSync(linkPath) should resolve to
      // the outside target and trip the prefix check.
      const sessionsDir = realPath.substring(0, realPath.lastIndexOf('/'));
      const secretDir = join(tmpHome, 'secret');
      mkdirSync(secretDir, { recursive: true });
      const secretPath = join(secretDir, 'sensitive.json');
      writeFileSync(secretPath, '{"sessionId":"leaked","model":"sonnet","startedAt":0,"savedAt":0,"totalTurns":0,"totalCostUsd":0,"totalTokens":0,"totalDurationMs":0,"turns":[]}');

      const linkPath = join(sessionsDir, 'link-out.json');
      try {
        symlinkSync(secretPath, linkPath);
      } catch (err) {
        // Some CI envs disallow symlinks (e.g. Windows w/o privilege). Skip.
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
        throw err;
      }

      const loaded = loadSession('link-out');
      expect(loaded).toBeUndefined();
    });
  });

  describe('forkStoredSession', () => {
    it('writes a new sidecar with a FRESH sessionId (never the parent\'s)', () => {
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'hello', 'hi', { sessionId: 'parent-sdk-id' });
      expect(stats.sessionId).toBe('parent-sdk-id');

      const { id, path } = forkStoredSession(stats);

      expect(existsSync(path)).toBe(true);
      const forked = loadSession(path);
      expect(forked).toBeDefined();
      // The fork's sessionId must differ from the parent — otherwise both
      // processes would flush to the same file on exit (last-writer-wins).
      expect(forked!.sessionId).not.toBe('parent-sdk-id');
      // Filename id == stored sessionId, mirroring a normal sidecar.
      expect(forked!.sessionId).toBe(id);
      // Provenance recorded.
      expect(forked!.forkedFrom).toBe('parent-sdk-id');
      expect(typeof forked!.forkedAt).toBe('number');
    });

    it('preserves the full turn history and model', () => {
      const stats = createSessionStats('opus');
      recordTurn(stats, 'first q', 'first a', { sessionId: 'p' });
      recordTurn(stats, 'second q', 'second a', { sessionId: 'p' });

      const { id } = forkStoredSession(stats);
      const forked = loadSession(id);

      expect(forked!.model).toBe('opus');
      expect(forked!.totalTurns).toBe(2);
      expect(forked!.turns).toHaveLength(2);
      expect(forked!.turns[0]!.user).toBe('first q');
      expect(forked!.turns[1]!.assistant).toBe('second a');
    });

    it('does not mutate or overwrite the parent session on disk', () => {
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'q', 'a', { sessionId: 'parent-sdk-id' });
      const parentPath = saveSession(stats); // parent persisted under its own id

      const before = readFileSync(parentPath, 'utf-8');
      const { path: forkPath } = forkStoredSession(stats);
      const after = readFileSync(parentPath, 'utf-8');

      expect(forkPath).not.toBe(parentPath);
      expect(after).toBe(before); // parent untouched
    });

    it('produces a distinct id on each fork', () => {
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'q', 'a', { sessionId: 'p' });
      const a = forkStoredSession(stats);
      const b = forkStoredSession(stats);
      expect(a.id).not.toBe(b.id);
    });

    it('honors an explicit newId (for deterministic callers/tests)', () => {
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'q', 'a', { sessionId: 'p' });
      const { id } = forkStoredSession(stats, { newId: 'fixed-fork-id' });
      expect(id).toBe('fixed-fork-id');
      expect(loadSession('fixed-fork-id')).toBeDefined();
    });

    it('forked sidecar is discoverable via the normal resume lookup', () => {
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'q', 'a', { sessionId: 'p' });
      const { id } = forkStoredSession(stats);
      const found = findSession(id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(id);
    });

    it('preserves the session cwd so the fork resumes in the same directory', () => {
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'q', 'a', { sessionId: 'p' });
      stats.cwd = '/some/worktree';
      const { id } = forkStoredSession(stats);
      const forked = loadSession(id);
      expect(forked!.cwd).toBe('/some/worktree');
    });

    it('omits cwd when the session has none', () => {
      const stats = createSessionStats('sonnet');
      recordTurn(stats, 'q', 'a', { sessionId: 'p' });
      expect(stats.cwd).toBeUndefined();
      const { id } = forkStoredSession(stats);
      const forked = loadSession(id);
      expect(forked!.cwd).toBeUndefined();
      expect('cwd' in (forked as object)).toBe(false);
    });
  });
});

describe('session-store — naming', () => {
  function sessionsDirOf(savedPath: string): string {
    return savedPath.substring(0, savedPath.lastIndexOf('/'));
  }

  it('auto-name from the first user message round-trips through save/load', () => {
    const stats = createSessionStats('sonnet');
    // recordTurn derives the name from the first user message.
    recordTurn(stats, 'Help me fix the Telegram resume bug', 'ok', { sessionId: 'sdk-auto' });
    expect(stats.name).toBe('help-me-fix-the-telegram-resume');
    const path = saveSession(stats);
    expect(loadSession(path)!.name).toBe('help-me-fix-the-telegram-resume');
  });

  it('does not overwrite an explicitly set name on later turns', () => {
    const stats = createSessionStats('sonnet');
    stats.name = 'my-chosen-name';
    recordTurn(stats, 'some first message', 'ok', { sessionId: 'sdk-keep' });
    expect(stats.name).toBe('my-chosen-name');
  });

  it('listSessions surfaces the name', () => {
    const stats = createSessionStats('sonnet');
    stats.name = 'named-list-entry';
    recordTurn(stats, 'x', 'y', { sessionId: 'sdk-list-name' });
    saveSession(stats);
    const entry = listSessions().find((e) => e.sessionId === 'sdk-list-name');
    expect(entry?.name).toBe('named-list-entry');
  });

  it('findSession resolves by exact name', () => {
    const stats = createSessionStats('sonnet');
    stats.name = 'find-by-name';
    recordTurn(stats, 'x', 'y', { sessionId: 'sdk-by-name' });
    saveSession(stats);
    expect(findSession('find-by-name')?.data.sessionId).toBe('sdk-by-name');
  });

  it('findSession resolves by a unique name prefix', () => {
    const stats = createSessionStats('sonnet');
    stats.name = 'fix-telegram-resume';
    recordTurn(stats, 'x', 'y', { sessionId: 'sdk-prefix' });
    saveSession(stats);
    expect(findSession('fix-tele')?.data.sessionId).toBe('sdk-prefix');
  });

  it('findSession returns undefined for an ambiguous name prefix', async () => {
    const a = createSessionStats('sonnet');
    a.name = 'deploy-staging';
    recordTurn(a, 'x', 'y', { sessionId: 'sdk-a' });
    saveSession(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = createSessionStats('sonnet');
    b.name = 'deploy-prod';
    recordTurn(b, 'x', 'y', { sessionId: 'sdk-b' });
    saveSession(b);
    // 'deploy' is a prefix of both names — ambiguous, so no resolution.
    expect(findSession('deploy')).toBeUndefined();
  });

  it('findSession does not prefix-match on a short (<3 char) input', () => {
    const stats = createSessionStats('sonnet');
    stats.name = 'analytics-dashboard';
    recordTurn(stats, 'x', 'y', { sessionId: 'sdk-short-prefix' });
    saveSession(stats);
    // A 1–2 char input must NOT silently resolve via prefix match, even though
    // 'analytics-dashboard' starts with 'a'/'an'. Guards against `--resume a`
    // grabbing the wrong session.
    expect(findSession('a')).toBeUndefined();
    expect(findSession('an')).toBeUndefined();
    // 3 chars is the floor — a unique prefix at/above it still resolves.
    expect(findSession('ana')?.data.sessionId).toBe('sdk-short-prefix');
  });

  it('sdkSessionIdFor resolves by name', () => {
    const stats = createSessionStats('sonnet');
    stats.name = 'sdk-id-by-name';
    recordTurn(stats, 'x', 'y', { sessionId: 'sdk-resolved' });
    saveSession(stats);
    expect(sdkSessionIdFor('sdk-id-by-name')).toBe('sdk-resolved');
  });

  it('saving and renaming a session never forks a duplicate sidecar', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'hello world', 'hi', { sessionId: 'sdk-dup' });
    expect(stats.name).toBe('hello-world');
    const path = saveSession(stats);
    const dir = sessionsDirOf(path);

    // Rename mid-session and save again — same sessionId → same file.
    stats.name = 'renamed-session';
    saveSession(stats);
    saveSession(stats); // a third per-turn-style autosave

    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toEqual(['sdk-dup.json']);
    expect(loadSession('sdk-dup')!.name).toBe('renamed-session');
    // The names were never used as filenames.
    expect(existsSync(join(dir, 'hello-world.json'))).toBe(false);
    expect(existsSync(join(dir, 'renamed-session.json'))).toBe(false);
  });

  it('persists source and telegramChatId when present', () => {
    const stats = createSessionStats('sonnet');
    stats.source = 'telegram';
    stats.telegramChatId = 999;
    recordTurn(stats, 'x', 'y', { sessionId: 'sdk-src' });
    const path = saveSession(stats);
    const loaded = loadSession(path)!;
    expect(loaded.source).toBe('telegram');
    expect(loaded.telegramChatId).toBe(999);
    // Surfaced in the list entry too (for the /resume origin marker).
    const entry = listSessions().find((e) => e.sessionId === 'sdk-src');
    expect(entry?.source).toBe('telegram');
  });

  it('is backward-compatible with legacy sidecars that have no name', () => {
    // A pre-naming sidecar has no `name` field.
    const stats = createSessionStats('sonnet');
    stats.name = undefined;
    // Manually clear the auto-name path by recording then deleting the name,
    // simulating a file written before the feature existed.
    recordTurn(stats, 'legacy work', 'done', { sessionId: 'sdk-legacy' });
    delete (stats as { name?: string }).name;
    const path = saveSession(stats);

    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect('name' in raw).toBe(false);

    const entry = listSessions().find((e) => e.sessionId === 'sdk-legacy');
    expect(entry?.name).toBeUndefined();
    // Resolving by sidecar id and SDK id still works.
    expect(findSession('sdk-legacy')?.data.sessionId).toBe('sdk-legacy');
  });

  it('persists cwd when set on stats', () => {
    const stats = createSessionStats('sonnet');
    stats.cwd = '/proj/foo';
    recordTurn(stats, 'work here', 'done', { sessionId: 'sdk-cwd-test' });
    const path = saveSession(stats);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(raw['cwd']).toBe('/proj/foo');
    const entry = listSessions().find((e) => e.sessionId === 'sdk-cwd-test');
    expect(entry?.cwd).toBe('/proj/foo');
  });

  it('does not write cwd key when absent from stats', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'no cwd', 'done', { sessionId: 'sdk-no-cwd' });
    const path = saveSession(stats);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect('cwd' in raw).toBe(false);
  });
});

describe('session-store — session identity (source / actor)', () => {
  it('persists and round-trips a daemon source and subagent actor', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'q', 'a', { sessionId: 'sdk-ident' });
    stats.source = 'daemon';
    stats.actor = 'subagent';
    const path = saveSession(stats, 'ident-sess');

    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(raw['source']).toBe('daemon');
    expect(raw['actor']).toBe('subagent');

    const loaded = loadSession('ident-sess');
    expect(loaded!.source).toBe('daemon');
    expect(loaded!.actor).toBe('subagent');

    const entry = listSessions().find((e) => e.id === 'ident-sess');
    expect(entry?.source).toBe('daemon');
    expect(entry?.actor).toBe('subagent');
  });

  it('omits actor when unset (back-compat — absent on the sidecar)', () => {
    const stats = createSessionStats('sonnet');
    recordTurn(stats, 'q', 'a', { sessionId: 'sdk-no-actor' });
    const path = saveSession(stats, 'plain-sess');

    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect('actor' in raw).toBe(false);

    const loaded = loadSession('plain-sess');
    expect(loaded!.actor).toBeUndefined();
  });
});
