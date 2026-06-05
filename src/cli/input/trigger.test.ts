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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectTrigger, filterFileCandidates } from './trigger.js';
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
  resetRegistry();
  registerAll();
});

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

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
