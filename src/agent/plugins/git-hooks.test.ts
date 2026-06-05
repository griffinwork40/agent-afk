/**
 * Tests for git operation hardening: every git invocation that touches the
 * working tree of an untrusted repo MUST prepend the `-c` flags that disable
 * repo hooks and defang filter drivers.
 *
 * The earlier env-var approach (GIT_CONFIG_COUNT/KEY_0/VALUE_0) was a Git ≥
 * 2.31 feature and silently no-op'd on Ubuntu 20.04 (2.25), macOS Catalina
 * (2.24), Debian buster (2.20), CentOS 7 (1.8). Switching to `-c` CLI args
 * works on Git ≥ 2.8 (March 2010) and is deterministic on every supported
 * release.
 *
 * The previous test file also had vacuous assertions: it passed the hook-
 * suppress env IN to clone() and then verified the runner received the same
 * env back — proving nothing about what `clone()` itself constructed. This
 * file pins the actual invariant: args contain the hardening flags regardless
 * of the caller's env.
 *
 * @module agent/plugins/git-hooks.test
 */

import { describe, it, expect } from 'vitest';
import { clone, checkout, fetch, withHardening, type GitRunner } from './git.js';
import { hasFlagPair } from './git-test-helpers.js';

interface CapturedCall {
  args: readonly string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
}

function makeCapturingRunner(): { runner: GitRunner; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const runner: GitRunner = async (args, cwd, env) => {
    calls.push({ args, cwd, env });
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

// Assert (with a clear failure message) that args contain `['-c', value]`
// as consecutive elements. Delegates the lookup to the shared helper.
function expectFlagPair(args: readonly string[], value: string): void {
  expect(
    hasFlagPair(args, value),
    `expected args to contain ['-c', '${value}'] as consecutive elements; got ${JSON.stringify(args)}`,
  ).toBe(true);
}

describe('withHardening — invariant constructor', () => {
  it('prepends -c flags BEFORE the subcommand (top-level flags must come first)', () => {
    const out = withHardening(['clone', 'url', 'dest']);
    // The first `-c` must appear before `clone`.
    const firstFlag = out.indexOf('-c');
    const subcommand = out.indexOf('clone');
    expect(firstFlag).toBe(0);
    expect(firstFlag).toBeLessThan(subcommand);
  });

  it('preserves the original args verbatim after the hardening prefix', () => {
    const out = withHardening(['checkout', '--detach', 'v1.0.0']);
    expect(out.slice(-3)).toEqual(['checkout', '--detach', 'v1.0.0']);
  });
});

describe('git.clone — hardening', () => {
  it('passes -c core.hooksPath=/dev/null to the runner', async () => {
    const { runner, calls } = makeCapturingRunner();
    await clone('https://github.com/o/r.git', '/tmp/x', { runner });
    expectFlagPair(calls[0]!.args, 'core.hooksPath=/dev/null');
  });

  it('passes -c filter.process= to defang long-running filter drivers', async () => {
    const { runner, calls } = makeCapturingRunner();
    await clone('https://github.com/o/r.git', '/tmp/x', { runner });
    expectFlagPair(calls[0]!.args, 'filter.process=');
  });

  it('passes -c filter.smudge= to defang checkout-time filter transforms', async () => {
    const { runner, calls } = makeCapturingRunner();
    await clone('https://github.com/o/r.git', '/tmp/x', { runner });
    expectFlagPair(calls[0]!.args, 'filter.smudge=');
  });

  it('passes -c filter.clean= to defang commit-time filter transforms', async () => {
    const { runner, calls } = makeCapturingRunner();
    await clone('https://github.com/o/r.git', '/tmp/x', { runner });
    expectFlagPair(calls[0]!.args, 'filter.clean=');
  });

  it('places hardening flags BEFORE the `clone` subcommand', async () => {
    const { runner, calls } = makeCapturingRunner();
    await clone('https://github.com/o/r.git', '/tmp/x', { runner });
    const firstCloneIdx = calls[0]!.args.indexOf('clone');
    const firstCIdx = calls[0]!.args.indexOf('-c');
    expect(firstCIdx).toBe(0);
    expect(firstCloneIdx).toBeGreaterThan(0);
  });

  it('still includes the clone url and dest verbatim', async () => {
    const { runner, calls } = makeCapturingRunner();
    await clone('https://github.com/o/r.git', '/tmp/x', { runner });
    const args = calls[0]!.args;
    expect(args).toContain('https://github.com/o/r.git');
    expect(args).toContain('/tmp/x');
    expect(args).toContain('--');
  });
});

// THIS IS THE CRITICAL TEST — `checkout` was previously unprotected,
// allowing post-checkout hooks to fire on `--detach` inside an untrusted
// cloned repo. Pin the fix.
describe('git.checkout — hardening (critical: post-checkout hook bypass)', () => {
  it('passes -c core.hooksPath=/dev/null on checkout (blocks post-checkout hook)', async () => {
    const { runner, calls } = makeCapturingRunner();
    await checkout('/tmp/repo', 'v1.0.0', { runner });
    expectFlagPair(calls[0]!.args, 'core.hooksPath=/dev/null');
  });

  it('passes -c filter.process= on checkout', async () => {
    const { runner, calls } = makeCapturingRunner();
    await checkout('/tmp/repo', 'v1.0.0', { runner });
    expectFlagPair(calls[0]!.args, 'filter.process=');
  });

  it('passes -c filter.smudge= on checkout (filter runs on every checkout)', async () => {
    const { runner, calls } = makeCapturingRunner();
    await checkout('/tmp/repo', 'v1.0.0', { runner });
    expectFlagPair(calls[0]!.args, 'filter.smudge=');
  });

  it('still issues `checkout --detach <ref>` after the hardening prefix', async () => {
    const { runner, calls } = makeCapturingRunner();
    await checkout('/tmp/repo', 'main', { runner });
    const args = calls[0]!.args;
    expect(args.slice(-3)).toEqual(['checkout', '--detach', 'main']);
  });

  it('runs checkout inside the supplied repo dir (cwd)', async () => {
    const { runner, calls } = makeCapturingRunner();
    await checkout('/tmp/some-repo', 'v1.0.0', { runner });
    expect(calls[0]!.cwd).toBe('/tmp/some-repo');
  });
});

describe('git.fetch — hardening', () => {
  it('passes -c core.hooksPath=/dev/null on fetch', async () => {
    const { runner, calls } = makeCapturingRunner();
    await fetch('/tmp/repo', { runner });
    expectFlagPair(calls[0]!.args, 'core.hooksPath=/dev/null');
  });

  it('passes -c filter.smudge= on fetch (LFS-style filter drivers)', async () => {
    const { runner, calls } = makeCapturingRunner();
    await fetch('/tmp/repo', { runner });
    expectFlagPair(calls[0]!.args, 'filter.smudge=');
  });

  it('still issues `fetch --tags --prune` after the hardening prefix', async () => {
    const { runner, calls } = makeCapturingRunner();
    await fetch('/tmp/repo', { runner });
    const args = calls[0]!.args;
    expect(args.slice(-3)).toEqual(['fetch', '--tags', '--prune']);
  });
});

describe('read-only git operations — not hardened (no working-tree mutation)', () => {
  it('listTags does not prepend -c flags (read-only, no hooks)', async () => {
    const { runner, calls } = makeCapturingRunner();
    const { listTags } = await import('./git.js');
    await listTags('/tmp/repo', { runner });
    expect(calls[0]!.args[0]).toBe('tag');
    expect(calls[0]!.args).not.toContain('-c');
  });

  it('getCommitSha does not prepend -c flags (rev-parse is read-only)', async () => {
    const { runner, calls } = makeCapturingRunner();
    const { getCommitSha } = await import('./git.js');
    await getCommitSha('/tmp/repo', { runner });
    expect(calls[0]!.args[0]).toBe('rev-parse');
    expect(calls[0]!.args).not.toContain('-c');
  });

  it('getDefaultBranch does not prepend -c flags (symbolic-ref is read-only)', async () => {
    const { runner, calls } = makeCapturingRunner();
    const { getDefaultBranch } = await import('./git.js');
    await getDefaultBranch('/tmp/repo', { runner });
    expect(calls[0]!.args[0]).toBe('symbolic-ref');
    expect(calls[0]!.args).not.toContain('-c');
  });
});

describe('CLI-flag hardening is git ≥ 2.8 compatible (no env-var dependency)', () => {
  // Pin the regression: do NOT depend on GIT_CONFIG_COUNT-style env vars,
  // which are Git ≥ 2.31 and silently no-op on older releases.
  it('clone does not require GIT_CONFIG_COUNT to be set in env', async () => {
    const { runner, calls } = makeCapturingRunner();
    // Pass an env that explicitly does NOT contain the GIT_CONFIG_* vars.
    await clone('https://github.com/o/r.git', '/tmp/x', { runner, env: { PATH: '/usr/bin' } });
    const env = calls[0]!.env ?? {};
    expect(env['GIT_CONFIG_COUNT']).toBeUndefined();
    // But the hardening flags are still present in args.
    expectFlagPair(calls[0]!.args, 'core.hooksPath=/dev/null');
  });

  it('checkout does not require GIT_CONFIG_COUNT either', async () => {
    const { runner, calls } = makeCapturingRunner();
    await checkout('/tmp/repo', 'v1', { runner, env: { PATH: '/usr/bin' } });
    const env = calls[0]!.env ?? {};
    expect(env['GIT_CONFIG_COUNT']).toBeUndefined();
    expectFlagPair(calls[0]!.args, 'core.hooksPath=/dev/null');
  });
});
