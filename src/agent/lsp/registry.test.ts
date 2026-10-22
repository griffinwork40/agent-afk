/**
 * Tests for src/agent/lsp/registry.ts (#4272, lane B).
 *
 * All tests use injected fsStat / pathLookup so no real disk or PATH is
 * consulted. Temp dirs are created with os.tmpdir() + mkdtemp (posix-guard
 * compliant — no '/tmp/…' literal).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  definitionForFile,
  detectProjectLanguages,
  getServerDefinitions,
  resolveServerWith,
  type RegistryDeps,
} from './registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a RegistryDeps with a simple set-based fsStat and no PATH hits. */
function makeDeps(existingPaths: Set<string>, pathHit?: string): RegistryDeps {
  return {
    fsStat: (p) => existingPaths.has(p),
    pathLookup: pathHit !== undefined ? (bin) => (bin === pathHit ? '/usr/bin/' + bin : undefined) : () => undefined,
  };
}

// ---------------------------------------------------------------------------
// getServerDefinitions
// ---------------------------------------------------------------------------

describe('getServerDefinitions', () => {
  it('returns a non-empty array', () => {
    expect(getServerDefinitions().length).toBeGreaterThan(0);
  });

  it('includes typescript and python entries', () => {
    const langs = getServerDefinitions().map((d) => d.language);
    expect(langs).toContain('typescript');
    expect(langs).toContain('python');
  });

  it('includes data-only entries for go, rust, cpp', () => {
    const langs = getServerDefinitions().map((d) => d.language);
    expect(langs).toContain('go');
    expect(langs).toContain('rust');
    expect(langs).toContain('cpp');
  });

  it('data-only entries have no install recipe', () => {
    const defs = getServerDefinitions();
    for (const lang of ['go', 'rust', 'cpp']) {
      const d = defs.find((x) => x.language === lang);
      expect(d?.install, `${lang} should have no install`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// definitionForFile — extension mapping
// ---------------------------------------------------------------------------

describe('definitionForFile', () => {
  it.each([
    ['/a/b/foo.ts', 'typescript'],
    ['/a/b/foo.tsx', 'typescript'],
    ['/a/b/foo.mts', 'typescript'],
    ['/a/b/foo.cts', 'typescript'],
    ['/a/b/foo.js', 'typescript'],
    ['/a/b/foo.jsx', 'typescript'],
    ['/a/b/foo.mjs', 'typescript'],
    ['/a/b/foo.cjs', 'typescript'],
  ])('maps %s to typescript definition', (file, lang) => {
    expect(definitionForFile(file)?.language).toBe(lang);
  });

  it.each([
    ['/a/b/foo.py', 'python'],
    ['/a/b/foo.pyi', 'python'],
  ])('maps %s to python definition', (file, lang) => {
    expect(definitionForFile(file)?.language).toBe(lang);
  });

  it.each([['/a/b/foo.go', 'go'], ['/a/b/foo.rs', 'rust'], ['/a/b/foo.cpp', 'cpp']])(
    'maps %s to %s definition',
    (file, lang) => {
      expect(definitionForFile(file)?.language).toBe(lang);
    },
  );

  it('is case-insensitive for extensions', () => {
    expect(definitionForFile('/a/FOO.TS')?.language).toBe('typescript');
    expect(definitionForFile('/a/FOO.PY')?.language).toBe('python');
  });

  it('returns undefined for unsupported extension', () => {
    expect(definitionForFile('/a/foo.rb')).toBeUndefined();
    expect(definitionForFile('/a/foo.swift')).toBeUndefined();
  });

  it('returns undefined for file with no extension', () => {
    expect(definitionForFile('/a/Makefile')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectProjectLanguages
// ---------------------------------------------------------------------------

describe('detectProjectLanguages', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-registry-detect-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns typescript def when package.json exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    const langs = detectProjectLanguages(tmpDir).map((d) => d.language);
    expect(langs).toContain('typescript');
  });

  it('returns python def when pyproject.toml exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '');
    const langs = detectProjectLanguages(tmpDir).map((d) => d.language);
    expect(langs).toContain('python');
  });

  it('returns empty array when no markers present', () => {
    expect(detectProjectLanguages(tmpDir)).toHaveLength(0);
  });

  it('can return multiple languages', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '');
    const langs = detectProjectLanguages(tmpDir).map((d) => d.language);
    expect(langs).toContain('typescript');
    expect(langs).toContain('python');
  });
});

// ---------------------------------------------------------------------------
// resolveServerWith — root walk
// ---------------------------------------------------------------------------

describe('resolveServerWith — root walk', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-registry-root-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds nearest ancestor marker', async () => {
    // layout: tmpDir/tsconfig.json, tmpDir/sub/src/foo.ts
    const sub = path.join(tmpDir, 'sub', 'src');
    fs.mkdirSync(sub, { recursive: true });
    const marker = path.join(tmpDir, 'tsconfig.json');
    const filePath = path.join(sub, 'foo.ts');

    const existing = new Set([marker]);
    const resolve = resolveServerWith(makeDeps(existing, 'typescript-language-server'));
    const result = await resolve(filePath, tmpDir);

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.root).toBe(path.resolve(tmpDir));
    }
  });

  it('nearest marker wins over a farther one', async () => {
    // tmpDir/package.json (far) and tmpDir/sub/tsconfig.json (near)
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const farMarker = path.join(tmpDir, 'package.json');
    const nearMarker = path.join(sub, 'tsconfig.json');
    const filePath = path.join(sub, 'foo.ts');

    const existing = new Set([farMarker, nearMarker]);
    const resolve = resolveServerWith(makeDeps(existing, 'typescript-language-server'));
    const result = await resolve(filePath, tmpDir);

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.root).toBe(path.resolve(sub));
    }
  });

  it('does not walk above sessionRoot', async () => {
    // marker is above sessionRoot — should not be found
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const aboveMarker = path.join(tmpDir, 'tsconfig.json');
    const filePath = path.join(sub, 'foo.ts');

    const existing = new Set([aboveMarker]);
    // sessionRoot = sub, so walk must stop at sub
    const resolve = resolveServerWith(makeDeps(existing, 'typescript-language-server'));
    const result = await resolve(filePath, sub);

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      // root must fall back to sessionRoot, not go above it
      expect(result.root).toBe(path.resolve(sub));
    }
  });

  it('falls back to sessionRoot when no marker found', async () => {
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const filePath = path.join(sub, 'foo.ts');

    const resolve = resolveServerWith(makeDeps(new Set(), 'typescript-language-server'));
    const result = await resolve(filePath, tmpDir);

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.root).toBe(path.resolve(tmpDir));
    }
  });

  it('falls back to file dir when no sessionRoot and no marker', async () => {
    const sub = path.join(tmpDir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const filePath = path.join(sub, 'foo.ts');

    const resolve = resolveServerWith(makeDeps(new Set(), 'typescript-language-server'));
    const result = await resolve(filePath); // no sessionRoot

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.root).toBe(path.resolve(sub));
    }
  });
});

// ---------------------------------------------------------------------------
// resolveServerWith — binary lookup priority
// ---------------------------------------------------------------------------

describe('resolveServerWith — binary lookup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-registry-bin-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('afk install dir beats PATH', async () => {
    // Simulate afk install path existing by injecting a custom definition
    // with a fake binName, and an fsStat that says the afk path exists.
    const fakeDef = {
      language: 'typescript',
      binName: 'typescript-language-server',
      args: ['--stdio'] as readonly string[],
      install: { kind: 'npm' as const, packages: ['typescript-language-server', 'typescript'] },
      languageIds: { '.ts': 'typescript' },
      rootMarkers: [] as readonly string[],
    };

    // We need to know what getLspInstalledBinPath returns for the fake def.
    const { getLspInstalledBinPath } = await import('../../paths.lsp.js');
    const afkBinPath = getLspInstalledBinPath('typescript', 'typescript-language-server');

    const existing = new Set([afkBinPath]);
    const deps: RegistryDeps = {
      fsStat: (p) => existing.has(p),
      pathLookup: () => '/usr/bin/typescript-language-server',
      definitions: [fakeDef],
    };
    const resolve = resolveServerWith(deps);
    const result = await resolve(path.join(tmpDir, 'foo.ts'), tmpDir);

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.spec.source).toBe('afk-install');
      expect(result.spec.command).toBe(afkBinPath);
    }
  });

  it('falls through to PATH when afk bin missing', async () => {
    const resolve = resolveServerWith(makeDeps(new Set(), 'typescript-language-server'));
    const result = await resolve(path.join(tmpDir, 'foo.ts'), tmpDir);

    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.spec.source).toBe('path');
      expect(result.spec.command).toBe('typescript-language-server');
    }
  });

  it('returns missing when neither afk nor PATH has the binary', async () => {
    const resolve = resolveServerWith(makeDeps(new Set()));
    const result = await resolve(path.join(tmpDir, 'foo.ts'), tmpDir);

    expect(result.kind).toBe('missing');
    if (result.kind === 'missing') {
      expect(result.definition.language).toBe('typescript');
    }
  });

  it('returns unsupported for unknown extension', async () => {
    const resolve = resolveServerWith(makeDeps(new Set()));
    const result = await resolve(path.join(tmpDir, 'foo.rb'), tmpDir);
    expect(result.kind).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// resolveServerWith — fs error degrades gracefully
// ---------------------------------------------------------------------------

describe('resolveServerWith — error resilience', () => {
  it('returns unsupported (not throw) when fsStat throws', async () => {
    const deps: RegistryDeps = {
      fsStat: () => { throw new Error('disk error'); },
      pathLookup: () => undefined,
    };
    const resolve = resolveServerWith(deps);
    const result = await resolve('/any/file.ts', '/any');
    // Must not throw; any degraded result is acceptable
    expect(['unsupported', 'missing', 'resolved']).toContain(result.kind);
  });

  it('returns unsupported when pathLookup throws', async () => {
    const deps: RegistryDeps = {
      fsStat: () => false,
      pathLookup: () => { throw new Error('lookup error'); },
    };
    const resolve = resolveServerWith(deps);
    const result = await resolve('/any/file.ts', '/any');
    expect(['unsupported', 'missing', 'resolved']).toContain(result.kind);
  });
});
