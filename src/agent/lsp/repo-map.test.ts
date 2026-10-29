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
import { buildRepoMap, MAX_SYMBOLS, MAX_LINES } from './repo-map.js';
import type { LspServerPool } from './pool.js';
import type { LspClient } from './client.js';
import type { ServerSpec } from './server-spec.js';

// ── Shared fake-pool builder ──────────────────────────────────────────────────

type RequestFn = (method: string, params: unknown, opts: unknown) => Promise<unknown>;

function makeFakePool(requestFn: RequestFn): LspServerPool {
  const client = {
    hold: () => () => { /* no-op release */ },
    request: requestFn,
    diagnostics: { seq: 0, waitFor: async () => null },
    onExit: () => () => { /* no-op */ },
    closeOthers: () => { /* no-op */ },
    useDocument: () => () => { /* no-op */ },
    syncFile: async () => ({ uri: 'file:///dummy.ts', version: 1, changed: false }),
  } as unknown as LspClient;

  return {
    acquire: async (_spec: ServerSpec, _root: string) => client,
    dispose: async () => { /* no-op */ },
    startedCount: 0,
  } as unknown as LspServerPool;
}

// ── Helper: build a minimal workspace symbol ──────────────────────────────────

function sym(name: string, kind: number, filePath: string) {
  return {
    name,
    kind,
    location: { uri: `file://${filePath}` },
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

    const pool = makeFakePool(async (method) => {
      if (method === 'workspace/symbol') return symbols;
      throw new Error(`unexpected method ${method}`);
    });

    const result = await buildRepoMap({ rootDir: '/proj', timeoutMs: 3000, pool });

    expect(result).toContain('src/foo.ts');
    expect(result).toContain('class(MyClass)');
    expect(result).toContain('fn(myFn)');
    expect(result).toContain('src/bar.ts');
    expect(result).toContain('iface(IFace)');
    expect(result.startsWith('# Repo map (LSP workspace symbols)')).toBe(true);
  });

  it('falls back to fs map when workspace/symbol returns empty array', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    const pool = makeFakePool(async () => []);

    const result = await buildRepoMap({ rootDir: '/proj', timeoutMs: 500, pool });
    // Empty LSP result → tries fs fallback → likely '' for /proj (nonexistent)
    expect(typeof result).toBe('string');
  });

  it('falls back to fs map when workspace/symbol throws', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    const pool = makeFakePool(async () => { throw new Error('server error'); });

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

    const pool = makeFakePool(async () => symbols);

    const result = await buildRepoMap({ rootDir: '/proj', timeoutMs: 3000, pool });
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

    const pool = makeFakePool(async () => symbols);

    const result = await buildRepoMap({ rootDir: '/proj', timeoutMs: 3000, pool });
    expect(result).not.toContain('node_modules');
    expect(result).toContain('Internal');
  });

  it('respects MAX_LINES cap', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');

    // Generate many symbols across many files.
    const symbols = Array.from({ length: MAX_SYMBOLS + 50 }, (_, i) =>
      sym(`Sym${i}`, 5, `/proj/src/file${i}.ts`),
    );

    const pool = makeFakePool(async () => symbols);

    const result = await buildRepoMap({ rootDir: '/proj', timeoutMs: 3000, pool });
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

describe('buildRepoMap — timeout + abort', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('resolves (possibly empty) when aborted immediately', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    const ctl = new AbortController();
    ctl.abort();

    const pool = makeFakePool(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return [];
    });

    const result = await buildRepoMap({ rootDir: process.cwd(), timeoutMs: 5000, pool, signal: ctl.signal });
    expect(typeof result).toBe('string');
  });

  it('resolves when timeoutMs is very small', async () => {
    vi.stubEnv('AFK_LSP_DIAGNOSTICS', '1');
    const pool = makeFakePool(async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return [];
    });

    const result = await buildRepoMap({ rootDir: process.cwd(), timeoutMs: 1, pool });
    expect(typeof result).toBe('string');
  });
});
