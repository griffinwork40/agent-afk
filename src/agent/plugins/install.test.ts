/**
 * Integration-style tests for the installer. A fake `gitRunner` simulates
 * the binary so we never touch the network; the real filesystem is used
 * inside a tmpdir to exercise clone-dest writes, symlinks, and the index
 * store end-to-end.
 */

// [F2] Hoist the scan-cache mock so install.ts picks it up at module load.
const resetScanCache = vi.hoisted(() => vi.fn());
vi.mock('../plugins-scanner.js', () => ({ _resetPluginScanCache: resetScanCache, scanLocalPlugins: vi.fn(() => []) }));

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installPlugin } from './install.js';
import { readIndex } from './index-store.js';
import type { GitRunner } from './git.js';
import { subcommandOf } from './git-test-helpers.js';

let tmpDir: string;
let pluginsDir: string;
let indexPath: string;
let sourceDir: string;

function writeManifest(dir: string, name: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.0.0' }),
  );
}

interface FakeGitCall {
  args: readonly string[];
  cwd: string | undefined;
}

/**
 * Build a fake git runner. On `git clone -- <url> <dest>` it creates the
 * dest dir + manifest. `tag --list` returns `tags`. `rev-parse HEAD`
 * returns `sha`. `symbolic-ref` returns `main`.
 */
function makeFakeGit(
  tags: string[],
  sha: string,
  manifestName: string | null,
): { runner: GitRunner; calls: FakeGitCall[] } {
  const calls: FakeGitCall[] = [];
  const runner: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    // The real args array is now hardening-prefixed: `[-c, k=v, ..., 'clone', ...]`.
    // subcommandOf() skips the `-c <value>` pairs to find the actual git verb.
    const sub = subcommandOf(args);
    if (sub === 'clone') {
      // clone dest is the last positional arg (after `--` separator).
      const dest = args[args.length - 1];
      mkdirSync(dest, { recursive: true });
      if (manifestName !== null) writeManifest(dest, manifestName);
      return { stdout: '', stderr: '' };
    }
    if (sub === 'tag') return { stdout: tags.join('\n') + '\n', stderr: '' };
    if (sub === 'rev-parse') return { stdout: sha + '\n', stderr: '' };
    if (sub === 'checkout') return { stdout: '', stderr: '' };
    if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
    if (sub === 'fetch') return { stdout: '', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-install-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  pluginsDir = join(tmpDir, 'plugins');
  indexPath = join(pluginsDir, '.index.json');
  sourceDir = join(tmpDir, 'source');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  resetScanCache.mockClear();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('installPlugin — GitHub shorthand', () => {
  it('clones, picks latest semver, and writes the index', async () => {
    const { runner, calls } = makeFakeGit(
      ['v1.0.0', 'v2.0.0', 'v1.5.0'],
      'deadbeef',
      'my-plugin',
    );
    const result = await installPlugin(
      'anthropics/example-plugin',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date('2026-04-20T12:00:00Z'), confirm: false },
    );

    expect(result.name).toBe('my-plugin');
    expect(result.dir).toBe(join(pluginsDir, 'my-plugin'));
    expect(existsSync(join(pluginsDir, 'my-plugin', '.claude-plugin', 'plugin.json'))).toBe(true);

    const idx = readIndex(indexPath);
    expect(idx.plugins['my-plugin']).toMatchObject({
      source: 'anthropics/example-plugin',
      sourceType: 'github',
      ref: 'v2.0.0',
      commit: 'deadbeef',
      enabled: true,
    });

    const cloneCall = calls.find((c) => subcommandOf(c.args) === 'clone');
    // Strip the leading `-c <value>` hardening pairs; assert the remaining
    // args are the canonical clone invocation. This preserves the original
    // test's intent (verify clone args) without coupling to the exact
    // hardening flag set.
    const cloneTail = cloneCall!.args.slice(cloneCall!.args.indexOf('clone'));
    expect(cloneTail).toEqual([
      'clone',
      '--',
      'https://github.com/anthropics/example-plugin.git',
      join(pluginsDir, 'example-plugin'),
    ]);
  });

  it('falls back to default branch when no semver tags exist', async () => {
    const { runner, calls } = makeFakeGit([], 'cafe', 'x');
    const result = await installPlugin(
      'anthropics/no-tags',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date('2026-04-20T12:00:00Z'), confirm: false },
    );
    expect(result.entry.ref).toBe('main');
    // When ref === default branch, no extra checkout fires.
    expect(calls.some((c) => subcommandOf(c.args) === 'checkout')).toBe(false);
  });

  it('honors an explicit --ref', async () => {
    const { runner, calls } = makeFakeGit(['v1.0.0', 'v2.0.0'], 'zz', 'x');
    await installPlugin(
      'anthropics/pin-me',
      { ref: 'v1.0.0' },
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date(), confirm: false },
    );
    const checkout = calls.find((c) => subcommandOf(c.args) === 'checkout');
    // Strip hardening prefix before asserting on the checkout shape.
    const checkoutTail = checkout!.args.slice(checkout!.args.indexOf('checkout'));
    expect(checkoutTail).toEqual(['checkout', '--detach', 'v1.0.0']);
  });
});

describe('installPlugin — git URL', () => {
  it('uses the URL slug for the default dir name', async () => {
    const { runner } = makeFakeGit(['v1.0.0'], 'abc', null);
    const result = await installPlugin(
      'https://github.com/owner/some-repo.git',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date(), confirm: false },
    );
    expect(result.name).toBe('some-repo');
    expect(result.entry.sourceType).toBe('git');
  });
});

describe('installPlugin — local', () => {
  it('symlinks a local source into the plugins dir', async () => {
    writeManifest(sourceDir, 'from-disk');
    const result = await installPlugin(
      sourceDir,
      {},
      { pluginsDir, indexPath, now: () => new Date('2026-04-20T12:00:00Z') },
    );
    expect(result.name).toBe('from-disk');
    expect(lstatSync(result.dir).isSymbolicLink()).toBe(true);
    const idx = readIndex(indexPath);
    expect(idx.plugins['from-disk']).toMatchObject({
      source: sourceDir,
      sourceType: 'local',
      ref: null,
      commit: null,
      enabled: true,
    });
  });

  it('uses an explicit --name override', async () => {
    writeManifest(sourceDir, 'manifest-name');
    const result = await installPlugin(
      sourceDir,
      { name: 'overridden' },
      { pluginsDir, indexPath, now: () => new Date() },
    );
    expect(result.name).toBe('overridden');
    expect(existsSync(join(pluginsDir, 'overridden'))).toBe(true);
    const idx = readIndex(indexPath);
    expect(idx.plugins['overridden'].manifestName).toBe('manifest-name');
  });
});

describe('installPlugin — collisions', () => {
  it('refuses when the dir already exists without --force', async () => {
    writeManifest(sourceDir, 'collide');
    await installPlugin(
      sourceDir,
      {},
      { pluginsDir, indexPath, now: () => new Date() },
    );
    await expect(
      installPlugin(sourceDir, {}, { pluginsDir, indexPath, now: () => new Date() }),
    ).rejects.toThrow(/already exists/);
  });

  it('--force replaces the existing plugin', async () => {
    writeManifest(sourceDir, 'collide');
    await installPlugin(
      sourceDir,
      {},
      { pluginsDir, indexPath, now: () => new Date() },
    );
    const again = await installPlugin(
      sourceDir,
      { force: true },
      { pluginsDir, indexPath, now: () => new Date() },
    );
    // Local sources don't go through the confirm path, so no confirm: false needed.
    expect(again.name).toBe('collide');
  });

  it('cleans up the half-cloned dir if checkout explodes', async () => {
    const runner: GitRunner = async (args, _cwd) => {
      // args is hardening-prefixed (`[-c, k=v, ..., <sub>, ...]`).
      const sub = subcommandOf(args);
      if (sub === 'clone') {
        const dest = args[args.length - 1] as string;
        mkdirSync(dest, { recursive: true });
        writeManifest(dest, 'x');
        return { stdout: '', stderr: '' };
      }
      if (sub === 'tag') return { stdout: 'v1.0.0\n', stderr: '' };
      if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
      if (sub === 'checkout') throw new Error('boom');
      return { stdout: '', stderr: '' };
    };

    await expect(
      installPlugin(
        'owner/repo',
        {},
        { pluginsDir, indexPath, gitRunner: runner, now: () => new Date(), confirm: false },
      ),
    ).rejects.toThrow(/boom/);
    // Should have cleaned up after itself.
    expect(existsSync(join(pluginsDir, 'repo'))).toBe(false);
  });
});

describe('installPlugin — manifest name precedence', () => {
  it('renames clone dir to match the manifest name when they differ', async () => {
    const { runner } = makeFakeGit(['v1.0.0'], 'a', 'real-name-from-manifest');
    const result = await installPlugin(
      'owner/url-slug',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date(), confirm: false },
    );
    expect(result.name).toBe('real-name-from-manifest');
    expect(existsSync(join(pluginsDir, 'real-name-from-manifest'))).toBe(true);
    expect(existsSync(join(pluginsDir, 'url-slug'))).toBe(false);
    const manifest = JSON.parse(
      readFileSync(
        join(pluginsDir, 'real-name-from-manifest', '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    );
    expect(manifest.name).toBe('real-name-from-manifest');
  });
});

// ── F2: scan-cache invalidation ─────────────────────────────────────────────

describe('installPlugin — cache invalidation (F2)', () => {
  it('calls _resetPluginScanCache after a successful local install', async () => {
    writeManifest(sourceDir, 'cache-bust-local');
    await installPlugin(
      sourceDir,
      {},
      { pluginsDir, indexPath, now: () => new Date() },
    );
    expect(resetScanCache).toHaveBeenCalledOnce();
  });

  it('calls _resetPluginScanCache after a successful git install', async () => {
    const { runner } = makeFakeGit(['v1.0.0'], 'abc123', 'cache-bust-git');
    await installPlugin(
      'owner/cache-bust-repo',
      {},
      { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() },
    );
    expect(resetScanCache).toHaveBeenCalledOnce();
  });

  it('does NOT call _resetPluginScanCache when install fails', async () => {
    const runner: GitRunner = async (args) => {
      // args is hardening-prefixed (`[-c, k=v, ..., <sub>, ...]`) — look past
      // the `-c <value>` pairs to identify the actual git verb. Without this
      // helper, every `args[0]` lookup would see `'-c'` and the fake would
      // silently return empty for every call, causing checkout to never fire.
      const sub = subcommandOf(args);
      if (sub === 'clone') {
        const dest = args[args.length - 1] as string;
        mkdirSync(dest, { recursive: true });
        writeManifest(dest, 'x');
        return { stdout: '', stderr: '' };
      }
      if (sub === 'tag') return { stdout: 'v1.0.0\n', stderr: '' };
      if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
      if (sub === 'checkout') throw new Error('checkout-boom');
      return { stdout: '', stderr: '' };
    };
    await expect(
      installPlugin('owner/fail-repo', {}, { pluginsDir, indexPath, gitRunner: runner, now: () => new Date() }),
    ).rejects.toThrow(/checkout-boom/);
    expect(resetScanCache).not.toHaveBeenCalled();
  });
});
