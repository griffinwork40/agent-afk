/**
 * Tests for LSP install orchestrator (#4272, D-core lane).
 *
 * All tests use temp dirs and fake executors — no real npm calls.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerDefinition, InstallContext } from './server-spec.js';
import { createEnsureInstalled } from './install.js';
import { createGrantStore } from './install.grants.js';
import { getLspInstallFootprint } from './install.footprint.js';
import { resolveNpmCommand, sanitizeFailureReason, MAX_FAILURE_REASON_CHARS, runNpmInstall } from './install.npm.js';
import type { NpmExecFn } from './install.npm.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'afk-lsp-test-'));
}

function makeDefinition(overrides: Partial<ServerDefinition> = {}): ServerDefinition {
  return {
    language: 'typescript',
    languageIds: { '.ts': 'typescript' },
    rootMarkers: ['tsconfig.json'],
    binName: 'typescript-language-server',
    args: ['--stdio'],
    install: { kind: 'npm', packages: ['typescript-language-server', 'typescript'] },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<InstallContext> = {}): InstallContext {
  return { interactive: false, ...overrides };
}

/** Write a fake binary at the expected npm bin path inside a tmp dir. */
function placeBin(serversDir: string, language: string, binName: string): string {
  const binPath = path.join(serversDir, language, 'node_modules', '.bin', binName);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n');
  return binPath;
}

/** Fake execFn that succeeds and places the bin. */
function makeSuccessExec(serversDir: string, def: ServerDefinition): NpmExecFn {
  return async (_file, _args, _opts) => {
    placeBin(serversDir, def.language, def.binName);
    return { stdout: '', stderr: '' };
  };
}

/** Fake execFn that always fails. */
function makeFailExec(reason: string): NpmExecFn {
  return async () => { throw new Error(reason); };
}

/** Fake execFn that installs without placing the bin. */
function makeNoBinExec(): NpmExecFn {
  return async () => ({ stdout: '', stderr: '' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstall(tmpDir: string, def: ServerDefinition, execFn: NpmExecFn) {
  const grantsPath = path.join(tmpDir, 'grants.json');
  const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
  const inFlightMap = new Map<string, Promise<any>>();

  const grantStore = createGrantStore(grantsPath);

  // Patch getLspInstalledBinPath to resolve inside tmpDir.
  // We inject paths via the serversDir approach by placing the bin ourselves
  // in makeSuccessExec above; the real paths.lsp functions will resolve
  // outside tmpDir, so we need to override access in the module.
  // Instead: override via a thin wrapper that replaces the bin path check.
  const ensure = createEnsureInstalled({
    grantStore,
    execFn,
    ledgerPath,
    inFlightMap,
  });

  return { ensure, grantStore, grantsPath, ledgerPath };
}

// ---------------------------------------------------------------------------
// resolveNpmBin
// ---------------------------------------------------------------------------

describe('resolveNpmCommand', () => {
  it('win32: runs npm-cli.js via the node binary (never npm.cmd)', () => {
    const cli = path.win32.join('C:\\Program Files\\nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    expect(resolveNpmCommand('win32', () => cli, 'C:\\Program Files\\nodejs\\node.exe'))
      .toEqual({ file: 'C:\\Program Files\\nodejs\\node.exe', args: [cli] });
  });

  it('win32: undefined when npm-cli.js cannot be located', () => {
    expect(resolveNpmCommand('win32', () => undefined)).toBeUndefined();
  });

  it('returns npm on linux and darwin', () => {
    expect(resolveNpmCommand('linux')).toEqual({ file: 'npm', args: [] });
    expect(resolveNpmCommand('darwin')).toEqual({ file: 'npm', args: [] });
  });

  it('win32 runNpmInstall passes npm-cli.js as the first arg, no shell', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const execFn: NpmExecFn = async (file, args) => { calls.push({ file, args }); return { stdout: '', stderr: '' }; };
    const res = await runNpmInstall('typescript', ['pkg'], undefined, execFn, 'win32', () => 'C:\\n\\npm-cli.js');
    expect(res).toEqual({ ok: true });
    expect(calls[0]!.file).toBe(process.execPath);
    expect(calls[0]!.args[0]).toBe('C:\\n\\npm-cli.js');
    expect(calls[0]!.args.slice(1, 2)).toEqual(['install']);
  });

  it('win32 runNpmInstall fails cleanly when npm-cli.js is missing', async () => {
    const execFn: NpmExecFn = async () => ({ stdout: '', stderr: '' });
    const res = await runNpmInstall('typescript', ['pkg'], undefined, execFn, 'win32', () => undefined);
    expect(res).toMatchObject({ ok: false, reason: expect.stringContaining('Could not locate npm') });
  });
});

describe('sanitizeFailureReason', () => {
  it('redacts secrets and caps the length', () => {
    const secret = 'ghp_' + 'a'.repeat(36);
    const out = sanitizeFailureReason(`npm ERR! 401 token ${secret} ` + 'x'.repeat(2000));
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
    expect(out.length).toBeLessThanOrEqual(MAX_FAILURE_REASON_CHARS + 20);
  });

  it('runNpmInstall returns a redacted, capped reason', async () => {
    const secret = 'ghp_' + 'b'.repeat(36);
    const res = await runNpmInstall('typescript', ['pkg'], undefined,
      async () => { throw new Error(`auth failed ${secret} ` + 'y'.repeat(5000)); }, 'linux');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).not.toContain(secret);
      expect(res.reason.length).toBeLessThanOrEqual(MAX_FAILURE_REASON_CHARS + 20);
    }
  });
});

// ---------------------------------------------------------------------------
// Grant store
// ---------------------------------------------------------------------------

describe('grant store', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('hasGrant returns false when no file exists', async () => {
    const store = createGrantStore(path.join(tmpDir, 'grants.json'));
    expect(await store.hasGrant('typescript')).toBe(false);
  });

  it('persistGrant then hasGrant returns true', async () => {
    const store = createGrantStore(path.join(tmpDir, 'grants.json'));
    await store.persistGrant('typescript', ['typescript-language-server']);
    expect(await store.hasGrant('typescript')).toBe(true);
  });

  it('persists multiple languages independently', async () => {
    const p = path.join(tmpDir, 'grants.json');
    const store = createGrantStore(p);
    await store.persistGrant('typescript', ['ts-ls']);
    await store.persistGrant('python', ['pyright']);
    expect(await store.hasGrant('typescript')).toBe(true);
    expect(await store.hasGrant('python')).toBe(true);
    expect(await store.hasGrant('rust')).toBe(false);
  });

  it('round-trip: grants survive JSON parse', async () => {
    const p = path.join(tmpDir, 'grants.json');
    const store = createGrantStore(p);
    await store.persistGrant('typescript', ['typescript-language-server', 'typescript']);
    // Read via a fresh store instance (no in-memory caching).
    const store2 = createGrantStore(p);
    expect(await store2.hasGrant('typescript')).toBe(true);
    expect(await store2.hasGrant('python')).toBe(false);
  });

  it('handles corrupt grants file gracefully', async () => {
    const p = path.join(tmpDir, 'grants.json');
    fs.writeFileSync(p, '{not valid json}');
    const store = createGrantStore(p);
    expect(await store.hasGrant('typescript')).toBe(false);
    // Can still persist after corrupt file.
    await store.persistGrant('typescript', ['ts-ls']);
    expect(await store.hasGrant('typescript')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Policy branches (via createEnsureInstalled with path overrides)
// ---------------------------------------------------------------------------

// NOTE: ensureInstalledCore calls access(getLspInstalledBinPath(...)) which
// resolves to the real cache dir. We need to redirect paths. The cleanest
// approach for tests: pre-place the bin OR use a mocked `access`. We use
// vi.mock for the paths module so tests are self-contained.

vi.mock('../../paths.lsp.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../paths.lsp.js')>();
  return {
    ...mod,
    getLspInstalledBinPath: (language: string, binName: string) =>
      path.join(
        (globalThis as any).__lspTestServersDir ?? os.tmpdir(),
        language,
        'node_modules',
        '.bin',
        binName,
      ),
    getLspLanguageInstallDir: (language: string) =>
      path.join(
        (globalThis as any).__lspTestServersDir ?? os.tmpdir(),
        language,
      ),
    getLspServersDir: () =>
      (globalThis as any).__lspTestServersDir ?? os.tmpdir(),
    getLspGrantsPath: () =>
      (globalThis as any).__lspTestGrantsPath ?? path.join(os.tmpdir(), 'grants.json'),
  };
});

describe('ensureServerInstalled — policy branches', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    (globalThis as any).__lspTestServersDir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete (globalThis as any).__lspTestServersDir;
    delete (globalThis as any).__lspTestGrantsPath;
  });

  // 1. Already installed.
  it('returns installed/freshInstall:false when bin exists', async () => {
    const def = makeDefinition();
    const binPath = placeBin(tmpDir, def.language, def.binName);
    const { ensure } = makeInstall(tmpDir, def, makeSuccessExec(tmpDir, def));
    const result = await ensure(def, makeCtx());
    expect(result).toMatchObject({ kind: 'installed', command: binPath, freshInstall: false });
  });

  // 2. No recipe.
  it('returns no-recipe when install field absent', async () => {
    const def = makeDefinition({ install: undefined });
    const { ensure } = makeInstall(tmpDir, def, makeSuccessExec(tmpDir, def));
    const result = await ensure(def, makeCtx());
    expect(result).toEqual({ kind: 'no-recipe' });
  });

  // 3. Stored grant → install without prompt (unattended).
  it('installs without asking when grant already stored', async () => {
    const def = makeDefinition();
    const grantsPath = path.join(tmpDir, 'grants.json');
    const grantStore = createGrantStore(grantsPath);
    await grantStore.persistGrant(def.language, [...def.install!.packages]);

    const askConsent = vi.fn();
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    const ensure = createEnsureInstalled({
      grantStore,
      execFn: makeSuccessExec(tmpDir, def),
      ledgerPath,
      inFlightMap: new Map(),
    });

    const result = await ensure(def, makeCtx({ interactive: false, askConsent }));
    expect(result).toMatchObject({ kind: 'installed', freshInstall: true });
    expect(askConsent).not.toHaveBeenCalled();
  });

  // 4. No grant + unattended.
  it('returns refused-unattended when no grant and not interactive', async () => {
    const def = makeDefinition();
    const { ensure } = makeInstall(tmpDir, def, makeSuccessExec(tmpDir, def));
    const result = await ensure(def, makeCtx({ interactive: false }));
    expect(result).toEqual({ kind: 'refused-unattended' });
  });

  // 5a. No grant + interactive + no askConsent → declined.
  it('returns declined when askConsent absent', async () => {
    const def = makeDefinition();
    const { ensure } = makeInstall(tmpDir, def, makeSuccessExec(tmpDir, def));
    const result = await ensure(def, makeCtx({ interactive: true }));
    expect(result).toEqual({ kind: 'declined' });
  });

  // 5b. No grant + interactive + askConsent returns false → declined.
  it('returns declined when user declines consent', async () => {
    const def = makeDefinition();
    const { ensure } = makeInstall(tmpDir, def, makeSuccessExec(tmpDir, def));
    const result = await ensure(def, makeCtx({
      interactive: true,
      askConsent: async () => false,
    }));
    expect(result).toEqual({ kind: 'declined' });
  });

  // 5c. Declined consent does NOT persist a grant.
  it('does not persist grant on decline', async () => {
    const def = makeDefinition();
    const grantsPath = path.join(tmpDir, 'grants.json');
    const grantStore = createGrantStore(grantsPath);
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    const ensure = createEnsureInstalled({
      grantStore,
      execFn: makeSuccessExec(tmpDir, def),
      ledgerPath,
      inFlightMap: new Map(),
    });
    await ensure(def, makeCtx({ interactive: true, askConsent: async () => false }));
    expect(await grantStore.hasGrant(def.language)).toBe(false);
  });

  // 6. Approved → grant persisted before npm, bin verified.
  it('installs and returns freshInstall:true on approval', async () => {
    const def = makeDefinition();
    const grantsPath = path.join(tmpDir, 'grants.json');
    const grantStore = createGrantStore(grantsPath);
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');

    let grantPersistedBeforeExec = false;
    const execFn: NpmExecFn = async (_file, _args, _opts) => {
      grantPersistedBeforeExec = await grantStore.hasGrant(def.language);
      placeBin(tmpDir, def.language, def.binName);
      return { stdout: '', stderr: '' };
    };

    const ensure = createEnsureInstalled({
      grantStore,
      execFn,
      ledgerPath,
      inFlightMap: new Map(),
    });

    const result = await ensure(def, makeCtx({ interactive: true, askConsent: async () => true }));
    expect(result).toMatchObject({ kind: 'installed', freshInstall: true });
    expect(grantPersistedBeforeExec).toBe(true);
  });

  // 6. npm failure → failed result.
  it('returns failed when npm exits with error', async () => {
    const def = makeDefinition();
    const { ensure } = makeInstall(tmpDir, def, makeFailExec('ENOENT npm not found'));
    const result = await ensure(
      def,
      makeCtx({ interactive: true, askConsent: async () => true }),
    );
    expect(result).toMatchObject({ kind: 'failed', reason: expect.stringContaining('ENOENT') });
  });

  // 6. Binary missing after npm succeeds → failed.
  it('returns failed when bin absent after successful npm', async () => {
    const def = makeDefinition();
    const { ensure } = makeInstall(tmpDir, def, makeNoBinExec());
    const result = await ensure(
      def,
      makeCtx({ interactive: true, askConsent: async () => true }),
    );
    expect(result).toMatchObject({ kind: 'failed', reason: expect.stringContaining('binary not found') });
  });

  // Abort signal propagates.
  it('propagates abort to npm exec', async () => {
    const def = makeDefinition();
    const controller = new AbortController();
    controller.abort();
    const calls: Array<{ signal: AbortSignal | undefined }> = [];
    const execFn: NpmExecFn = async (_f, _a, opts) => {
      calls.push({ signal: opts.signal });
      throw new Error('AbortError');
    };
    const { ensure } = makeInstall(tmpDir, def, execFn);
    const result = await ensure(
      def,
      makeCtx({ interactive: true, askConsent: async () => true, signal: controller.signal }),
    );
    expect(result).toMatchObject({ kind: 'failed' });
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// Concurrency dedup
// ---------------------------------------------------------------------------

describe('concurrent ensure calls — in-process dedup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    (globalThis as any).__lspTestServersDir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete (globalThis as any).__lspTestServersDir;
  });

  it('shares one install promise for concurrent calls on same language', async () => {
    const def = makeDefinition();
    let execCount = 0;
    const execFn: NpmExecFn = async () => {
      execCount++;
      placeBin(tmpDir, def.language, def.binName);
      return { stdout: '', stderr: '' };
    };

    const grantsPath = path.join(tmpDir, 'grants.json');
    const grantStore = createGrantStore(grantsPath);
    await grantStore.persistGrant(def.language, [...def.install!.packages]);

    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    const inFlightMap = new Map<string, Promise<any>>();
    const ensure = createEnsureInstalled({ grantStore, execFn, ledgerPath, inFlightMap });

    const [r1, r2, r3] = await Promise.all([
      ensure(def, makeCtx()),
      ensure(def, makeCtx()),
      ensure(def, makeCtx()),
    ]);

    // All succeed.
    expect(r1).toMatchObject({ kind: 'installed' });
    expect(r2).toMatchObject({ kind: 'installed' });
    expect(r3).toMatchObject({ kind: 'installed' });
    // npm was only called once.
    expect(execCount).toBe(1);
  });

  it('parallel calls for different languages run independently', async () => {
    const defTs = makeDefinition({ language: 'typescript' });
    const defPy = makeDefinition({ language: 'python', binName: 'pyright' });

    let execCount = 0;
    const execFn: NpmExecFn = async (_f, args) => {
      execCount++;
      const prefixIdx = args.indexOf('--prefix');
      if (prefixIdx !== -1) {
        const prefixDir = args[prefixIdx + 1]!;
        const lang = path.basename(prefixDir);
        const binName = lang === 'typescript' ? 'typescript-language-server' : 'pyright';
        const binPath = path.join(prefixDir, 'node_modules', '.bin', binName);
        fs.mkdirSync(path.dirname(binPath), { recursive: true });
        fs.writeFileSync(binPath, '');
      }
      return { stdout: '', stderr: '' };
    };

    const grantsPath = path.join(tmpDir, 'grants.json');
    const grantStore = createGrantStore(grantsPath);
    await grantStore.persistGrant('typescript', ['typescript-language-server']);
    await grantStore.persistGrant('python', ['pyright']);

    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    const inFlightMap = new Map<string, Promise<any>>();
    const ensure = createEnsureInstalled({ grantStore, execFn, ledgerPath, inFlightMap });

    const [rTs, rPy] = await Promise.all([
      ensure(defTs, makeCtx()),
      ensure(defPy, makeCtx()),
    ]);
    expect(rTs).toMatchObject({ kind: 'installed' });
    expect(rPy).toMatchObject({ kind: 'installed' });
    expect(execCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Ledger rows
// ---------------------------------------------------------------------------

describe('effect ledger rows', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    (globalThis as any).__lspTestServersDir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete (globalThis as any).__lspTestServersDir;
  });

  it('writes pending then executed rows on success', async () => {
    const def = makeDefinition();
    const grantsPath = path.join(tmpDir, 'grants.json');
    const grantStore = createGrantStore(grantsPath);
    await grantStore.persistGrant(def.language, [...def.install!.packages]);

    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    const ensure = createEnsureInstalled({
      grantStore,
      execFn: makeSuccessExec(tmpDir, def),
      ledgerPath,
      inFlightMap: new Map(),
    });

    await ensure(def, makeCtx());

    const lines = fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n');
    const records = lines.map((l) => JSON.parse(l));
    expect(records.some((r: any) => r.status === 'pending')).toBe(true);
    expect(records.some((r: any) => r.status === 'executed')).toBe(true);
    expect(records.every((r: any) => r.operationType === 'lsp_install')).toBe(true);
  });

  it('writes pending then failed rows on npm error', async () => {
    const def = makeDefinition();
    const grantsPath = path.join(tmpDir, 'grants.json');
    const grantStore = createGrantStore(grantsPath);
    await grantStore.persistGrant(def.language, [...def.install!.packages]);

    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    const ensure = createEnsureInstalled({
      grantStore,
      execFn: makeFailExec('install error'),
      ledgerPath,
      inFlightMap: new Map(),
    });

    await ensure(def, makeCtx());

    const lines = fs.readFileSync(ledgerPath, 'utf-8').trim().split('\n');
    const records = lines.map((l) => JSON.parse(l));
    expect(records.some((r: any) => r.status === 'pending')).toBe(true);
    expect(records.some((r: any) => r.status === 'failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getLspInstallFootprint
// ---------------------------------------------------------------------------

describe('getLspInstallFootprint', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns empty array when servers dir absent', async () => {
    const result = await getLspInstallFootprint(path.join(tmpDir, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('returns bytes per language', async () => {
    const tsDir = path.join(tmpDir, 'typescript', 'node_modules', '.bin');
    fs.mkdirSync(tsDir, { recursive: true });
    fs.writeFileSync(path.join(tsDir, 'tsc'), 'x'.repeat(100));

    const pyDir = path.join(tmpDir, 'python');
    fs.mkdirSync(pyDir, { recursive: true });
    fs.writeFileSync(path.join(pyDir, 'pyright'), 'x'.repeat(200));

    const result = await getLspInstallFootprint(tmpDir);
    const ts = result.find((r) => r.language === 'typescript');
    const py = result.find((r) => r.language === 'python');
    expect(ts?.bytes).toBe(100);
    expect(py?.bytes).toBe(200);
  });

  it('returns entries sorted by language', async () => {
    for (const lang of ['typescript', 'python', 'go']) {
      fs.mkdirSync(path.join(tmpDir, lang), { recursive: true });
    }
    const result = await getLspInstallFootprint(tmpDir);
    const langs = result.map((r) => r.language);
    expect(langs).toEqual([...langs].sort());
  });
});

// ---------------------------------------------------------------------------
// #4293 review C-5: never throws on ledger I/O; dedupe keyed on interactive
// ---------------------------------------------------------------------------

describe('ensureServerInstalled — C-5 hardening', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    (globalThis as any).__lspTestServersDir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete (globalThis as any).__lspTestServersDir;
  });

  it('maps a ledger write error to {kind:"failed"} instead of throwing', async () => {
    const def = makeDefinition();
    const grantStore = createGrantStore(path.join(tmpDir, 'grants.json'));
    await grantStore.persistGrant(def.language, [...def.install!.packages]);
    // A directory as the ledger path: appending to it fails (EISDIR/EPERM).
    const ledgerPath = path.join(tmpDir, 'ledger-is-a-dir');
    fs.mkdirSync(ledgerPath);
    const ensure = createEnsureInstalled({
      grantStore, execFn: makeSuccessExec(tmpDir, def), ledgerPath, inFlightMap: new Map(),
    });
    const result = await ensure(def, makeCtx());
    expect(result).toMatchObject({ kind: 'failed', reason: expect.stringContaining('LSP install error') });
  });

  it('an unattended call in flight does not answer a concurrent interactive call', async () => {
    const def = makeDefinition();
    const grantStore = createGrantStore(path.join(tmpDir, 'grants.json'));
    const ensure = createEnsureInstalled({
      grantStore, execFn: makeSuccessExec(tmpDir, def),
      ledgerPath: path.join(tmpDir, 'ledger.jsonl'), inFlightMap: new Map(),
    });
    const unattended = ensure(def, makeCtx({ interactive: false }));
    const interactive = ensure(def, makeCtx({ interactive: true, askConsent: async () => true }));
    expect(await unattended).toEqual({ kind: 'refused-unattended' });
    expect(await interactive).toMatchObject({ kind: 'installed', freshInstall: true });
  });
});
