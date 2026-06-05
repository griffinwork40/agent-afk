/**
 * Tests for src/cli/multi-line-reader.ts
 *
 * Focused on the pure completer — the readInput loop is wired to a fake
 * readline Interface whose `question` resolves with scripted lines.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildCompleter, readInput, fileMatchesFor, MAX_FILE_MATCHES, resolveQuery } from './multi-line-reader.js';
import { registerAll } from './slash/index.js';
import { resetRegistry } from './slash/registry.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(tmpdir(), `afk-reader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('resolveQuery', () => {
  const ROOT = '/cwd';
  const HOME = '/home/me';

  it('tilde leaf: ~/foo → scan home, leaf foo, display ~/', () => {
    expect(resolveQuery('~/foo', ROOT, HOME)).toEqual({
      scanDir: HOME,
      leafPrefix: 'foo',
      displayPrefix: '~/',
    });
  });

  it('tilde slash only: ~/ → scan home, empty leaf', () => {
    expect(resolveQuery('~/', ROOT, HOME)).toEqual({
      scanDir: HOME,
      leafPrefix: '',
      displayPrefix: '~/',
    });
  });

  it('bare tilde: ~ → scan home, empty leaf', () => {
    expect(resolveQuery('~', ROOT, HOME)).toEqual({
      scanDir: HOME,
      leafPrefix: '',
      displayPrefix: '~/',
    });
  });

  it('tilde nested: ~/foo/bar → scan home/foo, leaf bar, display ~/foo/', () => {
    expect(resolveQuery('~/foo/bar', ROOT, HOME)).toEqual({
      scanDir: join(HOME, 'foo'),
      leafPrefix: 'bar',
      displayPrefix: '~/foo/',
    });
  });

  it('absolute leaf: /etc/ssh → scan /etc/, leaf ssh, display /etc/', () => {
    expect(resolveQuery('/etc/ssh', ROOT, HOME)).toEqual({
      scanDir: '/etc/',
      leafPrefix: 'ssh',
      displayPrefix: '/etc/',
    });
  });

  it('absolute slash only: /etc/ → scan /etc/, empty leaf', () => {
    expect(resolveQuery('/etc/', ROOT, HOME)).toEqual({
      scanDir: '/etc/',
      leafPrefix: '',
      displayPrefix: '/etc/',
    });
  });

  it('absolute root: / → scan /, empty leaf', () => {
    expect(resolveQuery('/', ROOT, HOME)).toEqual({
      scanDir: '/',
      leafPrefix: '',
      displayPrefix: '/',
    });
  });

  it('relative subdir: src/index → scan join(root,src), leaf index, display src/', () => {
    expect(resolveQuery('src/index', ROOT, HOME)).toEqual({
      scanDir: join(ROOT, 'src'),
      leafPrefix: 'index',
      displayPrefix: 'src/',
    });
  });

  it('relative dir only: src/ → scan join(root,src), empty leaf', () => {
    expect(resolveQuery('src/', ROOT, HOME)).toEqual({
      scanDir: join(ROOT, 'src'),
      leafPrefix: '',
      displayPrefix: 'src/',
    });
  });

  it('bare leaf: beta → scan root, leaf beta, empty display', () => {
    expect(resolveQuery('beta', ROOT, HOME)).toEqual({
      scanDir: ROOT,
      leafPrefix: 'beta',
      displayPrefix: '',
    });
  });

  it('empty query: "" → scan root, empty leaf, empty display', () => {
    expect(resolveQuery('', ROOT, HOME)).toEqual({
      scanDir: ROOT,
      leafPrefix: '',
      displayPrefix: '',
    });
  });

  it('defaults homeDir to os.homedir() when omitted (smoke — no throw)', () => {
    const out = resolveQuery('~/x', ROOT);
    expect(out.displayPrefix).toBe('~/');
    expect(out.leafPrefix).toBe('x');
    // scanDir is the real home; just assert it is absolute and non-empty.
    expect(out.scanDir.length).toBeGreaterThan(0);
  });
});

describe('buildCompleter — slash completion', () => {
  it('returns all matching slash names when line starts with /', () => {
    const completer = buildCompleter(tmpRoot);
    const [hits] = completer('/c');
    expect(hits).toContain('/cost');
    expect(hits).toContain('/clear');
    expect(hits).toContain('/compact');
  });

  it('narrows as prefix lengthens', () => {
    const completer = buildCompleter(tmpRoot);
    const [hits] = completer('/co');
    expect(hits.every((h) => h.startsWith('/co'))).toBe(true);
  });

  it('returns empty when no slash matches', () => {
    const completer = buildCompleter(tmpRoot);
    const [hits] = completer('/zzz');
    expect(hits).toEqual([]);
  });
});

describe('buildCompleter — @-file completion', () => {
  it('lists matching files when last token starts with @', () => {
    const completer = buildCompleter(tmpRoot);
    const [hits, matched] = completer('read @al');
    expect(hits).toContain('@alpha.txt');
    expect(matched).toBe('@al');
  });

  it('appends trailing / on directory matches', () => {
    const completer = buildCompleter(tmpRoot);
    const [hits] = completer('@sr');
    expect(hits).toContain('@src/');
  });

  it('drills into subdirectories via @dir/prefix', () => {
    const completer = buildCompleter(tmpRoot);
    const [hits] = completer('@src/in');
    expect(hits).toContain('@src/index.ts');
  });

  it('completes absolute-path prefixes verbatim, bypassing rootDir', () => {
    // cwd is bogus on purpose — absolute scanning must ignore it.
    const completer = buildCompleter('/nonexistent-cwd');
    const [hits, matched] = completer('@' + tmpRoot + '/al');
    expect(hits).toContain('@' + tmpRoot + '/alpha.txt');
    expect(matched).toBe('@' + tmpRoot + '/al');
  });

  it('appends trailing / on absolute directory matches', () => {
    const completer = buildCompleter('/nonexistent-cwd');
    const [hits] = completer('@' + tmpRoot + '/sr');
    expect(hits).toContain('@' + tmpRoot + '/src/');
  });

  it('returns empty on non-@, non-slash input', () => {
    const completer = buildCompleter(tmpRoot);
    const [hits] = completer('hello world');
    expect(hits).toEqual([]);
  });
});

describe('fileMatchesFor — completeness and ordering', () => {
  it('returns matches sorted by entry name (dirs decorated with a trailing /)', () => {
    // A directory whose name is a string-prefix of a sibling file must sort
    // adjacent to that file by NAME — e.g. `box/` immediately before
    // `box-helper.txt` — even though the decorated relPaths (`box/` vs
    // `box-helper.txt`) are not in raw string order (`-` < `/`). Comparing on
    // the slash-stripped name is the invariant fileMatchesFor actually holds.
    mkdirSync(join(tmpRoot, 'box'));
    writeFileSync(join(tmpRoot, 'box-helper.txt'), 'x');
    const matches = fileMatchesFor('box', tmpRoot);
    // Mirror the implementation: default .sort() on the slash-stripped names
    // (UTF-16 code-unit order, NOT localeCompare).
    const byName = [...matches].sort((a, b) => {
      const an = a.replace(/\/$/, '');
      const bn = b.replace(/\/$/, '');
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    expect(matches).toEqual(byName);
    expect(matches).toEqual(['box/', 'box-helper.txt']);
  });

  it('surfaces all entries when the count exceeds the legacy 12/20 dropdown caps', () => {
    // Regression: the dropdown pipeline used to re-cap file candidates to 12,
    // hiding common folders like src/ and tests/ in any cwd with >12 entries.
    // With 18 prefixed files (>12 and >0 dotfiles) every one must be reachable.
    for (let i = 0; i < 18; i++) {
      writeFileSync(join(tmpRoot, `pick${String(i).padStart(2, '0')}.txt`), 'x');
    }
    const matches = fileMatchesFor('pick', tmpRoot);
    expect(matches).toHaveLength(18);
    expect(matches).toContain('pick17.txt');
  });

  it('sorts BEFORE capping at MAX_FILE_MATCHES (not an arbitrary readdir-order subset)', () => {
    // Create more than MAX_FILE_MATCHES uniquely-prefixed files. readdirSync
    // returns them in unspecified OS order; the prior code capped mid-scan and
    // sorted afterward, so it kept an arbitrary subset. The fix sorts first,
    // so the result MUST be exactly the lexicographically-smallest N.
    const total = MAX_FILE_MATCHES + 10;
    for (let i = 0; i < total; i++) {
      writeFileSync(join(tmpRoot, `cap${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const matches = fileMatchesFor('cap', tmpRoot);
    expect(matches).toHaveLength(MAX_FILE_MATCHES);
    expect(matches[0]).toBe('cap000.txt');
    expect(matches[MAX_FILE_MATCHES - 1]).toBe(`cap${String(MAX_FILE_MATCHES - 1).padStart(3, '0')}.txt`);
    // The entry just past the cap must be absent, and the set must be sorted.
    expect(matches).not.toContain(`cap${String(MAX_FILE_MATCHES).padStart(3, '0')}.txt`);
    expect(matches).toEqual([...matches].sort());
  });

  it('still hides dotfiles unless the leaf prefix opts in with a dot', () => {
    writeFileSync(join(tmpRoot, '.hidden'), 'x');
    expect(fileMatchesFor('', tmpRoot)).not.toContain('.hidden');
    expect(fileMatchesFor('.h', tmpRoot)).toContain('.hidden');
  });
});

describe('readInput — multi-line continuation', () => {
  /** Build a fake readline interface that scripts queued lines via the 'line' event. */
  function makeFakeRl(queue: string[], prompts: string[] = []) {
    let currentPrompt = '';
    return {
      setPrompt: (p: string) => { currentPrompt = p; prompts.push(p); },
      prompt: () => { /* noop — tests don't care about prompt output */ void currentPrompt; },
      once: (event: string, cb: (s: string) => void) => {
        if (event === 'line') {
          // Resolve synchronously on the next microtask so the await unblocks.
          queueMicrotask(() => cb(queue.shift()!));
        }
      },
    } as unknown as Parameters<typeof readInput>[0]['rl'];
  }

  it('returns a single-line input directly', async () => {
    const rl = makeFakeRl(['hello']);
    const out = await readInput({ rl, promptFn: () => '> ' });
    expect(out).toBe('hello');
  });

  it('concatenates when line ends with backslash', async () => {
    const rl = makeFakeRl(['first \\', 'second \\', 'third']);
    const out = await readInput({ rl, promptFn: () => '> ' });
    expect(out).toBe('first \nsecond \nthird');
  });

  it('switches to continuation prompt after first \\', async () => {
    const prompts: string[] = [];
    const rl = makeFakeRl(['first \\', 'second'], prompts);
    const promptFn = vi.fn().mockReturnValue('main> ');
    await readInput({ rl, promptFn, continuationPrompt: 'cont> ' });
    expect(prompts[0]).toBe('main> ');
    expect(prompts[1]).toBe('cont> ');
  });
});
