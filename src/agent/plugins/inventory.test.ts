/**
 * Tests for the installed-plugin inventory used by `/reload-plugins`.
 *
 * Validates the join across the three sources: the on-disk scan (spine), the
 * `plugin.json` manifest (name + version), and the plugin index (ref / commit /
 * source). Dependency-injects `roots` + `indexPath` so each case points at a
 * fresh tmp tree — no AFK_HOME juggling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { _resetPluginScanCache } from '../plugins-scanner.js';
import { listInstalledPlugins, formatPluginVersion, type InstalledPlugin } from './inventory.js';

let tmp: string;

function writePlugin(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
}

function writeIndex(path: string, plugins: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ version: 2, plugins, marketplaces: {} }));
}

beforeEach(() => {
  tmp = join(tmpdir(), `afk-inv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  // scanLocalPlugins memoizes per directory — clear it so a prior case's
  // tmp tree can't leak into this one (matches plugins-scanner.test.ts).
  _resetPluginScanCache();
});

afterEach(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe('listInstalledPlugins', () => {
  it('returns [] when no plugins are present', () => {
    expect(listInstalledPlugins({ roots: [tmp], indexPath: join(tmp, '.index.json') })).toEqual([]);
  });

  it('reports manifest name + version for a flat plugin without an index entry', () => {
    writePlugin(join(tmp, 'my-plugin'), { name: 'my-plugin', version: '1.2.3' });
    const res = listInstalledPlugins({ roots: [tmp], indexPath: join(tmp, '.index.json') });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      name: 'my-plugin',
      version: '1.2.3',
      ref: null,
      commit: null,
      source: null,
    });
  });

  it('falls back to the directory basename when the manifest has no name', () => {
    writePlugin(join(tmp, 'nameless'), { version: '0.0.1' });
    const res = listInstalledPlugins({ roots: [tmp], indexPath: join(tmp, '.index.json') });
    expect(res[0]?.name).toBe('nameless');
    expect(res[0]?.version).toBe('0.0.1');
  });

  it('annotates a git plugin with index ref/commit/source', () => {
    writePlugin(join(tmp, 'gitplug'), { name: 'gitplug', version: '0.1.0' });
    const indexPath = join(tmp, '.index.json');
    writeIndex(indexPath, {
      gitplug: {
        source: 'owner/gitplug',
        sourceType: 'github',
        ref: 'v0.1.0',
        commit: 'abcdef1234567',
        enabled: true,
        installedAt: 'x',
        updatedAt: 'x',
      },
    });
    _resetPluginScanCache();
    const res = listInstalledPlugins({ roots: [tmp], indexPath });
    expect(res[0]).toMatchObject({
      name: 'gitplug',
      version: '0.1.0',
      ref: 'v0.1.0',
      commit: 'abcdef1234567',
      source: 'owner/gitplug',
      sourceType: 'github',
    });
  });

  it('matches a marketplace-cache plugin to its <mp>:<plugin> index entry by bare name', () => {
    // Mirrors the real install: cache/<mp>/<plugin>, index key is <mp>:<plugin>,
    // ref/commit null (the version lives in the manifest).
    writePlugin(join(tmp, 'cache', 'mymarket', 'awesome'), { name: 'awesome', version: '2.4.3' });
    const indexPath = join(tmp, '.index.json');
    writeIndex(indexPath, {
      'mymarket:awesome': {
        source: 'mymarket:awesome',
        sourceType: 'marketplace',
        ref: null,
        commit: null,
        enabled: true,
        installedAt: 'x',
        updatedAt: 'x',
        marketplace: 'mymarket',
      },
    });
    _resetPluginScanCache();
    const res = listInstalledPlugins({ roots: [tmp], indexPath });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      name: 'awesome',
      version: '2.4.3',
      ref: null,
      source: 'mymarket:awesome',
      sourceType: 'marketplace',
    });
  });

  it('includes the always-shipped bundled awa-bundled plugin by default', () => {
    // Default roots include getBundledPluginsDir(); awa-bundled ships in-repo,
    // so it must surface (with its manifest version) on every machine.
    _resetPluginScanCache();
    const res = listInstalledPlugins();
    const bundled = res.find((p) => p.name === 'awa-bundled');
    expect(bundled).toBeDefined();
    expect(bundled?.version).toBeTruthy();
  });

  it('dedupes a plugin present in two roots, sorted by name', () => {
    const rootA = join(tmp, 'a');
    const rootB = join(tmp, 'b');
    writePlugin(join(rootA, 'zeta'), { name: 'zeta', version: '1.0.0' });
    writePlugin(join(rootA, 'alpha'), { name: 'alpha', version: '1.0.0' });
    writePlugin(join(rootB, 'alpha'), { name: 'alpha', version: '9.9.9' }); // shadowed
    const res = listInstalledPlugins({ roots: [rootA, rootB], indexPath: join(tmp, '.index.json') });
    expect(res.map((p) => p.name)).toEqual(['alpha', 'zeta']);
    // rootA wins the dedupe (higher priority / scanned first).
    expect(res.find((p) => p.name === 'alpha')?.version).toBe('1.0.0');
  });
});

describe('formatPluginVersion', () => {
  const base: InstalledPlugin = {
    name: 'x',
    version: null,
    ref: null,
    commit: null,
    source: null,
    sourceType: null,
    dir: '/x',
  };

  it('prefers the manifest version with a v prefix', () => {
    expect(formatPluginVersion({ ...base, version: '1.9.0' })).toBe('v1.9.0');
  });

  it('does not double an existing v prefix', () => {
    expect(formatPluginVersion({ ...base, version: 'v2.0.0' })).toBe('v2.0.0');
  });

  it('falls back to ref, then (local)', () => {
    expect(formatPluginVersion({ ...base, ref: 'main' })).toBe('main');
    expect(formatPluginVersion(base)).toBe('(local)');
  });

  it('appends a short commit for git installs', () => {
    expect(formatPluginVersion({ ...base, version: '1.0.0', commit: 'abcdef1234567' })).toBe(
      'v1.0.0 @ abcdef1',
    );
  });

  it('does not append the commit when it duplicates the ref', () => {
    expect(formatPluginVersion({ ...base, ref: 'abcdef1', commit: 'abcdef1' })).toBe('abcdef1');
  });
});
