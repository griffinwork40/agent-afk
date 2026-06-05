/**
 * Tests for the marketplace resolver. Covers in-marketplace local plugins
 * (relative `source` path) and listMarketplacePlugins's installed-vs-available
 * markers. Git-fanout coverage lives in the install harness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installFromMarketplace,
  listMarketplacePlugins,
} from './resolve.js';
import { readIndex, upsertPlugin } from '../plugins/index-store.js';

let tmpDir: string;
let cacheDir: string;
let indexPath: string;

function writeMarketplace(
  dir: string,
  name: string,
  plugins: { name: string; source: string; description?: string }[],
): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name, plugins }),
  );
}

function writePlugin(dir: string, name: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.0.0' }),
  );
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-mp-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cacheDir = join(tmpDir, 'cache');
  indexPath = join(tmpDir, '.index.json');
  mkdirSync(cacheDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('installFromMarketplace — in-marketplace local plugin', () => {
  it('upserts an enabled <mp>:<plugin> entry pointing at the in-cache plugin dir', async () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplace(mpDir, 'mp', [{ name: 'foo', source: './plugins/foo' }]);
    writePlugin(join(mpDir, 'plugins', 'foo'), 'foo');

    const result = await installFromMarketplace(
      'mp',
      'foo',
      {},
      {
        marketplaceDirFor: (n) => join(cacheDir, n),
        indexPath,
        now: () => new Date('2026-04-20T12:00:00Z'),
      },
    );

    expect(result.key).toBe('mp:foo');
    expect(result.dir).toBe(join(mpDir, 'plugins', 'foo'));

    const idx = readIndex(indexPath);
    expect(idx.plugins['mp:foo']).toMatchObject({
      sourceType: 'marketplace',
      enabled: true,
      marketplace: 'mp',
    });
  });

  it('throws when the marketplace is not installed', async () => {
    await expect(
      installFromMarketplace('missing', 'foo', {}, {
        marketplaceDirFor: (n) => join(cacheDir, n),
        indexPath,
      }),
    ).rejects.toThrow(/not installed/);
  });

  it('throws when the plugin is not listed in the manifest', async () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplace(mpDir, 'mp', [{ name: 'foo', source: './plugins/foo' }]);

    await expect(
      installFromMarketplace('mp', 'bar', {}, {
        marketplaceDirFor: (n) => join(cacheDir, n),
        indexPath,
      }),
    ).rejects.toThrow(/does not list a plugin named "bar"/);
  });

  it('throws when the listed plugin dir is missing', async () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplace(mpDir, 'mp', [{ name: 'foo', source: './plugins/foo' }]);
    // …but never write the plugin dir.

    await expect(
      installFromMarketplace('mp', 'foo', {}, {
        marketplaceDirFor: (n) => join(cacheDir, n),
        indexPath,
      }),
    ).rejects.toThrow(/does not exist on disk/);
  });

  it('refuses to overwrite an existing enabled install without --force', async () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplace(mpDir, 'mp', [{ name: 'foo', source: './plugins/foo' }]);
    writePlugin(join(mpDir, 'plugins', 'foo'), 'foo');

    await installFromMarketplace('mp', 'foo', {}, {
      marketplaceDirFor: (n) => join(cacheDir, n),
      indexPath,
    });
    await expect(
      installFromMarketplace('mp', 'foo', {}, {
        marketplaceDirFor: (n) => join(cacheDir, n),
        indexPath,
      }),
    ).rejects.toThrow(/already installed/);
  });
});

describe('listMarketplacePlugins', () => {
  it('marks installed entries based on the index', () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplace(mpDir, 'mp', [
      { name: 'a', source: './plugins/a', description: 'first' },
      { name: 'b', source: './plugins/b' },
    ]);

    upsertPlugin(
      'mp:a',
      {
        source: 'mp:a',
        sourceType: 'marketplace',
        ref: null,
        commit: null,
        enabled: true,
        installedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        marketplace: 'mp',
      },
      indexPath,
    );

    const result = listMarketplacePlugins('mp', {
      marketplaceDirFor: (n) => join(cacheDir, n),
      indexPath,
    });
    expect(result).toEqual([
      { name: 'a', description: 'first', installed: true, key: 'mp:a' },
      { name: 'b', installed: false, key: 'mp:b' },
    ]);
  });

  it('throws when the marketplace is not installed', () => {
    expect(() =>
      listMarketplacePlugins('missing', {
        marketplaceDirFor: (n) => join(cacheDir, n),
        indexPath,
      }),
    ).toThrow(/not installed/);
  });
});
