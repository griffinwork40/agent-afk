/**
 * Tests for the git wrapper. A fake runner captures argv so we can verify
 * each helper invokes `git` with the expected command — no real git needed.
 */

import { describe, it, expect } from 'vitest';
import {
  clone,
  fetch,
  listTags,
  checkout,
  getCommitSha,
  getDefaultBranch,
  tryRevParse,
  type GitRunner,
} from './git.js';
import { subcommandOf } from './git-test-helpers.js';

interface Call {
  args: readonly string[];
  cwd: string | undefined;
}

function makeRunner(
  responder: (call: Call) => { stdout?: string; stderr?: string } | Error,
): { runner: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: GitRunner = async (args, cwd) => {
    const call = { args, cwd };
    calls.push(call);
    const result = responder(call);
    if (result instanceof Error) throw result;
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { runner, calls };
}

/**
 * Strip the leading `-c <value>` hardening prefix from a captured args array,
 * returning just the verb-and-arguments tail.
 *
 * Used by shape-pinning tests that want to assert the canonical clone /
 * checkout / fetch invocation independently of the exact hardening flag set.
 * Tests that care about the hardening flags themselves should use the
 * `git-hooks.test.ts` and `install-hardening.test.ts` suites instead.
 */
function gitVerbArgs(args: readonly string[]): readonly string[] {
  const sub = subcommandOf(args);
  if (!sub) return args;
  return args.slice(args.indexOf(sub));
}

describe('git wrapper', () => {
  it('clone invokes git clone -- <url> <dest>', async () => {
    const { runner, calls } = makeRunner(() => ({}));
    await clone('https://github.com/o/r.git', '/tmp/x', { runner });
    expect(calls).toHaveLength(1);
    expect(gitVerbArgs(calls[0]!.args)).toEqual([
      'clone',
      '--',
      'https://github.com/o/r.git',
      '/tmp/x',
    ]);
    expect(calls[0]!.cwd).toBeUndefined();
  });

  it('fetch runs git fetch --tags --prune in cwd', async () => {
    const { runner, calls } = makeRunner(() => ({}));
    await fetch('/tmp/repo', { runner });
    expect(calls).toHaveLength(1);
    expect(gitVerbArgs(calls[0]!.args)).toEqual(['fetch', '--tags', '--prune']);
    expect(calls[0]!.cwd).toBe('/tmp/repo');
  });

  it('listTags returns trimmed, non-empty lines', async () => {
    const { runner } = makeRunner(() => ({ stdout: 'v2.0.0\nv1.9.0\n\n  v1.0.0\n' }));
    const tags = await listTags('/tmp/repo', { runner });
    expect(tags).toEqual(['v2.0.0', 'v1.9.0', 'v1.0.0']);
  });

  it('listTags returns [] when there are no tags', async () => {
    const { runner } = makeRunner(() => ({ stdout: '\n' }));
    expect(await listTags('/tmp/repo', { runner })).toEqual([]);
  });

  it('checkout calls git checkout --detach <ref> in cwd', async () => {
    const { runner, calls } = makeRunner(() => ({}));
    await checkout('/tmp/repo', 'v1.2.3', { runner });
    // Two calls: first rev-parse to probe refs/remotes/origin/v1.2.3 (returns
    // empty → not a remote branch), then the actual checkout.
    expect(calls).toHaveLength(2);
    const checkoutCall = calls.at(-1)!;
    expect(gitVerbArgs(checkoutCall.args)).toEqual(['checkout', '--detach', 'v1.2.3']);
    expect(checkoutCall.cwd).toBe('/tmp/repo');
  });

  it('checkout adds --force before the ref when opts.force is set', async () => {
    const { runner, calls } = makeRunner(() => ({}));
    await checkout('/tmp/repo', 'refs/remotes/origin/main', { runner, force: true });
    expect(calls).toHaveLength(1);
    expect(gitVerbArgs(calls[0]!.args)).toEqual([
      'checkout',
      '--detach',
      '--force',
      'refs/remotes/origin/main',
    ]);
    // The ref MUST stay the final positional arg — the update paths assert
    // `checkout[checkout.length - 1]` to read the checked-out ref.
    expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe('refs/remotes/origin/main');
  });

  it('checkout omits --force by default', async () => {
    const { runner, calls } = makeRunner(() => ({}));
    await checkout('/tmp/repo', 'v1.2.3', { runner });
    const checkoutCall = calls.at(-1)!;
    expect(gitVerbArgs(checkoutCall.args)).not.toContain('--force');
  });

  it('getCommitSha returns trimmed stdout', async () => {
    const { runner } = makeRunner(() => ({ stdout: 'abc123\n' }));
    expect(await getCommitSha('/tmp/repo', { runner })).toBe('abc123');
  });

  it('getDefaultBranch strips the origin/ prefix', async () => {
    const { runner } = makeRunner(() => ({ stdout: 'origin/trunk\n' }));
    expect(await getDefaultBranch('/tmp/repo', { runner })).toBe('trunk');
  });

  it('getDefaultBranch falls back to main when symbolic-ref fails', async () => {
    const { runner } = makeRunner(() => new Error('no HEAD'));
    expect(await getDefaultBranch('/tmp/repo', { runner })).toBe('main');
  });

  it('propagates arbitrary git errors from the runner', async () => {
    const { runner } = makeRunner(() => new Error('fatal: bad ref'));
    await expect(checkout('/tmp/repo', 'nope', { runner })).rejects.toThrow(/bad ref/);
  });

  it('tryRevParse runs rev-parse --verify --quiet <rev> and returns the trimmed sha', async () => {
    const { runner, calls } = makeRunner(() => ({ stdout: 'deadbeef\n' }));
    const sha = await tryRevParse('/tmp/repo', 'refs/remotes/origin/main', { runner });
    expect(sha).toBe('deadbeef');
    expect(gitVerbArgs(calls[0]!.args)).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/main',
    ]);
    expect(calls[0]!.cwd).toBe('/tmp/repo');
  });

  it('tryRevParse returns null when the ref does not resolve (runner throws)', async () => {
    const { runner } = makeRunner(() => new Error('fatal: Needed a single revision'));
    expect(await tryRevParse('/tmp/repo', 'refs/remotes/origin/nope', { runner })).toBeNull();
  });

  it('tryRevParse returns null on empty stdout', async () => {
    const { runner } = makeRunner(() => ({ stdout: '\n' }));
    expect(await tryRevParse('/tmp/repo', 'HEAD', { runner })).toBeNull();
  });
});

describe('checkout — remote-branch DWIM fix', () => {
  it('resolves a bare remote-only branch name to refs/remotes/origin/<branch>', async () => {
    const { runner, calls } = makeRunner((call) => {
      const sub = subcommandOf(call.args);
      if (sub === 'rev-parse') return { stdout: 'deadbeef\n' };
      return {};
    });
    await checkout('/tmp/repo', 'afk', { runner });
    const revParseCall = calls.find((c) => subcommandOf(c.args) === 'rev-parse')!;
    expect(gitVerbArgs(revParseCall.args)).toEqual([
      'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/afk',
    ]);
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout')!;
    expect(gitVerbArgs(checkoutCall.args)).toEqual([
      'checkout', '--detach', 'refs/remotes/origin/afk',
    ]);
  });

  it('leaves a tag-like ref unchanged when refs/remotes/origin/<tag> does not resolve', async () => {
    const { runner, calls } = makeRunner((call) => {
      const sub = subcommandOf(call.args);
      if (sub === 'rev-parse') throw new Error('fatal: Needed a single revision');
      return {};
    });
    await checkout('/tmp/repo', 'v1.0.0', { runner });
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout')!;
    expect(gitVerbArgs(checkoutCall.args)).toEqual(['checkout', '--detach', 'v1.0.0']);
  });

  it('leaves a 40-char SHA unchanged (refs/remotes/origin/<sha> never resolves)', async () => {
    const sha40 = 'a'.repeat(40);
    const { runner, calls } = makeRunner((call) => {
      const sub = subcommandOf(call.args);
      if (sub === 'rev-parse') return { stdout: '' };
      return {};
    });
    await checkout('/tmp/repo', sha40, { runner });
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout')!;
    expect(gitVerbArgs(checkoutCall.args)).toEqual(['checkout', '--detach', sha40]);
  });

  it('resolves the default branch (main) to refs/remotes/origin/main when it exists on remote', async () => {
    const { runner, calls } = makeRunner((call) => {
      const sub = subcommandOf(call.args);
      if (sub === 'rev-parse') return { stdout: 'cafe0000\n' };
      return {};
    });
    await checkout('/tmp/repo', 'main', { runner });
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout')!;
    expect(gitVerbArgs(checkoutCall.args)).toEqual([
      'checkout', '--detach', 'refs/remotes/origin/main',
    ]);
  });

  it('passes qualified refs/remotes/origin/<x> through unchanged (no double-resolution)', async () => {
    const { runner, calls } = makeRunner(() => ({}));
    await checkout('/tmp/repo', 'refs/remotes/origin/main', { runner });
    // No rev-parse probe when ref already starts with refs/
    expect(calls.filter((c) => subcommandOf(c.args) === 'rev-parse')).toHaveLength(0);
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout')!;
    expect(gitVerbArgs(checkoutCall.args)).toEqual([
      'checkout', '--detach', 'refs/remotes/origin/main',
    ]);
  });

  it('passes refs/tags/<x> through unchanged (no resolution)', async () => {
    const { runner, calls } = makeRunner(() => ({}));
    await checkout('/tmp/repo', 'refs/tags/v2.0.0', { runner });
    expect(calls.filter((c) => subcommandOf(c.args) === 'rev-parse')).toHaveLength(0);
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout')!;
    expect(gitVerbArgs(checkoutCall.args)).toEqual(['checkout', '--detach', 'refs/tags/v2.0.0']);
  });

  it('prefers remote branch over tag when bare name resolves as both', async () => {
    const { runner, calls } = makeRunner((call) => {
      const sub = subcommandOf(call.args);
      if (sub === 'rev-parse') return { stdout: 'deadbeef\n' };
      return {};
    });
    await checkout('/tmp/repo', 'v1.0.0', { runner });
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout')!;
    expect(gitVerbArgs(checkoutCall.args)).toEqual([
      'checkout', '--detach', 'refs/remotes/origin/v1.0.0',
    ]);
  });
});
