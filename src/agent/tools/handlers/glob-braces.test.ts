import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { expandGlobBraces } from './glob-braces.js';
import { splitAbsolutePattern } from './glob-absolute.js';
import { createGlobHandler } from './glob.js';
import { _resetReadDenylistCacheForTests } from './read-denylist.js';

const signal = () => new AbortController().signal;

describe('bounded brace expansion', () => {
  it.each([
    ['*.{ts,tsx}', ['*.ts', '*.tsx']],
    ['{src,lib}/**/*.{ts,{tsx,js}}', ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.js', 'lib/**/*.ts', 'lib/**/*.tsx', 'lib/**/*.js']],
    ['{src/,}**/*.ts', ['src/**/*.ts', '**/*.ts']],
    ['{**,src}/*.ts', ['**/*.ts', 'src/*.ts']],
    ['{{a,b}}', ['{a}', '{b}']],
    ['{a,a}', ['a']],
    ['{name}/x.ts', ['{name}/x.ts']],
    ['{1..3}.ts', ['{1..3}.ts']],
    ['{a,b', ['{a,b']],
    ['a,b}', ['a,b}']],
    ['{x,{a,b}', ['{x,{a,b}']],
    ['{a,b}}', ['{a,b}}']],
  ])('expands %s', (pattern, expected) => {
    expect(expandGlobBraces(pattern as string)).toEqual(expected);
  });

  it('rejects excessive fanout without silently truncating', () => {
    expect(expandGlobBraces('{a,b}'.repeat(8))).toHaveLength(256);
    expect(() => expandGlobBraces('{a,b}'.repeat(9))).toThrow('Brace expansion exceeds limit');
  });

  it('bounds aggregate expansion size', () => {
    expect(() => expandGlobBraces('x'.repeat(40_000) + '{a,b}')).toThrow('Brace expansion exceeds limit');
  });
});

describe('glob brace integration', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-braces-'));
    const files = ['root.ts', 'view.tsx', 'no.js', 'src/direct.ts', 'src/deep/nested.tsx', 'lib/index.ts',
      '{literal}/file.ts', '{a,b/file.ts', 'node_modules/pkg/vendor.ts', '.afk-worktrees/copy/work.ts'];
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), 'needle');
    }
  });
  afterEach(async () => {
    delete process.env['AFK_READ_DENYLIST'];
    _resetReadDenylistCacheForTests();
    await fs.rm(root, { recursive: true, force: true });
  });
  const lines = (content: string) => content.split('\n').sort();

  it('matches .ts/.tsx at zero and deeper globstar depths, excluding other extensions', async () => {
    const result = await createGlobHandler(root)({ pattern: '**/*.{ts,tsx}' }, signal());
    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual(['root.ts', 'view.tsx', 'src/direct.ts', 'src/deep/nested.tsx', 'lib/index.ts', '{literal}/file.ts', '{a,b/file.ts'].sort());
  });

  it('expands directory alternatives and nested extension lists', async () => {
    const result = await createGlobHandler(root)({ pattern: '{src,lib}/**/*.{ts,{tsx,js}}' }, signal());
    expect(lines(result.content)).toEqual(['lib/index.ts', 'src/deep/nested.tsx', 'src/direct.ts']);
  });

  it('recognizes globstar boundaries introduced by expansion', async () => {
    const result = await createGlobHandler(root)({ pattern: '{**,src}/*.ts' }, signal());
    expect(result.content).toContain('root.ts');
    expect(result.content).toContain('lib/index.ts');
    expect(result.content.split('\n').filter((line) => line === 'src/direct.ts')).toHaveLength(1);
  });

  it('supports empty arms and normalizes Windows separators', async () => {
    const result = await createGlobHandler(root)({ pattern: '{src\\,}**\\*.{ts,tsx}' }, signal());
    expect(result.content).toContain('root.ts');
    expect(result.content).toContain('src/deep/nested.tsx');
  });

  it.each(['{literal}/**/*.ts', '{a,b/**/*.ts'])('keeps literal brace directories: %s', async (pattern) => {
    const result = await createGlobHandler(root)({ pattern }, signal());
    expect(result.content).toBe(pattern.startsWith('{literal}') ? '{literal}/file.ts' : '{a,b/file.ts');
  });

  it('allows literal comma-brace paths via the explicit base path', async () => {
    await fs.mkdir(path.join(root, '{one,two}'));
    await fs.writeFile(path.join(root, '{one,two}', 'file.ts'), '');
    const result = await createGlobHandler(root)({ pattern: '*.ts', path: path.join(root, '{one,two}') }, signal());
    expect(result.content).toBe('file.ts');
  });

  it('opts into default-pruned directories named in a brace arm', async () => {
    const result = await createGlobHandler(root)({ pattern: '{src,node_modules,.afk-worktrees}/**/*.ts' }, signal());
    expect(lines(result.content)).toEqual(['.afk-worktrees/copy/work.ts', 'node_modules/pkg/vendor.ts', 'src/direct.ts']);
  });

  it('cannot bypass descendant denylist protection with an explicit brace arm', async () => {
    process.env['AFK_READ_DENYLIST'] = path.join(root, 'lib');
    _resetReadDenylistCacheForTests();
    const result = await createGlobHandler(root)({ pattern: '{src,lib}/**/*.ts' }, signal());
    expect(result.content).toBe('src/direct.ts');
  });

  it('handles absolute braces before the first wildcard and reports absolute paths', async () => {
    const result = await createGlobHandler(root)({ pattern: `${root}/{src,lib}/**/*.ts` }, signal());
    expect(result.isError).toBeUndefined();
    expect(lines(result.content)).toEqual([path.join(root, 'lib/index.ts'), path.join(root, 'src/direct.ts')].sort());
  });

  it('handles absolute alternatives containing separators', async () => {
    const result = await createGlobHandler(root)({ pattern: `${root}/{src/deep,lib}/*.{ts,tsx}` }, signal());
    expect(lines(result.content)).toEqual([path.join(root, 'lib/index.ts'), path.join(root, 'src/deep/nested.tsx')].sort());
  });

  it('keeps singleton wrappers around nested alternatives in absolute pattern-space', async () => {
    await fs.mkdir(path.join(root, '{wrapper', 'src}'), { recursive: true });
    await fs.writeFile(path.join(root, '{wrapper', 'src}', 'file.ts'), '');
    const result = await createGlobHandler(root)({ pattern: `${root}/{wrapper/{src,lib}}/*.ts` }, signal());
    expect(result.content).toBe(path.join(root, '{wrapper', 'src}', 'file.ts'));
  });

  it('does not reinterpret unbalanced absolute prefixes after splitting', async () => {
    await fs.mkdir(path.join(root, '{broken', 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, '{broken', 'nested', '{a,b}.ts'), '');
    const result = await createGlobHandler(root)({ pattern: `${root}/{broken/*/{a,b}.ts` }, signal());
    expect(result.content).toBe(path.join(root, '{broken', 'nested', '{a,b}.ts'));
  });

  it('preserves absolute-pattern explicit-path conflicts', async () => {
    const result = await createGlobHandler(root)({ pattern: `${root}/{src,lib}/**/*.ts`, path: root }, signal());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('conflicts with explicit path');
  });

  it('containment-checks the common literal prefix of absolute alternatives', async () => {
    const result = await createGlobHandler(root)(
      { pattern: `${root}/{src,lib}/**/*.ts` }, signal(),
      { resolveBase: root, readRoots: [path.join(root, 'src')] },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('outside');
  });

  it('retains the truthful no-match message for supported alternatives', async () => {
    const pattern = '**/*.{missing,absent}';
    const result = await createGlobHandler(root)({ pattern }, signal());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(`No files matched pattern '${pattern}' in ${root}`);
  });

  it('reports expansion overflow as an error, not no matches', async () => {
    const result = await createGlobHandler(root)({ pattern: '{a,b}'.repeat(9) }, signal());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Brace expansion exceeds limit');
    expect(result.content).not.toContain('No files matched');
  });

  it('keeps one global cap with overlapping alternatives', async () => {
    await fs.mkdir(path.join(root, 'many'));
    await Promise.all(Array.from({ length: 505 }, (_, i) => fs.writeFile(path.join(root, 'many', `${i}.ts`), '')));
    const result = await createGlobHandler(root)({ pattern: 'many/*.{ts,ts}' }, signal());
    expect(result.content.split('\n')).toHaveLength(501);
    expect(result.content).toContain('[results capped at 500 entries]');
  });
});

describe('absolute brace prefix recognition', () => {
  it.each([
    ['/tmp/{src,lib}/**/*.ts', '/tmp', '{src,lib}/**/*.ts'],
    ['/tmp/{src/deep,lib}/*.ts', '/tmp', '{src/deep,lib}/*.ts'],
    ['/tmp/{literal}/file.ts', '/tmp/{literal}', 'file.ts'],
    ['/tmp/{wrapper/{src,lib}}/*.ts', '/tmp', '{wrapper/{src,lib}}/*.ts'],
    ['/tmp/{a,b/file.ts', '/tmp/{a,b', 'file.ts'],
  ])('splits %s consistently with expansion', (pattern, base, rest) => {
    expect(splitAbsolutePattern(pattern)).toEqual({ base: path.normalize(base), pattern: rest });
  });

  it('recognizes Windows brace alternatives without treating backslash as escape', () => {
    expect(splitAbsolutePattern('C:\\repo\\{src,lib}\\**\\*.ts', path.win32)).toEqual({
      base: path.win32.normalize('C:/repo'), pattern: '{src,lib}/**/*.ts',
    });
  });
});
