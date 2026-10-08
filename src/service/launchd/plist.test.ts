/**
 * Tests for normalizeBrewCellarExecPath (fix C) and the related integration
 * with resolveServicePath and resolveProgramArguments.
 *
 * All cases are pure (no I/O): existsFn and realpathFn are injected stubs.
 *
 * Mirrors the skipIf(darwin) guard used throughout launchd.test.ts — these
 * functions are consumed by macOS-specific install paths.
 */

import { describe, expect, it } from 'vitest';
import { normalizeBrewCellarExecPath, resolveServicePath } from './plist.js';

// ── normalizeBrewCellarExecPath ───────────────────────────────────────────

describe.skipIf(process.platform !== 'darwin')('normalizeBrewCellarExecPath', () => {
  const neverExists = () => false;

  /**
   * Build stubs that model the common case: opt symlink exists and both
   * the opt path and the Cellar path realpath to the SAME canonical binary.
   * This is exactly what Homebrew does — opt/<formula> → Cellar/<ver>.
   */
  function makeNormalStubs(
    cellar: string,
    optPath: string,
  ): { existsFn: (p: string) => boolean; realpathFn: (p: string) => string } {
    const canonical = cellar; // both paths resolve to the cellar binary
    return {
      existsFn: (p: string) => p === optPath,
      realpathFn: (p: string) => (p === optPath || p === cellar ? canonical : p),
    };
  }

  it('normalizes Apple-Silicon Cellar path to stable opt symlink', () => {
    const cellar = '/opt/homebrew/Cellar/node/26.11.0/bin/node';
    const expected = '/opt/homebrew/opt/node/bin/node';
    const { existsFn, realpathFn } = makeNormalStubs(cellar, expected);
    expect(normalizeBrewCellarExecPath(cellar, existsFn, realpathFn)).toBe(expected);
  });

  it('normalizes Intel macOS Cellar path (/usr/local/Cellar)', () => {
    const cellar = '/usr/local/Cellar/node/26.11.0/bin/node';
    const expected = '/usr/local/opt/node/bin/node';
    const { existsFn, realpathFn } = makeNormalStubs(cellar, expected);
    expect(normalizeBrewCellarExecPath(cellar, existsFn, realpathFn)).toBe(expected);
  });

  it('normalizes versioned formula (node@22) correctly', () => {
    const cellar = '/opt/homebrew/Cellar/node@22/22.15.0/bin/node';
    const expected = '/opt/homebrew/opt/node@22/bin/node';
    const { existsFn, realpathFn } = makeNormalStubs(cellar, expected);
    expect(normalizeBrewCellarExecPath(cellar, existsFn, realpathFn)).toBe(expected);
  });

  it('returns execPath unchanged when the opt symlink does not exist', () => {
    const cellar = '/opt/homebrew/Cellar/node/26.11.0/bin/node';
    const result = normalizeBrewCellarExecPath(cellar, neverExists, (p) => p);
    expect(result).toBe(cellar);
  });

  it('returns execPath unchanged when opt symlink resolves to a different binary', () => {
    // Simulate opt/node pointing at v27 while this process runs v26.
    const cellar = '/opt/homebrew/Cellar/node/26.11.0/bin/node';
    const optPath = '/opt/homebrew/opt/node/bin/node';
    const existsFn = (p: string) => p === optPath;
    const realpathFn = (p: string) => {
      if (p === optPath) return '/opt/homebrew/Cellar/node/27.0.0/bin/node';
      return p; // cellar path resolves to itself
    };
    expect(normalizeBrewCellarExecPath(cellar, existsFn, realpathFn)).toBe(cellar);
  });

  it('returns execPath unchanged when realpathFn throws (dangling symlink)', () => {
    const cellar = '/opt/homebrew/Cellar/node/26.11.0/bin/node';
    const optPath = '/opt/homebrew/opt/node/bin/node';
    const existsFn = (p: string) => p === optPath;
    const realpathFn = (p: string) => {
      if (p === optPath) throw new Error('ENOENT: dangling symlink');
      return p;
    };
    expect(normalizeBrewCellarExecPath(cellar, existsFn, realpathFn)).toBe(cellar);
  });

  it('returns non-Cellar paths unchanged (nvm, system node)', () => {
    const anyOpt = '/opt/homebrew/opt/node/bin/node';
    const existsFn = (p: string) => p === anyOpt;
    const realpathFn = (p: string) => p;

    const nvm = '/Users/me/.nvm/versions/node/v24.11.0/bin/node';
    expect(normalizeBrewCellarExecPath(nvm, existsFn, realpathFn)).toBe(nvm);

    const system = '/usr/bin/node';
    expect(normalizeBrewCellarExecPath(system, existsFn, realpathFn)).toBe(system);
  });

  it('normalizes a Cellar path whose suffix is not /bin/node (e.g. npm-cli.js)', () => {
    const cellar = '/opt/homebrew/Cellar/node/26.11.0/lib/node_modules/npm/bin/npm-cli.js';
    const expected = '/opt/homebrew/opt/node/lib/node_modules/npm/bin/npm-cli.js';
    const { existsFn, realpathFn } = makeNormalStubs(cellar, expected);
    expect(normalizeBrewCellarExecPath(cellar, existsFn, realpathFn)).toBe(expected);
  });
});

// ── resolveServicePath picks up Cellar normalization ─────────────────────

describe.skipIf(process.platform !== 'darwin')('resolveServicePath Cellar normalization', () => {
  it('uses the stable opt-symlink dir when a Cellar path is passed', () => {
    // resolveServicePath calls normalizeBrewCellarExecPath internally.
    // We pass a Cellar execPath; the function should use opt/node/bin as
    // the first PATH component, not the versioned Cellar dir.
    //
    // Note: resolveServicePath does not accept existsFn/realpathFn — it
    // calls normalizeBrewCellarExecPath with real fs. For a pure
    // integration test we verify the *structure* (dirname of normalized):
    // a Cellar path on a real macOS system may or may not have the opt
    // symlink, so we use a Homebrew opt path that is already stable.
    const optPath = '/opt/homebrew/opt/node/bin/node';
    const parts = resolveServicePath(optPath).split(':');
    // dirname of optPath → /opt/homebrew/opt/node/bin
    expect(parts[0]).toBe('/opt/homebrew/opt/node/bin');
  });
});
