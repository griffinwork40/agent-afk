/**
 * Tests for the plugin updater. Uses a fake git runner and a pre-seeded
 * index file to simulate the "already-installed" state.
 */

// [F2] Hoist the scan-cache mock so update.ts picks it up at module load.
const resetScanCache = vi.hoisted(() => vi.fn());
vi.mock('../plugins-scanner.js', () => ({ _resetPluginScanCache: resetScanCache, scanLocalPlugins: vi.fn(() => []) }));

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updatePlugin, updateAll } from './update.js';
import { readIndex, upsertPlugin, type PluginIndexEntry } from './index-store.js';
import type { GitRunner } from './git.js';

let tmpDir: string;
let pluginsDir: string;
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
  indexPath = join(pluginsDir, '.index.json');
  mkdirSync(pluginsDir, { recursive: true });
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
