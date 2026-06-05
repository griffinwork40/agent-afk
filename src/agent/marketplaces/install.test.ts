/**
 * Tests for the marketplace installer. Mirrors the plugin install harness:
 * a fake gitRunner simulates git, the real filesystem is exercised inside a
 * tmpdir, and the index store is checked end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installMarketplace } from './install.js';
import { readIndex } from '../plugins/index-store.js';
import type { GitRunner } from '../plugins/git.js';
import { subcommandOf, hasFlagPair } from '../plugins/git-test-helpers.js';

let tmpDir: string;
let cacheDir: string;
let indexPath: string;
let sourceDir: string;

function writeMarketplaceManifest(dir: string, name: string, plugins: { name: string; source: string }[] = []): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name, plugins }),
  );
}

function makeFakeGit(
  tags: string[],
  sha: string,
  manifestName: string,
): { runner: GitRunner } {
  const runner: GitRunner = async (args) => {
    // args is hardening-prefixed (`[-c, k=v, ..., <sub>, ...]`).
    const sub = subcommandOf(args);
    if (sub === 'clone') {
      const dest = args[args.length - 1] as string;
      mkdirSync(dest, { recursive: true });
      writeMarketplaceManifest(dest, manifestName, [
        { name: 'foo', source: './plugins/foo' },
      ]);
      return { stdout: '', stderr: '' };
    }
    if (sub === 'tag') return { stdout: tags.join('\n') + '\n', stderr: '' };
    if (sub === 'rev-parse') return { stdout: sha + '\n', stderr: '' };
    if (sub === 'checkout') return { stdout: '', stderr: '' };
    if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
    if (sub === 'fetch') return { stdout: '', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { runner };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `afk-mp-install-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cacheDir = join(tmpDir, 'plugins', 'cache');
  indexPath = join(tmpDir, 'plugins', '.index.json');
  sourceDir = join(tmpDir, 'source');
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('installMarketplace — local source', () => {
  it('symlinks the source dir into cache/<manifest-name>', async () => {
    writeMarketplaceManifest(sourceDir, 'mp-canonical', [
      { name: 'foo', source: './plugins/foo' },
      { name: 'bar', source: './plugins/bar' },
    ]);

    const result = await installMarketplace(
      sourceDir,
      {},
      { cacheDir, indexPath, now: () => new Date('2026-04-20T12:00:00Z') },
    );

    expect(result.name).toBe('mp-canonical');
    expect(result.dir).toBe(join(cacheDir, 'mp-canonical'));
    expect(result.plugins.map((p) => p.name)).toEqual(['foo', 'bar']);

    expect(lstatSync(join(cacheDir, 'mp-canonical')).isSymbolicLink()).toBe(true);

    const idx = readIndex(indexPath);
    expect(idx.marketplaces['mp-canonical']).toMatchObject({
      source: sourceDir,
      sourceType: 'local',
      ref: null,
    });
  });

  it('throws when the source has no marketplace.json', async () => {
    await expect(
      installMarketplace(sourceDir, {}, { cacheDir, indexPath }),
    ).rejects.toThrow(/marketplace manifest not found/);
  });

  it('throws when the destination already exists without --force', async () => {
    writeMarketplaceManifest(sourceDir, 'mp-canonical');
    await installMarketplace(sourceDir, {}, { cacheDir, indexPath });
    await expect(
      installMarketplace(sourceDir, {}, { cacheDir, indexPath }),
    ).rejects.toThrow(/already exists/);
  });

  it('replaces an existing install when --force is passed', async () => {
    writeMarketplaceManifest(sourceDir, 'mp-canonical');
    await installMarketplace(sourceDir, {}, { cacheDir, indexPath });
    await expect(
      installMarketplace(sourceDir, { force: true }, { cacheDir, indexPath }),
    ).resolves.toMatchObject({ name: 'mp-canonical' });
  });

  it('respects an explicit --name override', async () => {
    writeMarketplaceManifest(sourceDir, 'mp-canonical');
    const result = await installMarketplace(
      sourceDir,
      { name: 'my-pinned-name' },
      { cacheDir, indexPath },
    );
    expect(result.name).toBe('my-pinned-name');
    expect(existsSync(join(cacheDir, 'my-pinned-name'))).toBe(true);
  });
});

describe('installMarketplace — git source', () => {
  it('clones, picks the latest semver tag, renames to manifest name', async () => {
    const { runner } = makeFakeGit(['v1.0.0', 'v2.0.0'], 'cafef00d', 'mp-canonical');
    const result = await installMarketplace(
      'anthropics/example-marketplace',
      {},
      { cacheDir, indexPath, gitRunner: runner, now: () => new Date('2026-04-20T12:00:00Z') },
    );

    expect(result.name).toBe('mp-canonical');
    expect(result.dir).toBe(join(cacheDir, 'mp-canonical'));
    // Provisional dir got renamed away.
    expect(existsSync(join(cacheDir, 'example-marketplace'))).toBe(false);
    expect(existsSync(join(cacheDir, 'mp-canonical', '.claude-plugin', 'marketplace.json'))).toBe(true);

    const idx = readIndex(indexPath);
    expect(idx.marketplaces['mp-canonical']).toMatchObject({
      source: 'anthropics/example-marketplace',
      sourceType: 'github',
      ref: 'v2.0.0',
      commit: 'cafef00d',
    });
  });

  it('rejects a marketplace-ref source string', async () => {
    await expect(
      installMarketplace('mp:plugin', {}),
    ).rejects.toThrow(/cannot itself be a marketplace reference/);
  });
});

// ── S7-HTTPS + S7-hooks regression coverage for the marketplace path ────────
//
// The plugin install path enforces HTTPS-only + hook suppression; the
// marketplace install path previously did NOT. Both paths produce
// equally-privileged on-disk artifacts (the marketplace catalog can
// auto-fanout to plugin installs), so the same protections must apply.

describe('installMarketplace — S7-HTTPS scheme enforcement', () => {
  it('rejects git:// URLs with an error mentioning https://', async () => {
    const { runner } = makeFakeGit([], 'sha', 'mp-x');
    await expect(
      installMarketplace('git://github.com/o/r', {}, { cacheDir, indexPath, gitRunner: runner }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('rejects http:// URLs', async () => {
    const { runner } = makeFakeGit([], 'sha', 'mp-x');
    await expect(
      installMarketplace('http://github.com/o/r', {}, { cacheDir, indexPath, gitRunner: runner }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('rejects ssh:// URLs', async () => {
    const { runner } = makeFakeGit([], 'sha', 'mp-x');
    await expect(
      installMarketplace('ssh://git@github.com/o/r', {}, { cacheDir, indexPath, gitRunner: runner }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('rejects git@host: SSH shorthand', async () => {
    const { runner } = makeFakeGit([], 'sha', 'mp-x');
    await expect(
      installMarketplace('git@github.com:o/r.git', {}, { cacheDir, indexPath, gitRunner: runner }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('rejects file:// URLs (filesystem traversal vector)', async () => {
    const { runner } = makeFakeGit([], 'sha', 'mp-x');
    await expect(
      installMarketplace('file:///etc/passwd', {}, { cacheDir, indexPath, gitRunner: runner }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('accepts owner/repo shorthand (expands to https://)', async () => {
    const { runner } = makeFakeGit(['v1.0.0'], 'cafef00d', 'mp-canonical');
    const result = await installMarketplace(
      'owner/repo',
      {},
      { cacheDir, indexPath, gitRunner: runner },
    );
    expect(result.name).toBe('mp-canonical');
  });
});

describe('installMarketplace — S7-hooks hardening on clone/checkout', () => {
  /**
   * Capture every git invocation made by the marketplace installer so we can
   * verify the hardening `-c` flags are present on clone AND checkout.
   *
   * Note: the runner inside makeFakeGit() above doesn't expose its call log.
   * For these tests we build a richer capturing runner inline.
   */
  function makeCapturingFakeGit(tags: string[], sha: string, manifestName: string): {
    runner: GitRunner;
    calls: Array<{ args: readonly string[]; cwd: string | undefined }>;
  } {
    const calls: Array<{ args: readonly string[]; cwd: string | undefined }> = [];
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd });
      const sub = subcommandOf(args);
      if (sub === 'clone') {
        const sepIdx = args.indexOf('--');
        const dest = sepIdx >= 0 ? (args[sepIdx + 2] as string) : (args[args.length - 1] as string);
        mkdirSync(dest, { recursive: true });
        writeMarketplaceManifest(dest, manifestName, [{ name: 'foo', source: './plugins/foo' }]);
        return { stdout: '', stderr: '' };
      }
      if (sub === 'tag') return { stdout: tags.join('\n') + '\n', stderr: '' };
      if (sub === 'rev-parse') return { stdout: sha + '\n', stderr: '' };
      if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    return { runner, calls };
  }

  it('passes -c core.hooksPath=/dev/null on the clone call', async () => {
    const { runner, calls } = makeCapturingFakeGit(['v1.0.0'], 'sha1', 'mp-x');
    await installMarketplace(
      'owner/repo',
      {},
      { cacheDir, indexPath, gitRunner: runner },
    );
    const clone = calls.find((c) => subcommandOf(c.args) === 'clone');
    expect(clone).toBeDefined();
    expect(hasFlagPair(clone!.args, 'core.hooksPath=/dev/null')).toBe(true);
  });

  it('passes -c filter.smudge= and filter.clean= on the clone call', async () => {
    const { runner, calls } = makeCapturingFakeGit(['v1.0.0'], 'sha1', 'mp-x');
    await installMarketplace(
      'owner/repo',
      {},
      { cacheDir, indexPath, gitRunner: runner },
    );
    const clone = calls.find((c) => subcommandOf(c.args) === 'clone');
    expect(hasFlagPair(clone!.args, 'filter.smudge=')).toBe(true);
    expect(hasFlagPair(clone!.args, 'filter.clean=')).toBe(true);
  });

  it('passes -c core.hooksPath=/dev/null on the checkout call (post-checkout hook bypass guard)', async () => {
    const { runner, calls } = makeCapturingFakeGit(['v1.0.0'], 'sha1', 'mp-x');
    await installMarketplace(
      'owner/repo',
      { ref: 'v1.0.0' }, // explicit ref forces checkout to run
      { cacheDir, indexPath, gitRunner: runner },
    );
    const checkout = calls.find((c) => subcommandOf(c.args) === 'checkout');
    expect(checkout, 'explicit --ref should invoke checkout').toBeDefined();
    expect(hasFlagPair(checkout!.args, 'core.hooksPath=/dev/null')).toBe(true);
  });
});
