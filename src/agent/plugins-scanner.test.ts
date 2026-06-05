/**
 * Tests for the local plugin scanner. Validates that AFK discovers plugins
 * under `~/.afk/plugins/` (both flat and marketplace-cache layouts) and
 * passes them as `{ type: 'local', path }` to the SDK — the only install
 * path that actually works today (anthropics/claude-code#15071).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanLocalPlugins, _resetPluginScanCache } from './plugins-scanner.js';

let tmpHome: string;

function writePluginManifest(root: string): void {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test', version: '0.0.0' }),
  );
}

beforeEach(() => {
  tmpHome = join(tmpdir(), `afk-plugins-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  // Per-case fresh fixtures — invalidate the in-process scan cache so
  // results from a prior test's tmpHome don't leak. Tests share the
  // module's `scanCache`; without this, cases that scan the same path
  // (the `~/.afk/plugins/` default branch) would see stale entries.
  _resetPluginScanCache();
});

afterEach(() => {
  if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
});

describe('plugins-scanner', () => {
  it('returns [] when the plugins dir does not exist', () => {
    expect(scanLocalPlugins(join(tmpHome, 'missing'))).toEqual([]);
  });

  it('returns [] when the plugins dir is empty', () => {
    expect(scanLocalPlugins(tmpHome)).toEqual([]);
  });

  it('discovers a flat-layout plugin (~/.afk/plugins/<name>/)', () => {
    const pluginDir = join(tmpHome, 'my-plugin');
    writePluginManifest(pluginDir);

    expect(scanLocalPlugins(tmpHome)).toEqual([{ type: 'local', path: pluginDir }]);
  });

  it('discovers a marketplace-cache-layout plugin when it has an enabled index entry', () => {
    const pluginDir = join(tmpHome, 'cache', 'some-market', 'some-plugin');
    writePluginManifest(pluginDir);
    writeFileSync(
      join(tmpHome, '.index.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'some-market:some-plugin': {
            source: 'some-market:some-plugin', sourceType: 'marketplace',
            ref: null, commit: null, enabled: true,
            installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
            marketplace: 'some-market',
          },
        },
        marketplaces: {
          'some-market': {
            source: 'x', sourceType: 'local',
            ref: null, commit: null,
            installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      }),
    );

    expect(scanLocalPlugins(tmpHome)).toEqual([{ type: 'local', path: pluginDir }]);
  });

  it('discovers a cache-layout plugin nested under plugins/<name>/ via marketplace.json', () => {
    // Real-world layout: marketplaces declare `source: "./plugins/<name>"`,
    // so plugins land at `cache/<mp>/plugins/<name>/` — not the simpler
    // `cache/<mp>/<name>/`. The scanner must derive the index key from
    // marketplace.json, not from a fixed segment position.
    const marketplaceDir = join(tmpHome, 'cache', 'mp1');
    const pluginDir = join(marketplaceDir, 'plugins', 'plugin-a');
    writePluginManifest(pluginDir);
    mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'mp1',
        plugins: [{ name: 'plugin-a', source: './plugins/plugin-a' }],
      }),
    );
    writeFileSync(
      join(tmpHome, '.index.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'mp1:plugin-a': {
            source: 'mp1:plugin-a', sourceType: 'marketplace',
            ref: null, commit: null, enabled: true,
            installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
            marketplace: 'mp1',
          },
        },
        marketplaces: {
          mp1: {
            source: 'x', sourceType: 'local',
            ref: null, commit: null,
            installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      }),
    );

    expect(scanLocalPlugins(tmpHome)).toEqual([{ type: 'local', path: pluginDir }]);
  });

  it('uses marketplace.json plugin name even when the on-disk dir is renamed', () => {
    // marketplace.json maps canonical plugin name `canonical` to dir
    // `pkg-on-disk`. The index keys on the canonical name; the scanner
    // must consult the manifest, not basename(dir).
    const marketplaceDir = join(tmpHome, 'cache', 'mp1');
    const pluginDir = join(marketplaceDir, 'apps', 'pkg-on-disk');
    writePluginManifest(pluginDir);
    mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'mp1',
        plugins: [{ name: 'canonical', source: './apps/pkg-on-disk' }],
      }),
    );
    writeFileSync(
      join(tmpHome, '.index.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'mp1:canonical': {
            source: 'mp1:canonical', sourceType: 'marketplace',
            ref: null, commit: null, enabled: true,
            installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
            marketplace: 'mp1',
          },
        },
        marketplaces: {
          mp1: {
            source: 'x', sourceType: 'local',
            ref: null, commit: null,
            installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      }),
    );

    expect(scanLocalPlugins(tmpHome)).toEqual([{ type: 'local', path: pluginDir }]);
  });

  it('falls back to segments[2] when marketplace.json is malformed', () => {
    // Locks in the JSON.parse try/catch path: when the manifest is
    // unreadable, the scanner must not crash — it falls back to
    // segments[2] (the pre-manifest behavior), which correctly resolves
    // to `<plugin>` for the simple `cache/<mp>/<plugin>/` layout.
    const marketplaceDir = join(tmpHome, 'cache', 'mp1');
    const pluginDir = join(marketplaceDir, 'plugin-a');
    writePluginManifest(pluginDir);
    mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      '{ this is not valid json',
    );
    writeFileSync(
      join(tmpHome, '.index.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'mp1:plugin-a': {
            source: 'mp1:plugin-a', sourceType: 'marketplace',
            ref: null, commit: null, enabled: true,
            installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
            marketplace: 'mp1',
          },
        },
        marketplaces: {
          mp1: {
            source: 'x', sourceType: 'local',
            ref: null, commit: null,
            installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      }),
    );

    expect(scanLocalPlugins(tmpHome)).toEqual([{ type: 'local', path: pluginDir }]);
  });

  it('skips a marketplace-cache-layout plugin without an enabled index entry', () => {
    // The marketplace was cloned but the user has not run
    // `afk plugin install <mp>:<plugin>` yet — the SDK should not see it.
    const pluginDir = join(tmpHome, 'cache', 'some-market', 'some-plugin');
    writePluginManifest(pluginDir);

    expect(scanLocalPlugins(tmpHome)).toEqual([]);
  });

  it('skips a cache plugin whose index entry is enabled:false', () => {
    const pluginDir = join(tmpHome, 'cache', 'some-market', 'some-plugin');
    writePluginManifest(pluginDir);
    writeFileSync(
      join(tmpHome, '.index.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'some-market:some-plugin': {
            source: 'some-market:some-plugin', sourceType: 'marketplace',
            ref: null, commit: null, enabled: false,
            installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
            marketplace: 'some-market',
          },
        },
        marketplaces: {},
      }),
    );

    expect(scanLocalPlugins(tmpHome)).toEqual([]);
  });

  it('skips directories without a .claude-plugin/plugin.json manifest', () => {
    mkdirSync(join(tmpHome, 'not-a-plugin', 'src'), { recursive: true });
    writeFileSync(join(tmpHome, 'not-a-plugin', 'README.md'), '# no manifest');

    expect(scanLocalPlugins(tmpHome)).toEqual([]);
  });

  it('discovers multiple plugins side-by-side', () => {
    writePluginManifest(join(tmpHome, 'alpha'));
    writePluginManifest(join(tmpHome, 'beta'));

    const result = scanLocalPlugins(tmpHome);
    expect(result.length).toBe(2);
    expect(result.map((p) => p.path).sort()).toEqual([
      join(tmpHome, 'alpha'),
      join(tmpHome, 'beta'),
    ]);
  });

  it('does not descend past a discovered plugin (plugins are leaf nodes)', () => {
    const pluginDir = join(tmpHome, 'outer');
    writePluginManifest(pluginDir);
    writePluginManifest(join(pluginDir, 'nested'));

    expect(scanLocalPlugins(tmpHome)).toEqual([{ type: 'local', path: pluginDir }]);
  });

  it('skips plugins whose .index.json entry has enabled:false', () => {
    writePluginManifest(join(tmpHome, 'enabled-one'));
    writePluginManifest(join(tmpHome, 'disabled-one'));
    writeFileSync(
      join(tmpHome, '.index.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'enabled-one': {
            source: 'x', sourceType: 'local', ref: null, commit: null,
            enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          },
          'disabled-one': {
            source: 'x', sourceType: 'local', ref: null, commit: null,
            enabled: false, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      }),
    );

    const result = scanLocalPlugins(tmpHome);
    expect(result.map((p) => p.path)).toEqual([join(tmpHome, 'enabled-one')]);
  });

  it('preserves scanner behavior when .index.json is missing (default-enabled)', () => {
    writePluginManifest(join(tmpHome, 'hand-dropped'));
    const result = scanLocalPlugins(tmpHome);
    expect(result.map((p) => p.path)).toEqual([join(tmpHome, 'hand-dropped')]);
  });

  it('tolerates an index entry pointing at a dir that no longer exists', () => {
    writePluginManifest(join(tmpHome, 'still-here'));
    writeFileSync(
      join(tmpHome, '.index.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          'still-here': {
            source: 'x', sourceType: 'local', ref: null, commit: null,
            enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          },
          'removed-by-hand': {
            source: 'x', sourceType: 'local', ref: null, commit: null,
            enabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      }),
    );

    // Does not throw — the scanner simply never encounters `removed-by-hand`.
    const result = scanLocalPlugins(tmpHome);
    expect(result.map((p) => p.path)).toEqual([join(tmpHome, 'still-here')]);
  });
});
