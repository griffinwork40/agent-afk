/**
 * Tests for absolute-pattern globbing and .afk-worktrees pruning.
 *
 * Run with: pnpm test src/agent/tools/handlers/glob-absolute.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createGlobHandler, globHandler } from './glob.js';
import { splitAbsolutePattern } from './glob-absolute.js';

const signal = () => new AbortController().signal;

describe('splitAbsolutePattern', () => {
  it('returns null for relative patterns', () => {
    expect(splitAbsolutePattern('src/**/*.ts')).toBeNull();
    expect(splitAbsolutePattern('*.md')).toBeNull();
  });

  it('splits at the first segment containing a metacharacter', () => {
    expect(splitAbsolutePattern('/tmp/repo/src/foo*')).toEqual({
      base: path.normalize('/tmp/repo/src'),
      pattern: 'foo*',
    });
    expect(splitAbsolutePattern('/tmp/repo/**/*.ts')).toEqual({
      base: path.normalize('/tmp/repo'),
      pattern: '**/*.ts',
    });
  });

  it('treats a metacharacter-free absolute path as parent + basename', () => {
    expect(splitAbsolutePattern('/tmp/repo/README.md')).toEqual({
      base: path.normalize('/tmp/repo'),
      pattern: 'README.md',
    });
  });

  it('handles a pattern directly under the filesystem root', () => {
    expect(splitAbsolutePattern('/*.txt')).toEqual({ base: path.normalize('/'), pattern: '*.txt' });
  });
});

describe('glob handler — absolute patterns', () => {
  let cwdDir: string;
  let otherDir: string;

  beforeEach(async () => {
    cwdDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-abs-cwd-'));
    otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-abs-other-'));
    await fs.writeFile(path.join(cwdDir, 'local.ts'), '');
    await fs.mkdir(path.join(otherDir, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(otherDir, 'src', 'target-one.ts'), '');
    await fs.writeFile(path.join(otherDir, 'src', 'deep', 'target-two.ts'), '');
  });

  afterEach(async () => {
    await fs.rm(cwdDir, { recursive: true, force: true });
    await fs.rm(otherDir, { recursive: true, force: true });
  });

  it('matches an absolute pattern outside the cwd and returns absolute paths', async () => {
    const handler = createGlobHandler(cwdDir);
    const result = await handler({ pattern: `${otherDir}/src/target-*` }, signal());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(path.join(otherDir, 'src', 'target-one.ts'));
  });

  it('supports globstar after the literal prefix', async () => {
    const handler = createGlobHandler(cwdDir);
    const result = await handler({ pattern: `${otherDir}/**/*.ts` }, signal());
    const lines = String(result.content).split('\n').sort();
    expect(lines).toEqual([
      path.join(otherDir, 'src', 'deep', 'target-two.ts'),
      path.join(otherDir, 'src', 'target-one.ts'),
    ]);
  });

  it('resolves a metacharacter-free absolute path to that file', async () => {
    const handler = createGlobHandler(cwdDir);
    const file = path.join(otherDir, 'src', 'target-one.ts');
    const result = await handler({ pattern: file }, signal());
    expect(result.content).toBe(file);
  });

  it('does not walk the cwd for an absolute pattern (no cwd files leak in)', async () => {
    const handler = createGlobHandler(cwdDir);
    const result = await handler({ pattern: `${otherDir}/**/*` }, signal());
    expect(result.content).not.toContain('local.ts');
  });

  it('reports the original pattern when nothing matches', async () => {
    const handler = createGlobHandler(cwdDir);
    const pattern = `${otherDir}/src/nope-*`;
    const result = await handler({ pattern }, signal());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`No files matched pattern '${pattern}'`);
  });

  it('errors (fast) when the literal prefix does not exist', async () => {
    const handler = createGlobHandler(cwdDir);
    const result = await handler({ pattern: `${otherDir}/missing-dir/*.ts` }, signal());
    expect(result.isError).toBe(true);
  });
});

describe('glob handler — .afk-worktrees pruning', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-wt-'));
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'a.ts'), '');
    await fs.mkdir(path.join(tempDir, '.afk-worktrees', 'wt1', 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.afk-worktrees', 'wt1', 'src', 'a.ts'), '');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('skips .afk-worktrees by default', async () => {
    const result = await globHandler({ pattern: '**/*.ts', path: tempDir }, signal());
    expect(result.content).toBe('src/a.ts');
  });

  it('searches .afk-worktrees when named literally in the pattern', async () => {
    const result = await globHandler({ pattern: '.afk-worktrees/**/*.ts', path: tempDir }, signal());
    expect(result.content).toBe('.afk-worktrees/wt1/src/a.ts');
  });

  it('searches inside a worktree when it is the base path itself', async () => {
    const base = path.join(tempDir, '.afk-worktrees', 'wt1');
    const result = await globHandler({ pattern: '**/*.ts', path: base }, signal());
    expect(result.content).toBe('src/a.ts');
  });
});
