/**
 * Tests for src/cli/input/trigger.ts — @-file candidate filtering and trigger
 * detection.
 *
 * detectTrigger is pure (no I/O). filterFileCandidates scans the filesystem,
 * so it uses a tmpdir fixture for relative/absolute modes and an injected
 * homeDir for the tilde mode (no dependency on the real $HOME).
 *
 * Cap invariant: filterFileCandidates must defer the result cap to
 * fileMatchesFor (MAX_FILE_MATCHES) and NOT re-cap at a smaller value.
 * A prior revision sliced to 20 here while the dropdown call sites sliced
 * to 12, so a cwd with >12 entries silently hid the rest.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectTrigger,
  filterFileCandidates,
  filterFileCandidatesAsync,
  filterFileCandidatesCached,
  filterSlashCandidates,
  buildFileCandidates,
  invalidateFileScanCache,
  __fileScanCacheSize,
  FILE_SCAN_TTL_MS,
  type FileDirent,
} from './trigger.js';
import { MAX_FILE_MATCHES } from '../multi-line-reader.js';
import { resetRegistry } from '../slash/registry.js';
import { registerAll } from '../slash/index.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `afk-trigger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpRoot, { recursive: true });
  writeFileSync(join(tmpRoot, 'alpha.txt'), 'a');
  writeFileSync(join(tmpRoot, 'beta.ts'), 'b');
  mkdirSync(join(tmpRoot, 'src'));
  writeFileSync(join(tmpRoot, 'src', 'index.ts'), 'c');
  invalidateFileScanCache();
  resetRegistry();
  registerAll();
});

afterEach(() => {
  invalidateFileScanCache();
  vi.restoreAllMocks();
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

/** Build a plain FileDirent for pure-core tests (no fs). */
function dirent(name: string, isDir = false): FileDirent {
  return { name, isDirectory: () => isDir };
}

describe('detectTrigger — @ file paths', () => {
  it('fires for @~/ (tilde), passing the ~/ query through unchanged', () => {
    expect(detectTrigger('@~/', 3)).toEqual({ kind: 'file', query: '~/' });
  });

  it('fires for @~/.afk/config (tilde, nested + dotfile)', () => {
    const buf = '@~/.afk/config';
    expect(detectTrigger(buf, buf.length)).toEqual({ kind: 'file', query: '~/.afk/config' });
  });

  it('fires for @/etc/ (absolute)', () => {
    expect(detectTrigger('@/etc/', 6)).toEqual({ kind: 'file', query: '/etc/' });
  });

  it('fires for @src/ (relative, regression)', () => {
    expect(detectTrigger('@src/', 5)).toEqual({ kind: 'file', query: 'src/' });
  });

  it('fires mid-buffer after whitespace (read @~/foo)', () => {
    const buf = 'read @~/foo';
    expect(detectTrigger(buf, buf.length)).toEqual({ kind: 'file', query: '~/foo' });
  });

  it('does not fire for plain prose', () => {
    expect(detectTrigger('hello world', 11)).toBeNull();
  });
});

describe('filterFileCandidates', () => {
  it('preserves the leading @ on each candidate value', () => {
    writeFileSync(join(tmpRoot, 'readme.md'), 'x');
    const candidates = filterFileCandidates('read', tmpRoot);
    expect(candidates.some((c) => c.value === '@readme.md')).toBe(true);
    expect(candidates.every((c) => c.value.startsWith('@'))).toBe(true);
  });

  it('relative (regression): bare prefix lists cwd entries as @name', () => {
    const values = filterFileCandidates('al', tmpRoot).map((c) => c.value);
    expect(values).toContain('@alpha.txt');
  });

  it('relative subdir: @src/in → @src/index.ts', () => {
    const values = filterFileCandidates('src/in', tmpRoot).map((c) => c.value);
    expect(values).toContain('@src/index.ts');
  });

  it('absolute: scans the absolute dir verbatim, preserving the absolute prefix', () => {
    const values = filterFileCandidates(`${tmpRoot}/al`, '/nonexistent-cwd').map((c) => c.value);
    expect(values).toContain(`@${tmpRoot}/alpha.txt`);
  });

  it('absolute: directory entries get a trailing slash', () => {
    const values = filterFileCandidates(`${tmpRoot}/sr`, '/nonexistent-cwd').map((c) => c.value);
    expect(values).toContain(`@${tmpRoot}/src/`);
  });

  it('tilde: resolves against the injected homeDir, preserving the ~/ prefix', () => {
    const values = filterFileCandidates('~/al', '/nonexistent-cwd', tmpRoot).map((c) => c.value);
    expect(values).toContain('@~/alpha.txt');
  });

  it('tilde nested: @~/src/in → @~/src/index.ts (homeDir injected)', () => {
    const values = filterFileCandidates('~/src/in', '/nonexistent-cwd', tmpRoot).map((c) => c.value);
    expect(values).toContain('@~/src/index.ts');
  });

  it('does not re-cap at 20 — returns >20 candidates when that many files match', () => {
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(tmpRoot, `note${String(i).padStart(2, '0')}.md`), 'x');
    }
    const candidates = filterFileCandidates('note', tmpRoot);
    expect(candidates.length).toBeGreaterThan(20);
    expect(candidates.every((c) => c.value.startsWith('@'))).toBe(true);
  });

  it('is bounded by MAX_FILE_MATCHES (the single upstream cap)', () => {
    const total = MAX_FILE_MATCHES + 5;
    for (let i = 0; i < total; i++) {
      writeFileSync(join(tmpRoot, `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    expect(filterFileCandidates('f', tmpRoot)).toHaveLength(MAX_FILE_MATCHES);
  });

  it('prepends @ exactly once (no @@ double-prefix)', () => {
    const cands = filterFileCandidates('al', tmpRoot);
    expect(cands.every((c) => c.value.startsWith('@') && !c.value.startsWith('@@'))).toBe(true);
  });

  it('unreadable scan dir yields no candidates (no throw)', () => {
    expect(filterFileCandidates('/no/such/dir/x', '/nonexistent-cwd')).toEqual([]);
  });
});

describe('filterSlashCandidates', () => {
  it('returns prefix matches for a normal query', () => {
    const vals = filterSlashCandidates('config').map((c) => c.value);
    expect(vals).toContain('/config');
  });

  it('finds commands by subsequence abbreviation (cfg → /config)', () => {
    const vals = filterSlashCandidates('cfg').map((c) => c.value);
    expect(vals).toContain('/config');
  });

  it('ranks prefix matches ahead of subsequence-only matches', () => {
    const keys = filterSlashCandidates('co').map((c) => c.value.slice(1).toLowerCase());
    const firstNonPrefix = keys.findIndex((k) => !k.startsWith('co'));
    // The prefix block is contiguous at the top: once it ends, no later
    // entry may itself be a prefix match.
    if (firstNonPrefix !== -1) {
      expect(keys.slice(firstNonPrefix).every((k) => !k.startsWith('co'))).toBe(true);
    }
  });

  it('empty query returns the full command set (unchanged prefix behaviour)', () => {
    const vals = filterSlashCandidates('').map((c) => c.value);
    expect(vals.length).toBeGreaterThan(0);
    expect(vals).toContain('/config');
  });
});

describe('buildFileCandidates — pure core (no I/O)', () => {
  it('filters by leaf prefix, keeps the @ prefix, and sorts', () => {
    const entries = [dirent('beta.ts'), dirent('alpha.txt'), dirent('gamma.md')];
    const vals = buildFileCandidates(entries, 'al', tmpRoot).map((c) => c.value);
    expect(vals).toEqual(['@alpha.txt']);
  });

  it('appends a trailing slash for directory Dirents (from isDirectory), no statSync', () => {
    const entries = [dirent('src', true), dirent('readme.md')];
    const vals = buildFileCandidates(entries, '', tmpRoot).map((c) => c.value);
    expect(vals).toContain('@src/');
    expect(vals).toContain('@readme.md');
  });

  it('hides dotfiles unless the leaf prefix itself starts with a dot', () => {
    const entries = [dirent('.hidden'), dirent('visible.ts')];
    expect(buildFileCandidates(entries, '', tmpRoot).map((c) => c.value)).toEqual(['@visible.ts']);
    expect(buildFileCandidates(entries, '.h', tmpRoot).map((c) => c.value)).toEqual(['@.hidden']);
  });

  it('is bounded by MAX_FILE_MATCHES (single upstream cap, applied after sort)', () => {
    const entries: FileDirent[] = [];
    for (let i = 0; i < MAX_FILE_MATCHES + 10; i++) {
      entries.push(dirent(`f${String(i).padStart(3, '0')}.txt`));
    }
    expect(buildFileCandidates(entries, 'f', tmpRoot)).toHaveLength(MAX_FILE_MATCHES);
  });
});

describe('filterFileCandidatesAsync', () => {
  it('resolves candidates from a fresh directory scan', async () => {
    const vals = (await filterFileCandidatesAsync('al', tmpRoot)).map((c) => c.value);
    expect(vals).toContain('@alpha.txt');
  });

  it('directory entries get a trailing slash (Dirent-derived, no statSync)', async () => {
    const vals = (await filterFileCandidatesAsync('sr', tmpRoot)).map((c) => c.value);
    expect(vals).toContain('@src/');
  });

  it('fs error → empty candidates, promise does NOT reject', async () => {
    await expect(filterFileCandidatesAsync('/no/such/dir/x', '/nonexistent-cwd')).resolves.toEqual([]);
  });

  it('caches the listing: a second query against the same dir within TTL does NOT re-read fs', async () => {
    const spy = vi.spyOn(fsp, 'readdir');
    // First scan populates the cache (one readdir).
    await filterFileCandidatesAsync('al', tmpRoot);
    expect(spy).toHaveBeenCalledTimes(1);
    // Second scan of the SAME scanDir (different leaf prefix) is served from
    // cache — no additional readdir.
    const vals = (await filterFileCandidatesAsync('be', tmpRoot)).map((c) => c.value);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(vals).toContain('@beta.ts');
  });

  it('re-reads fs once the cached entry is older than the TTL', async () => {
    const spy = vi.spyOn(fsp, 'readdir');
    const now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await filterFileCandidatesAsync('al', tmpRoot);
    expect(spy).toHaveBeenCalledTimes(1);
    // Advance past the TTL — the cached entry is now stale and must be re-read.
    nowSpy.mockReturnValue(now + FILE_SCAN_TTL_MS + 1);
    await filterFileCandidatesAsync('al', tmpRoot);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('filterFileCandidatesCached — synchronous cache lookup', () => {
  it('returns null on a cold cache (miss) without reading fs', () => {
    const spy = vi.spyOn(fsp, 'readdir');
    expect(filterFileCandidatesCached('al', tmpRoot)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns candidates synchronously after the dir has been scanned (hit)', async () => {
    await filterFileCandidatesAsync('al', tmpRoot);
    const cached = filterFileCandidatesCached('be', tmpRoot);
    expect(cached).not.toBeNull();
    expect(cached!.map((c) => c.value)).toContain('@beta.ts');
  });

  it('returns null once the cached entry has expired (TTL)', async () => {
    const now = 2_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    await filterFileCandidatesAsync('al', tmpRoot);
    expect(filterFileCandidatesCached('al', tmpRoot)).not.toBeNull();
    nowSpy.mockReturnValue(now + FILE_SCAN_TTL_MS + 1);
    expect(filterFileCandidatesCached('al', tmpRoot)).toBeNull();
  });
});

describe('invalidateFileScanCache', () => {
  it('clears cached listings so the next scan re-reads fs', async () => {
    const spy = vi.spyOn(fsp, 'readdir');
    await filterFileCandidatesAsync('al', tmpRoot);
    expect(__fileScanCacheSize()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);

    invalidateFileScanCache();
    expect(__fileScanCacheSize()).toBe(0);

    await filterFileCandidatesAsync('al', tmpRoot);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('filterFileCandidates — sync path warms the shared cache', () => {
  it('a sync scan populates the cache so a later async lookup is a hit', async () => {
    filterFileCandidates('al', tmpRoot);
    const spy = vi.spyOn(fsp, 'readdir');
    // Async lookup for the same dir now hits the cache the sync call warmed.
    const vals = (await filterFileCandidatesAsync('be', tmpRoot)).map((c) => c.value);
    expect(spy).not.toHaveBeenCalled();
    expect(vals).toContain('@beta.ts');
  });
});
