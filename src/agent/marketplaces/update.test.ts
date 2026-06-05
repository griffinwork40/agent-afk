/**
 * Tests for the marketplace updater. Uses a fake git runner plus on-disk
 * `marketplace.json` + per-plugin `plugin.json` fixtures so the branch-advance
 * logic and the post-update version surfacing are both exercised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateMarketplace, updateAllMarketplaces } from './update.js';
import {
  readIndex,
  upsertMarketplace,
  type MarketplaceIndexEntry,
} from '../plugins/index-store.js';
import type { GitRunner } from '../plugins/git.js';

let tmpDir: string;
let cacheDir: string;
let indexPath: string;

function seedMarketplace(name: string, entry: Partial<MarketplaceIndexEntry> = {}): void {
  const full: MarketplaceIndexEntry = {
    source: 'owner/repo',
    sourceType: 'github',
    ref: 'main',
    commit: 'oldsha',
    installedAt: '2026-04-20T12:00:00Z',
    updatedAt: '2026-04-20T12:00:00Z',
    ...entry,
  };
  upsertMarketplace(name, full, indexPath);
}

/** Write `<cacheDir>/<name>/.claude-plugin/marketplace.json` listing `plugins`. */
function writeCatalog(
  name: string,
  plugins: { name: string; source: string }[],
): string {
  const dir = join(cacheDir, name);
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name, plugins }, null, 2),
    'utf8',
  );
  return dir;
}

/** Write a plugin's `<relSource>/.claude-plugin/plugin.json` with `version`. */
function writePlugin(marketplaceDir: string, relSource: string, version: string): void {
  const pdir = join(marketplaceDir, relSource, '.claude-plugin');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, 'plugin.json'), JSON.stringify({ name: relSource, version }), 'utf8');
}

// Ref-aware, stateful fake git runner (see update.test.ts for the rationale):
// `refs/remotes/origin/<name>` resolves only for names in `remoteBranches`,
// and `checkout refs/remotes/origin/<name>` advances HEAD to that tip. HEAD is
// keyed by `cwd` so `updateAllMarketplaces` (which shares one runner across
// repos) models each marketplace's working tree independently.
function makeRunner(
  tags: string[],
  headSha = 'newsha',
  remoteBranches: Record<string, string> = {},
): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const heads = new Map<string, string>();
  const headFor = (cwd: string | undefined): string => heads.get(cwd ?? '') ?? headSha;
  const runner: GitRunner = async (args, cwd) => {
    const a = Array.from(args);
    calls.push(a);
    if (a.includes('checkout')) {
      const ref = a[a.length - 1] ?? '';
      const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
      if (m && remoteBranches[m[1]!] !== undefined) heads.set(cwd ?? '', remoteBranches[m[1]!]!);
      return { stdout: '', stderr: '' };
    }
    if (a[0] === 'tag') return { stdout: tags.join('\n') + '\n', stderr: '' };
    if (a[0] === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
    if (a[0] === 'rev-parse') {
      const rev = a[a.length - 1] ?? '';
      if (rev === 'HEAD') return { stdout: headFor(cwd) + '\n', stderr: '' };
      const m = rev.match(/^refs\/remotes\/origin\/(.+)$/);
      if (m) {
        const sha = remoteBranches[m[1]!];
        if (sha !== undefined) return { stdout: sha + '\n', stderr: '' };
        throw new Error('fatal: Needed a single revision');
      }
      const tagM = rev.match(/^refs\/tags\/(.+)$/);
      if (tagM) {
        if (tags.includes(tagM[1]!)) return { stdout: `tagsha-${tagM[1]}\n`, stderr: '' };
        throw new Error('fatal: Needed a single revision'); // unknown tag → null
      }
      return { stdout: headFor(cwd) + '\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-mp-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cacheDir = join(tmpDir, 'cache');
  indexPath = join(tmpDir, '.index.json');
  mkdirSync(cacheDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('updateMarketplace — branch-tracked installs (no semver tags)', () => {
  it('advances to the fetched origin/<branch> tip and surfaces plugin versions', async () => {
    seedMarketplace('mp', { ref: 'main', commit: 'oldsha' });
    const dir = writeCatalog('mp', [
      { name: 'sample-plugin', source: './plugins/sample-plugin' },
      { name: 'example-plugin', source: './plugins/example-plugin' },
    ]);
    writePlugin(dir, './plugins/sample-plugin', '2.5.1');
    writePlugin(dir, './plugins/example-plugin', '2.0.6');

    const { runner, calls } = makeRunner([], 'oldsha', { main: 'newsha' });
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date('2026-05-01T00:00:00Z') },
    );

    expect(outcome).toEqual({
      name: 'mp',
      status: 'updated',
      fromRef: 'main',
      toRef: 'main',
      commit: 'newsha',
      addedPlugins: [],
      removedPlugins: [],
      pluginVersions: [
        { name: 'sample-plugin', version: '2.5.1' },
        { name: 'example-plugin', version: '2.0.6' },
      ],
    });

    const idx = readIndex(indexPath);
    expect(idx.marketplaces['mp'].commit).toBe('newsha');
    // Must detach at the fetched remote ref, not the stale local branch name.
    const checkout = calls.find((c) => c.includes('checkout'));
    expect(checkout?.[checkout.length - 1]).toBe('refs/remotes/origin/main');
  });

  it('reports up-to-date when the branch tip already matches local HEAD', async () => {
    seedMarketplace('mp', { ref: 'main', commit: 'samesha' });
    writeCatalog('mp', [{ name: 'sample-plugin', source: './plugins/sample-plugin' }]);
    const { runner, calls } = makeRunner([], 'samesha', { main: 'samesha' });
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('up-to-date');
    if (outcome.status === 'up-to-date') expect(outcome.commit).toBe('samesha');
    expect(calls.some((c) => c.includes('checkout'))).toBe(false);
  });

  it('reports null version for non-local plugin sources', async () => {
    seedMarketplace('mp', { ref: 'main', commit: 'oldsha' });
    writeCatalog('mp', [{ name: 'remote-plugin', source: 'owner/remote-plugin' }]);
    const { runner } = makeRunner([], 'oldsha', { main: 'newsha' });
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('updated');
    if (outcome.status === 'updated') {
      expect(outcome.pluginVersions).toEqual([{ name: 'remote-plugin', version: null }]);
    }
  });
});


describe('updateMarketplace — branch-tracked install with a same-named tag', () => {
  it('advances a branch-tracked install even when a same-named (non-semver) tag exists', async () => {
    // Tracks branch `main`; repo also has a tag literally named `main` (non-semver).
    // The same-named tag must NOT freeze branch tracking.
    seedMarketplace('mp', { ref: 'main', commit: 'oldsha' });
    const dir = writeCatalog('mp', [{ name: 'sample-plugin', source: './plugins/sample-plugin' }]);
    writePlugin(dir, './plugins/sample-plugin', '2.5.1');
    const { runner, calls } = makeRunner(['main'], 'oldsha', { main: 'newsha' });
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date('2026-05-01T00:00:00Z') },
    );
    expect(outcome.status).toBe('updated');
    if (outcome.status === 'updated') expect(outcome.toRef).toBe('main');
    const checkout = calls.find((c) => c.includes('checkout'));
    expect(checkout?.[checkout.length - 1]).toBe('refs/remotes/origin/main');
  });
});

describe('updateMarketplace — tag-tracked installs (immutable)', () => {
  it('updates to a newer tag via ref-name comparison', async () => {
    seedMarketplace('mp', { ref: 'v1.0.0', commit: 'oldsha' });
    const dir = writeCatalog('mp', [{ name: 'sample-plugin', source: './plugins/sample-plugin' }]);
    writePlugin(dir, './plugins/sample-plugin', '2.5.1');
    const { runner, calls } = makeRunner(['v2.0.0', 'v1.0.0'], 'newsha');
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('updated');
    if (outcome.status === 'updated') {
      expect(outcome.fromRef).toBe('v1.0.0');
      expect(outcome.toRef).toBe('v2.0.0');
    }
    // Tags are immutable → checkout via explicit refs/tags/ ref, not a bare name or remote ref.
    const checkout = calls.find((c) => c.includes('checkout'));
    expect(checkout?.[checkout.length - 1]).toBe('refs/tags/v2.0.0');
  });

  it('reports up-to-date when the latest tag matches the index ref', async () => {
    seedMarketplace('mp', { ref: 'v2.0.0', commit: 'samesha' });
    writeCatalog('mp', [{ name: 'sample-plugin', source: './plugins/sample-plugin' }]);
    const { runner } = makeRunner(['v2.0.0'], 'samesha');
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('up-to-date');
  });
});

describe('updateMarketplace — tag/branch name collision', () => {
  it('checks out the tag, not a same-named remote branch, when both exist', async () => {
    seedMarketplace('mp', { ref: 'v1.0.0', commit: 'oldsha' });
    const dir = writeCatalog('mp', [{ name: 'sample-plugin', source: './plugins/sample-plugin' }]);
    writePlugin(dir, './plugins/sample-plugin', '2.5.1');
    // v2.0.0 exists as BOTH a tag AND a remote branch tip; tag must win.
    const { runner, calls } = makeRunner(['v2.0.0', 'v1.0.0'], 'oldsha', { 'v2.0.0': 'branchtip' });
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date('2026-05-01T00:00:00Z') },
    );
    expect(outcome.status).toBe('updated');
    if (outcome.status === 'updated') {
      expect(outcome.toRef).toBe('v2.0.0');
    }
    const checkout = calls.find((c) => c.includes('checkout'));
    expect(checkout?.[checkout.length - 1]).toBe('refs/tags/v2.0.0');
    // Must NOT have checked out the remote branch ref.
    expect(calls.some((c) => c.includes('checkout') && c[c.length - 1] === 'refs/remotes/origin/v2.0.0')).toBe(false);
  });

  it('stays up-to-date on a tag-pinned install even when a same-named branch advanced', async () => {
    // Already on the latest tag; a same-named branch has advanced, but we must not follow it.
    seedMarketplace('mp', { ref: 'v2.0.0', commit: 'tagcommit' });
    writeCatalog('mp', [{ name: 'sample-plugin', source: './plugins/sample-plugin' }]);
    const { runner, calls } = makeRunner(['v2.0.0'], 'tagcommit', { 'v2.0.0': 'branchtip' });
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('up-to-date');
    expect(calls.some((c) => c.includes('checkout'))).toBe(false);
  });
});

describe('updateMarketplace — edge cases', () => {
  it('skips local marketplaces', async () => {
    seedMarketplace('mp', { sourceType: 'local', ref: null, commit: null });
    mkdirSync(join(cacheDir, 'mp'), { recursive: true });
    const { runner } = makeRunner([]);
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('skipped-local');
  });

  it('returns missing-dir when the marketplace dir is gone', async () => {
    seedMarketplace('mp', { ref: 'main' });
    const { runner } = makeRunner([]);
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('missing-dir');
  });

  it('throws when the marketplace is not installed', async () => {
    const { runner } = makeRunner([]);
    await expect(
      updateMarketplace('unknown', {}, { cacheDir, indexPath, gitRunner: runner, now: () => new Date() }),
    ).rejects.toThrow(/not installed/);
  });
});

describe('updateMarketplace — absolute-source version resolution', () => {
  it('resolves the version for a plugin installed from an absolute path outside the marketplace dir', async () => {
    // A plugin whose `source` is an absolute path outside cacheDir.
    // Before the fix, join(marketplaceDir, '/tmp/...') mangled the path, so version was null.
    const ext = join(tmpDir, 'external-plugin');
    mkdirSync(join(ext, '.claude-plugin'), { recursive: true });
    writeFileSync(join(ext, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ext', version: '9.9.9' }), 'utf8');

    seedMarketplace('mp', { ref: 'v1.0.0', commit: 'oldsha' });
    writeCatalog('mp', [{ name: 'ext', source: ext }]);
    const { runner } = makeRunner(['v2.0.0'], 'newsha');
    const outcome = await updateMarketplace(
      'mp',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('updated');
    if (outcome.status === 'updated') {
      expect(outcome.pluginVersions).toContainEqual({ name: 'ext', version: '9.9.9' });
    }
  });
});

describe('updateAllMarketplaces', () => {
  it('iterates every marketplace in the index', async () => {
    seedMarketplace('alpha', { ref: 'main', commit: 'oldsha' });
    seedMarketplace('beta', { ref: 'main', commit: 'oldsha' });
    writeCatalog('alpha', [{ name: 'p', source: './plugins/p' }]);
    writeCatalog('beta', [{ name: 'p', source: './plugins/p' }]);
    const { runner } = makeRunner([], 'oldsha', { main: 'newsha' });
    const results = await updateAllMarketplaces({
      cacheDir,
      indexPath,
      gitRunner: runner,
      now: () => new Date(),
    });
    expect(results.map((r) => r.name).sort()).toEqual(['alpha', 'beta']);
    expect(results.every((r) => r.status === 'updated')).toBe(true);
  });
});
