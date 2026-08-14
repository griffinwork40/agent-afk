/**
 * Tests for the plugin updater. Uses a fake git runner and a pre-seeded
 * index file to simulate the "already-installed" state.
 */

// [F2] Hoist the scan-cache mock so update.ts picks it up at module load.
const resetScanCache = vi.hoisted(() => vi.fn());
vi.mock('../plugins-scanner.js', () => ({ _resetPluginScanCache: resetScanCache, scanLocalPlugins: vi.fn(() => []) }));

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updatePlugin, updateAll } from './update.js';
import { readIndex, upsertPlugin, upsertMarketplace, type PluginIndexEntry } from './index-store.js';
import type { GitRunner } from './git.js';

let tmpDir: string;
let pluginsDir: string;
let cacheDir: string;
let indexPath: string;

function seed(name: string, entry: Partial<PluginIndexEntry> = {}): PluginIndexEntry {
  const full: PluginIndexEntry = {
    source: 'owner/repo',
    sourceType: 'github',
    ref: 'v1.0.0',
    commit: 'abc',
    enabled: true,
    installedAt: '2026-04-20T12:00:00Z',
    updatedAt: '2026-04-20T12:00:00Z',
    ...entry,
  };
  mkdirSync(join(pluginsDir, name), { recursive: true });
  upsertPlugin(name, full, indexPath);
  return full;
}

// Ref-aware, stateful fake git runner.
//   - `headSha` is the local HEAD before any checkout.
//   - `remoteBranches` maps branch name → the sha `refs/remotes/origin/<name>`
//     resolves to after fetch. A name absent from the map (e.g. a tag) makes
//     `rev-parse --verify --quiet refs/remotes/origin/<name>` fail, exactly as
//     real git does — that's how the updater tells a branch from a tag.
//   - `checkout refs/remotes/origin/<name>` moves HEAD to the branch tip, so a
//     subsequent `rev-parse HEAD` reflects the advance (faithful to real git).
function makeRunner(
  tags: string[],
  headSha = 'newsha',
  remoteBranches: Record<string, string> = {},
): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  let currentHead = headSha;
  const runner: GitRunner = async (args) => {
    const a = Array.from(args);
    calls.push(a);
    if (a.includes('checkout')) {
      const ref = a[a.length - 1] ?? '';
      const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
      if (m && remoteBranches[m[1]!] !== undefined) currentHead = remoteBranches[m[1]!]!;
      return { stdout: '', stderr: '' };
    }
    if (a[0] === 'tag') return { stdout: tags.join('\n') + '\n', stderr: '' };
    if (a[0] === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
    if (a[0] === 'rev-parse') {
      const rev = a[a.length - 1] ?? '';
      if (rev === 'HEAD') return { stdout: currentHead + '\n', stderr: '' };
      const m = rev.match(/^refs\/remotes\/origin\/(.+)$/);
      if (m) {
        const sha = remoteBranches[m[1]!];
        if (sha !== undefined) return { stdout: sha + '\n', stderr: '' };
        throw new Error('fatal: Needed a single revision'); // unknown ref → null
      }
      const tagM = rev.match(/^refs\/tags\/(.+)$/);
      if (tagM) {
        if (tags.includes(tagM[1]!)) return { stdout: `tagsha-${tagM[1]}\n`, stderr: '' };
        throw new Error('fatal: Needed a single revision'); // unknown tag → null
      }
      return { stdout: currentHead + '\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  pluginsDir = join(tmpDir, 'plugins');
  cacheDir = join(tmpDir, 'cache');
  indexPath = join(pluginsDir, '.index.json');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  resetScanCache.mockClear();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('updatePlugin', () => {
  it('updates to a newer tag', async () => {
    seed('my-plugin', { ref: 'v1.0.0' });
    const { runner } = makeRunner(['v2.0.0', 'v1.0.0'], 'newsha');
    const outcome = await updatePlugin(
      'my-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date('2026-05-01T00:00:00Z') },
    );
    expect(outcome).toEqual({
      name: 'my-plugin',
      status: 'updated',
      fromRef: 'v1.0.0',
      toRef: 'v2.0.0',
      commit: 'newsha',
      version: null,
    });
    const idx = readIndex(indexPath);
    expect(idx.plugins['my-plugin'].ref).toBe('v2.0.0');
    expect(idx.plugins['my-plugin'].commit).toBe('newsha');
  });

  it('reports up-to-date when the latest tag matches the index ref', async () => {
    seed('my-plugin', { ref: 'v2.0.0' });
    const { runner } = makeRunner(['v2.0.0'], 'samesha');
    const outcome = await updatePlugin(
      'my-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('up-to-date');
  });

  it('skips local plugins', async () => {
    seed('local-plugin', { sourceType: 'local', ref: null, commit: null });
    const { runner } = makeRunner(['v2.0.0']);
    const outcome = await updatePlugin(
      'local-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('skipped-local');
  });

  it('returns missing-dir when the plugin dir has been nuked by hand', async () => {
    seed('gone-plugin');
    rmSync(join(pluginsDir, 'gone-plugin'), { recursive: true });
    const { runner } = makeRunner(['v2.0.0']);
    const outcome = await updatePlugin(
      'gone-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('missing-dir');
  });

  it('throws when the plugin is not in the index', async () => {
    const { runner } = makeRunner(['v2.0.0']);
    await expect(
      updatePlugin('unknown', {}, { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() }),
    ).rejects.toThrow(/not installed/);
  });
});

// Regression: a branch-tracked install (no semver tags) must advance by
// commit, not ref-name. The old `targetRef === entry.ref` short-circuit froze
// "main" installs forever — `git fetch` moved origin/main but the equality
// check reported up-to-date and never checked out the new tip.
describe('updatePlugin — branch-tracked installs (no semver tags)', () => {
  it('advances to the fetched origin/<branch> tip when the commit moved', async () => {
    seed('branch-plugin', { ref: 'main', commit: 'oldsha', sourceType: 'git' });
    // No tags → branch tracking. origin/main advanced to newsha; local HEAD at oldsha.
    const { runner, calls } = makeRunner([], 'oldsha', { main: 'newsha' });
    const outcome = await updatePlugin(
      'branch-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date('2026-05-01T00:00:00Z') },
    );
    expect(outcome).toEqual({
      name: 'branch-plugin',
      status: 'updated',
      fromRef: 'main',
      toRef: 'main',
      commit: 'newsha',
      version: null,
    });
    const idx = readIndex(indexPath);
    expect(idx.plugins['branch-plugin'].ref).toBe('main');
    expect(idx.plugins['branch-plugin'].commit).toBe('newsha');
    // Must detach at the fetched REMOTE ref, never the bare branch name
    // (which `--detach` would resolve to the stale local branch).
    const checkout = calls.find((c) => c.includes('checkout'));
    expect(checkout?.[checkout.length - 1]).toBe('refs/remotes/origin/main');
    // --force so a dirty cache (drifted tracked file) can't wedge the update.
    expect(checkout).toContain('--force');
  });

  it('reports up-to-date when the branch tip already matches local HEAD', async () => {
    seed('branch-plugin', { ref: 'main', commit: 'samesha', sourceType: 'git' });
    const { runner, calls } = makeRunner([], 'samesha', { main: 'samesha' });
    const outcome = await updatePlugin(
      'branch-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('up-to-date');
    if (outcome.status === 'up-to-date') expect(outcome.commit).toBe('samesha');
    // Nothing moved → no checkout.
    expect(calls.some((c) => c.includes('checkout'))).toBe(false);
  });

  it('falls back to the default branch when the index ref is null', async () => {
    seed('branch-plugin', { ref: null, commit: 'oldsha', sourceType: 'git' });
    // symbolic-ref → origin/main; origin/main advanced to newsha.
    const { runner } = makeRunner([], 'oldsha', { main: 'newsha' });
    const outcome = await updatePlugin(
      'branch-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('updated');
    if (outcome.status === 'updated') {
      expect(outcome.toRef).toBe('main');
      expect(outcome.commit).toBe('newsha');
    }
  });
});

describe('updatePlugin — branch-tracked install with a same-named tag', () => {
  it('advances a branch-tracked install even when a same-named (non-semver) tag exists', async () => {
    // Tracks branch `main`; repo also has a tag literally named `main` (non-semver).
    // The same-named tag must NOT freeze branch tracking.
    seed('my-plugin', { ref: 'main', commit: 'oldsha' });
    const { runner, calls } = makeRunner(['main'], 'oldsha', { main: 'newsha' });
    const outcome = await updatePlugin(
      'my-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date('2026-05-01T00:00:00Z') },
    );
    expect(outcome.status).toBe('updated');
    if (outcome.status === 'updated') expect(outcome.toRef).toBe('main');
    const checkout = calls.find((c) => c.includes('checkout'));
    expect(checkout?.[checkout.length - 1]).toBe('refs/remotes/origin/main');
  });
});

describe('updatePlugin — tag/branch name collision', () => {
  it('checks out the tag, not a same-named remote branch, when both exist', async () => {
    seed('my-plugin', { ref: 'v1.0.0' });
    // v2.0.0 exists as BOTH a tag AND a remote branch tip; tag must win.
    const { runner, calls } = makeRunner(['v2.0.0', 'v1.0.0'], 'oldsha', { 'v2.0.0': 'branchtip' });
    const outcome = await updatePlugin(
      'my-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date('2026-05-01T00:00:00Z') },
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
    seed('my-plugin', { ref: 'v2.0.0', commit: 'tagcommit' });
    const { runner, calls } = makeRunner(['v2.0.0'], 'tagcommit', { 'v2.0.0': 'branchtip' });
    const outcome = await updatePlugin(
      'my-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('up-to-date');
    expect(calls.some((c) => c.includes('checkout'))).toBe(false);
  });
});

describe('updateAll', () => {
  it('iterates every plugin in the index', async () => {
    seed('alpha', { ref: 'v1.0.0' });
    seed('beta', { ref: 'v1.0.0' });
    const { runner } = makeRunner(['v2.0.0'], 'sha');
    const results = await updateAll({ pluginsDir, indexPath, gitRunner: runner, now: () => new Date() });
    expect(results.map((r) => r.name).sort()).toEqual(['alpha', 'beta']);
    expect(results.every((r) => r.status === 'updated')).toBe(true);
  });
});

// Invariant: every update attempt that touches a present plugin dir must
// refresh the scan cache, even on the up-to-date and skipped-local fast
// paths — symlink targets and working trees can change without the index
// ref moving. Missing-dir and not-installed cases must NOT trigger the
// reset because no operation was attempted. (F2)
describe('updatePlugin — cache invalidation (F2)', () => {
  it('calls _resetPluginScanCache when an update succeeds', async () => {
    seed('my-plugin', { ref: 'v1.0.0' });
    const { runner } = makeRunner(['v2.0.0'], 'newsha');
    await updatePlugin('my-plugin', {}, { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() });
    expect(resetScanCache).toHaveBeenCalledTimes(1);
  });

  it('calls _resetPluginScanCache on the up-to-date fast path', async () => {
    seed('my-plugin', { ref: 'v2.0.0' });
    const { runner } = makeRunner(['v2.0.0'], 'samesha');
    const outcome = await updatePlugin('my-plugin', {}, { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() });
    expect(outcome.status).toBe('up-to-date');
    expect(resetScanCache).toHaveBeenCalledTimes(1);
  });

  it('calls _resetPluginScanCache when a local plugin is skipped', async () => {
    seed('local-plugin', { sourceType: 'local', ref: null, commit: null });
    const { runner } = makeRunner(['v2.0.0']);
    const outcome = await updatePlugin('local-plugin', {}, { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() });
    expect(outcome.status).toBe('skipped-local');
    expect(resetScanCache).toHaveBeenCalledTimes(1);
  });

  it('does NOT call _resetPluginScanCache when the plugin dir is missing', async () => {
    seed('gone-plugin');
    rmSync(join(pluginsDir, 'gone-plugin'), { recursive: true });
    const { runner } = makeRunner(['v2.0.0']);
    const outcome = await updatePlugin('gone-plugin', {}, { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() });
    expect(outcome.status).toBe('missing-dir');
    expect(resetScanCache).not.toHaveBeenCalled();
  });

  it('does NOT call _resetPluginScanCache when the plugin is not in the index', async () => {
    const { runner } = makeRunner(['v2.0.0']);
    await expect(
      updatePlugin('unknown', {}, { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() }),
    ).rejects.toThrow(/not installed/);
    expect(resetScanCache).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Marketplace delegation tests (issue #993)
// ---------------------------------------------------------------------------

/**
 * Seed a marketplace entry + its cache dir + a minimal marketplace.json so
 * `updateMarketplace` can parse the catalog without real git plumbing.
 */
function seedMarketplace(
  mpName: string,
  pluginKeys: string[],
  entry: { ref?: string; commit?: string } = {},
): void {
  upsertMarketplace(
    mpName,
    {
      source: 'owner/repo',
      sourceType: 'github',
      ref: entry.ref ?? 'main',
      commit: entry.commit ?? 'oldsha',
      installedAt: '2026-04-20T12:00:00Z',
      updatedAt: '2026-04-20T12:00:00Z',
    },
    indexPath,
  );
  const mpDir = join(cacheDir, mpName);
  mkdirSync(join(mpDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(mpDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: mpName,
      plugins: pluginKeys.map((k) => ({ name: k, source: `./plugins/${k}` })),
    }),
    'utf8',
  );
  for (const k of pluginKeys) {
    const pdir = join(mpDir, 'plugins', k, '.claude-plugin');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, 'plugin.json'), JSON.stringify({ name: k, version: '1.0.0' }), 'utf8');
    // Register the plugin in the index so updatePlugin can find it.
    upsertPlugin(`${mpName}:${k}`, {
      source: `${mpName}:${k}`,
      sourceType: 'marketplace',
      marketplace: mpName,
      ref: null,
      commit: null,
      enabled: true,
      installedAt: '2026-04-20T12:00:00Z',
      updatedAt: '2026-04-20T12:00:00Z',
    }, indexPath);
  }
}

/** Fake git runner for marketplace tests.
 * `localSha` = local HEAD before any checkout; `remoteSha` = what
 * origin/main resolves to. When both are equal, the updater reports up-to-date. */
function makeMarketplaceRunner(remoteSha = 'newsha', localSha = 'oldsha'): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  let head = localSha;
  const runner: GitRunner = async (args) => {
    const a = Array.from(args);
    calls.push(a);
    if (a.includes('checkout')) {
      const ref = a[a.length - 1] ?? '';
      if (ref.startsWith('refs/remotes/origin/')) head = remoteSha;
      return { stdout: '', stderr: '' };
    }
    if (a[0] === 'tag') return { stdout: '\n', stderr: '' };
    if (a[0] === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
    if (a[0] === 'rev-parse') {
      const rev = a[a.length - 1] ?? '';
      if (rev === 'HEAD') return { stdout: head + '\n', stderr: '' };
      if (rev === 'refs/remotes/origin/main') return { stdout: remoteSha + '\n', stderr: '' };
      throw new Error('fatal: Needed a single revision');
    }
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

describe('updatePlugin — marketplace delegation (issue #993)', () => {
  it('delegates to updateMarketplace and reports updated when the clone advanced', async () => {
    seedMarketplace('my-mp', ['plg-a']);
    const { runner } = makeMarketplaceRunner('newsha');
    const outcome = await updatePlugin(
      'my-mp:plg-a',
      {},
      { pluginsDir, indexPath, cacheDir, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome).toMatchObject({
      name: 'my-mp:plg-a',
      status: 'updated',
      toRef: 'main',
      commit: 'newsha',
    });
  });

  it('reports up-to-date when the marketplace clone has not moved', async () => {
    seedMarketplace('my-mp', ['plg-a'], { ref: 'main', commit: 'samesha' });
    // Same SHA on both ends → up-to-date.
    // Pass samesha as both remoteSha and localSha so the runner agrees.
    const { runner } = makeMarketplaceRunner('samesha', 'samesha');
    const outcome = await updatePlugin(
      'my-mp:plg-a',
      {},
      { pluginsDir, indexPath, cacheDir, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('up-to-date');
  });

  it('calls _resetPluginScanCache after marketplace delegation', async () => {
    seedMarketplace('my-mp', ['plg-a']);
    const { runner } = makeMarketplaceRunner('newsha');
    await updatePlugin(
      'my-mp:plg-a',
      {},
      { pluginsDir, indexPath, cacheDir, gitRunner: runner, now: () => new Date() },
    );
    expect(resetScanCache).toHaveBeenCalledTimes(1);
  });

  it('returns missing-dir for a corrupt index entry with no marketplace field', async () => {
    // Seed a plugin with sourceType: 'marketplace' but no marketplace field
    upsertPlugin('bad-mp:plg', {
      source: 'bad-mp:plg',
      sourceType: 'marketplace',
      ref: null,
      commit: null,
      enabled: true,
      installedAt: '2026-04-20T12:00:00Z',
      updatedAt: '2026-04-20T12:00:00Z',
    }, indexPath);
    const { runner } = makeMarketplaceRunner();
    const outcome = await updatePlugin(
      'bad-mp:plg',
      {},
      { pluginsDir, indexPath, cacheDir, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome.status).toBe('missing-dir');
  });
});

describe('updatePlugin — marketplace ref forwarding (P2)', () => {
  it('forwards options.ref to updateMarketplace so the pin is honoured', async () => {
    seedMarketplace('my-mp', ['plg-a']);
    const calls: string[][] = [];
    // Runner that resolves refs/remotes/origin/v1.0.0 as the explicit pin and
    // advances HEAD so updateMarketplace reports "updated".
    const runner: GitRunner = async (args) => {
      const a = Array.from(args);
      calls.push(a);
      if (a.includes('checkout')) return { stdout: '', stderr: '' };
      if (a[0] === 'tag') return { stdout: '\n', stderr: '' };
      if (a[0] === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
      if (a[0] === 'rev-parse') {
        const rev = a[a.length - 1] ?? '';
        if (rev === 'HEAD') return { stdout: 'newsha\n', stderr: '' };
        if (rev === 'refs/remotes/origin/v1.0.0') return { stdout: 'v1sha\n', stderr: '' };
        // oldsha is the HEAD at index time; v1sha != oldsha → update.
        throw new Error('fatal: Needed a single revision');
      }
      return { stdout: '', stderr: '' };
    };
    const outcome = await updatePlugin(
      'my-mp:plg-a',
      { ref: 'v1.0.0' },
      { pluginsDir, indexPath, cacheDir, gitRunner: runner, now: () => new Date() },
    );
    // The rev-parse call for refs/remotes/origin/v1.0.0 must appear, proving
    // the ref was forwarded (updateMarketplace would not check that ref otherwise).
    const revParseCalls = calls.filter((c) => c[0] === 'rev-parse');
    expect(revParseCalls.some((c) => c.includes('refs/remotes/origin/v1.0.0'))).toBe(true);
    // Outcome should report the pinned ref.
    expect(outcome.status).toBe('updated');
    if (outcome.status === 'updated') expect(outcome.toRef).toBe('v1.0.0');
  });
});

describe('updatePlugin — removed-by-marketplace (P2)', () => {
  it('returns removed-by-marketplace when the updated manifest drops the plugin', async () => {
    // Seed the marketplace with plg-a present initially (localSha = 'oldsha').
    seedMarketplace('my-mp', ['plg-a'], { commit: 'oldsha' });
    const mpDir = join(cacheDir, 'my-mp');

    // Runner that, on checkout, rewrites the manifest to drop plg-a — simulating
    // a real `git checkout` that updates the working tree to a commit where the
    // plugin was removed. HEAD starts at oldsha (local) while origin/main is at
    // newsha, so the updater sees a diff and performs the checkout.
    let head = 'oldsha';
    const runner: GitRunner = async (args) => {
      const a = Array.from(args);
      if (a.includes('checkout')) {
        head = 'newsha';
        // Simulate the manifest after update: plg-a removed, plg-b added.
        writeFileSync(
          join(mpDir, '.claude-plugin', 'marketplace.json'),
          JSON.stringify({ name: 'my-mp', plugins: [{ name: 'plg-b', source: './plugins/plg-b' }] }),
          'utf8',
        );
        return { stdout: '', stderr: '' };
      }
      if (a[0] === 'tag') return { stdout: '\n', stderr: '' };
      if (a[0] === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
      if (a[0] === 'rev-parse') {
        const rev = a[a.length - 1] ?? '';
        if (rev === 'HEAD') return { stdout: head + '\n', stderr: '' };
        if (rev === 'refs/remotes/origin/main') return { stdout: 'newsha\n', stderr: '' };
        throw new Error('fatal: Needed a single revision');
      }
      return { stdout: '', stderr: '' };
    };

    const outcome = await updatePlugin(
      'my-mp:plg-a',
      {},
      { pluginsDir, indexPath, cacheDir, gitRunner: runner, now: () => new Date() },
    );
    expect(outcome).toEqual({ name: 'my-mp:plg-a', status: 'removed-by-marketplace', marketplace: 'my-mp' });
  });
});

describe('updateAll — marketplace deduplication (issue #993)', () => {
  it('updates marketplace plugins and regular plugins in one pass', async () => {
    // One regular git plugin
    seed('git-plugin', { ref: 'v1.0.0' });
    // Two plugins from the same marketplace
    seedMarketplace('corp-mp', ['tool-x', 'tool-y']);
    const { runner: gitRunner } = makeRunner(['v2.0.0'], 'gitsha');
    const { runner: mpRunner } = makeMarketplaceRunner('mpsha');

    // Use mpRunner for marketplace calls (they go through cacheDir) and gitRunner for git plugin.
    // Since updateAll shares one gitRunner dep, use mpRunner which handles both shapes.
    const combinedRunner: GitRunner = async (args, cwd) => {
      // Route based on presence of 'tag' (git plugin emits tags; marketplace has none)
      if (String(cwd).includes('plugins')) return gitRunner(args, cwd);
      return mpRunner(args, cwd);
    };

    const results = await updateAll({
      pluginsDir,
      indexPath,
      cacheDir,
      gitRunner: combinedRunner,
      now: () => new Date(),
    });

    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['corp-mp:tool-x', 'corp-mp:tool-y', 'git-plugin'].sort());

    const gitResult = results.find((r) => r.name === 'git-plugin');
    expect(gitResult?.status).toBe('updated');

    const mpResults = results.filter((r) => r.name.startsWith('corp-mp:'));
    // Both plugins share the same marketplace outcome (updated or up-to-date)
    expect(mpResults.every((r) => r.status === 'updated' || r.status === 'up-to-date')).toBe(true);
  });

  it('emits missing-dir for marketplace plugins when updateMarketplace throws', async () => {
    seedMarketplace('broken-mp', ['plg-z']);
    // Marketplace dir is gone — updateMarketplace will throw "marketplace not installed"
    // because seedMarketplace wrote the marketplace entry to the index. Let us
    // remove the cache dir to force a missing-dir from updateMarketplace.
    rmSync(join(cacheDir, 'broken-mp'), { recursive: true, force: true });
    const { runner } = makeMarketplaceRunner();
    const results = await updateAll({
      pluginsDir,
      indexPath,
      cacheDir,
      gitRunner: runner,
      now: () => new Date(),
    });
    const r = results.find((o) => o.name === 'broken-mp:plg-z');
    expect(r?.status).toBe('missing-dir');
  });
});
