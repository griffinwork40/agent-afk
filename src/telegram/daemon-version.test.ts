/**
 * Regression tests for readDiskVersion().
 *
 * The same three layouts resolveEntrypoint() handles apply here, and the
 * failure mode is silent: esbuild FLATTENS src/telegram/daemon-version.ts into
 * dist/telegram.mjs, so `import.meta.url` does not track the source path. A
 * single hardcoded '../package.json' works in the bundle and breaks dev/tsc; a
 * single '../../package.json' does the inverse. Either way the daemon reads
 * 'unknown', checkVersionDrift short-circuits, and the version-drift watchdog
 * silently never fires again — with no error anywhere.
 */

import { describe, expect, it } from 'vitest';
import path from 'path';
import { readDiskVersion, PACKAGE_JSON_CANDIDATES, UNKNOWN_VERSION } from './daemon-version.js';

/** Build a readFile stub that only serves the given absolute paths. */
function serving(files: Record<string, string>): (p: string) => string {
  return (p: string) => {
    const hit = files[p];
    if (hit === undefined) throw new Error(`ENOENT: ${p}`);
    return hit;
  };
}

describe('readDiskVersion', () => {
  it('resolves the bundled layout (dist/telegram.mjs → ../package.json)', () => {
    const pkg = path.resolve('/pkg');
    const read = serving({ [path.join(pkg, 'package.json')]: JSON.stringify({ version: '5.97.3' }) });
    expect(readDiskVersion(path.join(pkg, 'dist'), read)).toBe('5.97.3');
  });

  it('resolves the tsc layout (dist/telegram/*.js → ../../package.json)', () => {
    const pkg = path.resolve('/pkg');
    const read = serving({ [path.join(pkg, 'package.json')]: JSON.stringify({ version: '5.97.3' }) });
    expect(readDiskVersion(path.join(pkg, 'dist', 'telegram'), read)).toBe('5.97.3');
  });

  it('resolves the dev/vitest layout (src/telegram/*.ts → ../../package.json)', () => {
    const repo = path.resolve('/repo');
    const read = serving({ [path.join(repo, 'package.json')]: JSON.stringify({ version: '0.0.1-dev' }) });
    expect(readDiskVersion(path.join(repo, 'src', 'telegram'), read)).toBe('0.0.1-dev');
  });

  it('prefers the nearer candidate when both depths resolve', () => {
    // A published install can have a package.json above the package root
    // (the consumer's own). The nearer one is this package's and must win.
    const pkg = path.resolve('/pkg');
    const fsRoot = path.parse(pkg).root;
    const read = serving({
      [path.join(pkg, 'package.json')]: JSON.stringify({ version: '5.97.3' }),
      [path.join(fsRoot, 'package.json')]: JSON.stringify({ version: '9.9.9-consumer' }),
    });
    expect(readDiskVersion(path.join(pkg, 'dist'), read)).toBe('5.97.3');
  });

  it('tries both candidates in the documented order', () => {
    const pkg = path.resolve('/pkg');
    const seen: string[] = [];
    readDiskVersion(path.join(pkg, 'dist'), (p) => {
      seen.push(p);
      throw new Error('ENOENT');
    });
    expect(seen).toEqual([path.join(pkg, 'package.json'), path.resolve(path.join(pkg, 'dist'), '../../package.json')]);
    expect(PACKAGE_JSON_CANDIDATES).toEqual(['../package.json', '../../package.json']);
  });

  it('falls back to UNKNOWN_VERSION when no candidate is readable', () => {
    expect(readDiskVersion(path.resolve('/nowhere'), () => { throw new Error('ENOENT'); })).toBe(UNKNOWN_VERSION);
  });

  it('falls back to UNKNOWN_VERSION on malformed JSON', () => {
    const pkg = path.resolve('/pkg');
    const read = serving({ [path.join(pkg, 'package.json')]: '{ not json' });
    expect(readDiskVersion(path.join(pkg, 'dist'), read)).toBe(UNKNOWN_VERSION);
  });

  it('skips a package.json with no version and keeps looking', () => {
    const pkg = path.resolve('/pkg');
    const fsRoot = path.parse(pkg).root;
    const read = serving({
      [path.join(pkg, 'package.json')]: JSON.stringify({ name: 'agent-afk' }),
      [path.join(fsRoot, 'package.json')]: JSON.stringify({ version: '5.97.3' }),
    });
    expect(readDiskVersion(path.join(pkg, 'dist'), read)).toBe('5.97.3');
  });

  it('rejects a non-string version rather than coercing it', () => {
    const pkg = path.resolve('/pkg');
    const read = serving({ [path.join(pkg, 'package.json')]: JSON.stringify({ version: 597 }) });
    expect(readDiskVersion(path.join(pkg, 'dist'), read)).toBe(UNKNOWN_VERSION);
  });

  it('reads the real package.json from its own on-disk location', () => {
    // No injection: exercises the default import.meta.url-derived searchDir in
    // the dev layout, so a wrong default depth fails here rather than in prod.
    expect(readDiskVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
