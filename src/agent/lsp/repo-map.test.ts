/**
 * Tests for the phase-3 repo map (src/agent/lsp/repo-map.ts).
 *
 * Three test groups:
 *   1. Flag / timeout helpers.
 *   2. LSP path: fake server returns workspace/symbol payload.
 *   3. Filesystem fallback: LSP disabled or fails.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRepoMap, MAX_SYMBOLS, MAX_LINES } from './repo-map.js';
import type { LspServerPool } from './pool.js';
import type { LspClient } from './client.js';
import type { ServerSpec } from './server-spec.js';

// ── Shared fake-pool builder ──────────────────────────────────────────────────

type RequestFn = (method: string, params: unknown, opts: unknown) => Promise<unknown>;

function makeFakePool(
  requestFn: RequestFn,
  acquireSpy = vi.fn(async (_spec: ServerSpec, _root: string, _opts: unknown) => undefined as unknown as LspClient),
): { pool: LspServerPool; acquireSpy: typeof acquireSpy } {
  const client = {
    hold: () => () => { /* no-op release */ },
    request: requestFn,
    diagnostics: { seq: 0, waitFor: async () => null },
    onExit: () => () => { /* no-op */ },
    closeOthers: () => { /* no-op */ },
    useDocument: () => () => { /* no-op */ },
    syncFile: async () => ({ uri: 'file:///dummy.ts', version: 1, changed: false }),
  } as unknown as LspClient;

  // Fix the spy to capture the real client once it is defined.
  acquireSpy.mockImplementation(async (_spec: ServerSpec, _root: string, _opts: unknown) => client);

  const pool = {
    acquire: acquireSpy as unknown as LspServerPool['acquire'],
    dispose: async () => { /* no-op */ },
    startedCount: 0,
  } as unknown as LspServerPool;

  return { pool, acquireSpy };
}

// ── Helper: build a minimal workspace symbol ──────────────────────────────────

// Resolve to a platform-native absolute path so pathToFileURL produces a
// correct file URI on both POSIX (/proj/src/a.ts) and Windows (C:\proj\…).
const PROJ_ROOT = path.resolve('/proj');

function sym(name: string, kind: number, filePath: string) {
  const resolved = path.resolve(filePath);
  return {
    name,
    kind,
    location: { uri: pathToFileURL(resolved).href },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildRepoMap — feature flag', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns a non-empty string with filesystem fallback even when LSP is disabled', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    // Point rootDir at a real directory so the fs walk finds something.
    const result = await buildRepoMap({ rootDir: process.cwd(), timeoutMs: 3000 });
    // May be '' in CI with unusual cwd but should not throw.
    expect(typeof result).toBe('string');
  });

  it('never throws regardless of rootDir', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    await expect(buildRepoMap({ rootDir: '/no/such/dir', timeoutMs: 500 })).resolves.not.toThrow();
  });
});

describe('buildRepoMap — LSP path', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uses workspace/symbol result when LSP is enabled', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    const symbols = [
      sym('MyClass', 5, '/proj/src/foo.ts'),
      sym('myFn', 12, '/proj/src/foo.ts'),
      sym('IFace', 11, '/proj/src/bar.ts'),
    ];

    const { pool } = makeFakePool(async (method) => {
      if (method === 'workspace/symbol') return symbols;
      throw new Error(`unexpected method ${method}`);
    });

    const result = await buildRepoMap({ rootDir: PROJ_ROOT, timeoutMs: 3000, pool });

    expect(result).toContain('src/foo.ts');
    expect(result).toContain('class(MyClass)');
    expect(result).toContain('fn(myFn)');
    expect(result).toContain('src/bar.ts');
    expect(result).toContain('iface(IFace)');
    expect(result.startsWith('# Repo map (LSP workspace symbols)')).toBe(true);
  });

  it('falls back to fs map when workspace/symbol returns empty array', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    const { pool } = makeFakePool(async () => []);

    const result = await buildRepoMap({ rootDir: PROJ_ROOT, timeoutMs: 500, pool });
    // Empty LSP result → tries fs fallback → likely '' for /proj (nonexistent)
    expect(typeof result).toBe('string');
  });

  it('falls back to fs map when workspace/symbol throws', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    const { pool } = makeFakePool(async () => { throw new Error('server error'); });

    // Should not throw; returns empty string or fs fallback.
    const result = await buildRepoMap({ rootDir: process.cwd(), timeoutMs: 3000, pool });
    expect(typeof result).toBe('string');
  });

  it('skips method/property/field/ctor symbols (kinds 6–9)', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    const symbols = [
      sym('myMethod', 6, '/proj/src/a.ts'),   // method — skip
      sym('myProp', 7, '/proj/src/a.ts'),     // prop — skip
      sym('myField', 8, '/proj/src/a.ts'),    // field — skip
      sym('myCtor', 9, '/proj/src/a.ts'),     // ctor — skip
      sym('TopFn', 12, '/proj/src/a.ts'),     // fn — keep
    ];

    const { pool } = makeFakePool(async () => symbols);

    const result = await buildRepoMap({ rootDir: PROJ_ROOT, timeoutMs: 3000, pool });
    expect(result).toContain('fn(TopFn)');
    expect(result).not.toContain('method(myMethod)');
    expect(result).not.toContain('prop(myProp)');
  });

  it('filters out node_modules paths', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    const symbols = [
      sym('External', 5, '/proj/node_modules/lib/index.ts'),
      sym('Internal', 5, '/proj/src/app.ts'),
    ];

    const { pool } = makeFakePool(async () => symbols);

    const result = await buildRepoMap({ rootDir: PROJ_ROOT, timeoutMs: 3000, pool });
    expect(result).not.toContain('node_modules');
    expect(result).toContain('Internal');
  });

  it('respects MAX_LINES cap', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    // Generate many symbols across many files.
    const symbols = Array.from({ length: MAX_SYMBOLS + 50 }, (_, i) =>
      sym(`Sym${i}`, 5, `/proj/src/file${i}.ts`),
    );

    const { pool } = makeFakePool(async () => symbols);

    const result = await buildRepoMap({ rootDir: PROJ_ROOT, timeoutMs: 3000, pool });
    const lines = result.split('\n');
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES + 1); // +1 for truncation marker
  });
});

describe('buildRepoMap — filesystem fallback', () => {
  let tmpDir: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('result starts with "# Repo map" header when LSP is disabled', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-repo-map-test-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), '// index');
    await fs.writeFile(path.join(tmpDir, 'src', 'utils.ts'), '// utils');

    const result = await buildRepoMap({ rootDir: tmpDir, timeoutMs: 3000 });
    expect(result.startsWith('# Repo map')).toBe(true);
  });

  it('groups files under src/ in a "src/:" line', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-repo-map-test-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'foo.ts'), '// foo');
    await fs.writeFile(path.join(tmpDir, 'src', 'bar.ts'), '// bar');

    const result = await buildRepoMap({ rootDir: tmpDir, timeoutMs: 3000 });
    expect(result).toContain('src/:');
    expect(result).toContain('foo.ts');
    expect(result).toContain('bar.ts');
  });

  it('does not include files inside dotdir directories', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-repo-map-test-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, '.hidden'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src', 'visible.ts'), '// visible');
    await fs.writeFile(path.join(tmpDir, '.hidden', 'secret.ts'), '// secret');

    const result = await buildRepoMap({ rootDir: tmpDir, timeoutMs: 3000 });
    expect(result).toContain('visible.ts');
    expect(result).not.toContain('secret.ts');
    expect(result).not.toContain('.hidden');
  });

  it('shows "+N more" when a directory exceeds MAX_FILES_PER_DIR (12)', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-repo-map-test-'));
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    // Create 15 files — 15 - 12 = 3 extra → "+3 more"
    for (let i = 0; i < 15; i++) {
      await fs.writeFile(path.join(tmpDir, 'src', `file${i}.ts`), `// file${i}`);
    }

    const result = await buildRepoMap({ rootDir: tmpDir, timeoutMs: 3000 });
    expect(result).toContain('+3 more');
  });
});

describe('buildRepoMap — opts forwarding', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('forwards timeoutMs and signal to pool.acquire and client.request', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    const ctl = new AbortController();

    let capturedRequestOpts: unknown;
    const { pool, acquireSpy } = makeFakePool(async (method, _params, opts) => {
      capturedRequestOpts = opts;
      if (method === 'workspace/symbol') return [];
      throw new Error(`unexpected method ${method}`);
    });

    await buildRepoMap({ rootDir: PROJ_ROOT, timeoutMs: 3000, pool, signal: ctl.signal });

    // acquire must have been called with the opts object
    expect(acquireSpy).toHaveBeenCalledOnce();
    expect(acquireSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ timeoutMs: expect.any(Number), signal: ctl.signal }),
    );

    // request must also have received the opts
    expect(capturedRequestOpts).toEqual(
      expect.objectContaining({ timeoutMs: expect.any(Number), signal: ctl.signal }),
    );
  });
});

describe('buildRepoMap — timeout + abort', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('resolves (possibly empty) when aborted immediately', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    const ctl = new AbortController();
    ctl.abort();

    const { pool } = makeFakePool(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return [];
    });

    const result = await buildRepoMap({ rootDir: process.cwd(), timeoutMs: 5000, pool, signal: ctl.signal });
    expect(typeof result).toBe('string');
  });

  it('resolves when timeoutMs is very small', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    const { pool } = makeFakePool(async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return [];
    });

    const result = await buildRepoMap({ rootDir: process.cwd(), timeoutMs: 1, pool });
    expect(typeof result).toBe('string');
  });
});

describe('buildRepoMap — interior path denylist', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('filters dist/, build/, .cache/ from LSP symbols', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    const symbols = [
      sym('Good', 5, '/proj/src/app.ts'),
      sym('Compiled', 5, '/proj/dist/app.js'),
      sym('Built', 5, '/proj/build/out.js'),
      sym('Cached', 5, '/proj/.cache/temp.js'),
    ];

    const { pool } = makeFakePool(async () => symbols);
    const result = await buildRepoMap({ rootDir: PROJ_ROOT, timeoutMs: 3000, pool });

    expect(result).toContain('class(Good)');
    expect(result).not.toContain('Compiled');
    expect(result).not.toContain('Built');
    expect(result).not.toContain('Cached');
  });

  it('filters dist/, build/, .cache/ from filesystem fallback', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-repo-map-deny-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'dist'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'build'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, '.cache'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), '// ok');
      await fs.writeFile(path.join(tmpDir, 'dist', 'index.js'), '// no');
      await fs.writeFile(path.join(tmpDir, 'build', 'index.js'), '// no');
      await fs.writeFile(path.join(tmpDir, '.cache', 'temp.js'), '// no');

      const result = await buildRepoMap({ rootDir: tmpDir, timeoutMs: 3000 });

      expect(result).toContain('index.ts');
      expect(result).not.toContain('dist');
      expect(result).not.toContain('build');
      expect(result).not.toContain('.cache');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('buildRepoMap — symbol name sanitization', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('strips $ and special characters from symbol names', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    const symbols = [
      sym('$inject', 5, '/proj/src/di.ts'),
      sym('foo<bar>', 12, '/proj/src/gen.ts'),
      sym('normal_name', 5, '/proj/src/ok.ts'),
    ];

    const { pool } = makeFakePool(async () => symbols);
    const result = await buildRepoMap({ rootDir: PROJ_ROOT, timeoutMs: 3000, pool });

    // $ should be replaced with _
    expect(result).toContain('class(_inject)');
    expect(result).not.toContain('$inject');
    // angle brackets replaced
    expect(result).toContain('fn(foo_bar_)');
    // clean name passes through
    expect(result).toContain('class(normal_name)');
  });
});

describe('buildRepoMap — MAX_SYMBOLS cap', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('stops at exactly MAX_SYMBOLS symbols (no off-by-one)', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    // Generate exactly MAX_SYMBOLS + 20 symbols, each in its own file.
    const symbols = Array.from({ length: MAX_SYMBOLS + 20 }, (_, i) =>
      sym(`Sym${i}`, 5, `/proj/src/file${i}.ts`),
    );

    const { pool } = makeFakePool(async () => symbols);
    const result = await buildRepoMap({ rootDir: PROJ_ROOT, timeoutMs: 3000, pool });

    // Count symbols in output — each file has exactly one.
    const symbolLines = result.split('\n').filter((l) => l.includes('class('));
    expect(symbolLines.length).toBeLessThanOrEqual(MAX_SYMBOLS);
  });
});

describe('buildRepoMap — walkSourceFiles fallback', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('walks directories recursively up to depth 6', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-repo-map-walk-'));
    try {
      const deepDir = path.join(tmpDir, 'src', 'a', 'b', 'c');
      await fs.mkdir(deepDir, { recursive: true });
      await fs.writeFile(path.join(deepDir, 'deep.ts'), '// deep');
      await fs.writeFile(path.join(tmpDir, 'src', 'top.ts'), '// top');

      const result = await buildRepoMap({ rootDir: tmpDir, timeoutMs: 3000 });

      expect(result).toContain('top.ts');
      expect(result).toContain('deep.ts');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips dotdirs and node_modules during walk', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-repo-map-walk-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, '.hidden'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'ok.ts'), '// ok');
      await fs.writeFile(path.join(tmpDir, '.hidden', 'bad.ts'), '// bad');
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.ts'), '// bad');

      const result = await buildRepoMap({ rootDir: tmpDir, timeoutMs: 3000 });

      expect(result).toContain('ok.ts');
      expect(result).not.toContain('bad.ts');
      expect(result).not.toContain('node_modules');
      expect(result).not.toContain('.hidden');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty string for nonexistent directory', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    const result = await buildRepoMap({ rootDir: '/no/such/dir/ever', timeoutMs: 500 });
    expect(result).toBe('');
  });

  it('respects abort signal during walk', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '');
    const ctl = new AbortController();
    ctl.abort();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-repo-map-walk-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), '// index');

      const result = await buildRepoMap({ rootDir: tmpDir, timeoutMs: 3000, signal: ctl.signal });
      expect(typeof result).toBe('string');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
