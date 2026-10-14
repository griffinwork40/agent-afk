/**
 * Tests for the marketplace resolver. Covers in-marketplace local plugins
 * (relative `source` path), listMarketplacePlugins's installed-vs-available
 * markers, skipped-entry refusals, and object source handling.
 * Git-fanout coverage lives in the install harness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installFromMarketplace,
  listMarketplacePlugins,
} from './resolve.js';
import { readIndex, upsertPlugin } from '../plugins/index-store.js';
import type { GitRunner } from '../plugins/git.js';
import { subcommandOf } from '../plugins/git-test-helpers.js';

let tmpDir: string;
let cacheDir: string;
let indexPath: string;

function writeMarketplace(
  dir: string,
  name: string,
  plugins: unknown[],
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

describe('installFromMarketplace — skipped entries', () => {
  it('refuses to install a skipped entry (unknown object source discriminator)', async () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplace(mpDir, 'mp', [
      { name: 'future', source: { source: 'some-future-type', location: 'x' } },
    ]);

    await expect(
      installFromMarketplace('mp', 'future', {}, {
        marketplaceDirFor: (n) => join(cacheDir, n),
        indexPath,
      }),
    ).rejects.toThrow(/cannot be installed/);
  });

  it('refuses to install a skipped entry (git-subdir missing url)', async () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplace(mpDir, 'mp', [
      { name: 'bad', source: { source: 'git-subdir', path: 'plugins/bad' } },
    ]);

    await expect(
      installFromMarketplace('mp', 'bad', {}, {
        marketplaceDirFor: (n) => join(cacheDir, n),
        indexPath,
      }),
    ).rejects.toThrow(/cannot be installed/);
  });

  it('still allows installing a valid entry alongside a skipped one', async () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplace(mpDir, 'mp', [
      { name: 'good', source: './plugins/good' },
      { name: 'bad', source: { source: 'unknown-type', x: 1 } },
    ]);
    writePlugin(join(mpDir, 'plugins', 'good'), 'good');

    // 'good' should install without issue even though 'bad' is in the same manifest
    const result = await installFromMarketplace('mp', 'good', {}, {
      marketplaceDirFor: (n) => join(cacheDir, n),
      indexPath,
    });
    expect(result.key).toBe('mp:good');
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

  it('surfaces the skipped reason for object-sourced entries', () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplace(mpDir, 'mp', [
      { name: 'a', source: './plugins/a' },
      { name: 'future', source: { source: 'unknown-type', extra: 'data' } },
      {
        name: 'subdir-plugin',
        source: {
          source: 'git-subdir',
          url: 'https://github.com/anthropics/claude-plugins-official',
          path: 'plugins/subdir-plugin',
          ref: 'main',
        },
      },
    ]);

    const result = listMarketplacePlugins('mp', {
      marketplaceDirFor: (n) => join(cacheDir, n),
      indexPath,
    });
    expect(result).toHaveLength(3);
    expect(result[0]!.skipped).toBeUndefined();
    expect(result[1]!.skipped).toMatch(/unsupported source type/);
    expect(result[2]!.skipped).toBeUndefined();
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

// ---------------------------------------------------------------------------
// git-subdir path: plugin.json probe + cloneDir cleanup (#3558)
// ---------------------------------------------------------------------------

function writeMarketplaceGitSubdir(mpDir: string, mpName: string, pluginName: string, subPath: string): void {
  mkdirSync(join(mpDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(mpDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: mpName,
      plugins: [
        {
          name: pluginName,
          source: {
            source: 'git-subdir',
            url: 'https://github.com/example/repo',
            path: subPath,
            ref: 'main',
          },
        },
      ],
    }),
  );
}

function makeGitSubdirRunner(
  options: { writePluginJson?: boolean; failAt?: 'clone' | 'checkout' } = {},
): GitRunner {
  const { writePluginJson = true, failAt } = options;
  return async (args) => {
    const sub = subcommandOf(args);
    if (sub === 'clone') {
      const dest = args[args.length - 1] as string;
      // Always create the subdir so path-not-found doesn't fire before plugin.json check
      const pluginDir = join(dest, 'plugins', 'myplugin');
      mkdirSync(pluginDir, { recursive: true });
      if (failAt === 'clone') throw new Error('simulated clone failure');
      if (writePluginJson) {
        mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
        writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'myplugin', version: '0.0.1' }));
      }
      return { stdout: '', stderr: '' };
    }
    if (sub === 'tag') return { stdout: '', stderr: '' };
    if (sub === 'rev-parse') return { stdout: 'abc1234\n', stderr: '' };
    if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
    if (sub === 'checkout') {
      if (failAt === 'checkout') throw new Error('simulated checkout failure');
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

describe('installFromMarketplace — git-subdir plugin.json probe (#3558)', () => {
  it('preserves a pre-existing checkout when a repeated clone fails', async () => {
    const mpDir = join(cacheDir, 'existing');
    writeMarketplaceGitSubdir(mpDir, 'existing', 'myplugin', 'plugins/myplugin');
    const cloneDir = join(mpDir, '.git-subdir-clones', 'myplugin');
    mkdirSync(cloneDir, { recursive: true });
    const sentinel = join(cloneDir, 'keep.txt');
    writeFileSync(sentinel, 'existing checkout');
    await expect(installFromMarketplace(
      'existing', 'myplugin', { force: true },
      { marketplaceDirFor: () => mpDir, indexPath, gitRunner: makeGitSubdirRunner({ failAt: 'clone' }) },
    )).rejects.toThrow('simulated clone failure');
    expect(existsSync(sentinel)).toBe(true);
  });

  it.each(['clone', 'checkout'] as const)('cleans up a failed %s without indexing the plugin', async (failAt) => {
    const mpDir = join(cacheDir, 'failed');
    writeMarketplaceGitSubdir(mpDir, 'failed', 'myplugin', 'plugins/myplugin');
    const runner = makeGitSubdirRunner({ failAt });
    await expect(installFromMarketplace(
      'failed', 'myplugin', { ref: 'feature' },
      { marketplaceDirFor: () => mpDir, indexPath, gitRunner: runner },
    )).rejects.toThrow(`simulated ${failAt} failure`);
    expect(existsSync(join(mpDir, '.git-subdir-clones', 'myplugin'))).toBe(false);
    expect(readIndex(indexPath).plugins['failed:myplugin']).toBeUndefined();
  });

  it('succeeds when the subdir contains .claude-plugin/plugin.json', async () => {
    const mpDir = join(cacheDir, 'mp');
    writeMarketplaceGitSubdir(mpDir, 'mp', 'myplugin', 'plugins/myplugin');
    const runner = makeGitSubdirRunner();

    const result = await installFromMarketplace(
      'mp', 'myplugin', { ref: 'main' },
      { marketplaceDirFor: (n) => join(cacheDir, n), indexPath, gitRunner: runner },
    );
    expect(result.key).toBe('mp:myplugin');
    expect(result.dir).toBe(join(mpDir, '.git-subdir-clones', 'myplugin', 'plugins', 'myplugin'));

    const idx = readIndex(indexPath);
    expect(idx.plugins['mp:myplugin']).toMatchObject({ enabled: true, marketplace: 'mp' });
  });

  it('throws and cleans up cloneDir when .claude-plugin/plugin.json is absent in subdir', async () => {
    const mpDir = join(cacheDir, 'mp2');
    writeMarketplaceGitSubdir(mpDir, 'mp2', 'myplugin', 'plugins/myplugin');
    const runner = makeGitSubdirRunner({ writePluginJson: false });

    await expect(
      installFromMarketplace(
        'mp2', 'myplugin', { ref: 'main' },
        { marketplaceDirFor: (n) => join(cacheDir, n), indexPath, gitRunner: runner },
      ),
    ).rejects.toThrow(/plugin\.json/);

    // cloneDir should have been cleaned up
    const cloneDir = join(mpDir, '.git-subdir-clones', 'myplugin');
    expect(existsSync(cloneDir)).toBe(false);
  });

  it('cleans up cloneDir when subdir path is not found in clone', async () => {
    const mpDir = join(cacheDir, 'mp3');
    writeMarketplaceGitSubdir(mpDir, 'mp3', 'myplugin', 'plugins/nonexistent');
    // runner writes plugin.json under different path — subdir won't exist
    const runner = makeGitSubdirRunner();

    await expect(
      installFromMarketplace(
        'mp3', 'myplugin', { ref: 'main' },
        { marketplaceDirFor: (n) => join(cacheDir, n), indexPath, gitRunner: runner },
      ),
    ).rejects.toThrow(/not found in clone/);

    const cloneDir = join(mpDir, '.git-subdir-clones', 'myplugin');
    expect(existsSync(cloneDir)).toBe(false);
  });
});
