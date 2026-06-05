/**
 * Regression tests for PR-14 plugin-install hardening (audit S7 step 1).
 *
 * Covers:
 *   (a) [S7-HTTPS]   URL scheme allowlist — only https:// accepted for git sources.
 *   (b) [S7-hooks]   git clone AND checkout pass `-c core.hooksPath=/dev/null`
 *                    plus filter-driver defang flags. The `-c` form is Git ≥ 2.8
 *                    compatible; the older GIT_CONFIG_COUNT env approach silently
 *                    no-op'd on Git < 2.31 and is no longer used.
 *   (c) [S7-warning] Prominent stderr warning is emitted BEFORE clone when confirm is true,
 *                    and skipped when confirm is false (non-interactive / --yes path).
 *
 * The real git binary is never invoked — tests inject a fake GitRunner that
 * captures its arguments and resolves immediately so no network is hit.
 *
 * @module agent/plugins/install-hardening.test
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installPlugin } from './install.js';
import type { GitRunner } from './git.js';
import { subcommandOf, hasFlagPair } from './git-test-helpers.js';

// ── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;
let pluginsDir: string;
let indexPath: string;

function writeManifest(dir: string, name: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.0.0' }),
  );
}

interface CapturedCall {
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}

// subcommandOf + hasFlagPair are imported from ./git-test-helpers.js — see top.

/** Fake git runner: on clone it creates dest + manifest, everything else is a no-op. */
function makeFakeGit(manifestName = 'test-plugin'): {
  runner: GitRunner;
  /** All calls (args + env) made to the runner, in order. */
  calls: CapturedCall[];
  /** Convenience: env objects only, preserving call order. */
  envCaptures: Array<NodeJS.ProcessEnv | undefined>;
} {
  const calls: CapturedCall[] = [];
  const envCaptures: Array<NodeJS.ProcessEnv | undefined> = [];
  const runner: GitRunner = async (args, _cwd, env) => {
    calls.push({ args, env });
    envCaptures.push(env);
    const sub = subcommandOf(args);
    if (sub === 'clone') {
      // The clone destination is the last positional arg AFTER the `--`
      // separator (we use `clone -- <url> <dest>` to disambiguate). Locating
      // the `--` lets us survive any future arg additions in front.
      const sepIdx = args.indexOf('--');
      const dest = sepIdx >= 0 ? (args[sepIdx + 2] as string) : (args[args.length - 1] as string);
      mkdirSync(dest, { recursive: true });
      writeManifest(dest, manifestName);
      return { stdout: '', stderr: '' };
    }
    if (sub === 'tag') return { stdout: 'v1.0.0\n', stderr: '' };
    if (sub === 'rev-parse') return { stdout: 'abc123\n', stderr: '' };
    if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { runner, calls, envCaptures };
}

// ── lifecycle ──────────────────────────────────────────────────────────────

let stderrWrites: string[];
let stderrSpy: MockInstance;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `afk-hardening-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  pluginsDir = join(tmpDir, 'plugins');
  indexPath = join(pluginsDir, '.index.json');
  mkdirSync(pluginsDir, { recursive: true });

  stderrWrites = [];
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── (a) S7-HTTPS: URL scheme allowlist ────────────────────────────────────

describe('S7-HTTPS — scheme enforcement', () => {
  it('rejects git:// URLs with an error mentioning https://', async () => {
    await expect(
      installPlugin('git://github.com/owner/repo', {}, { pluginsDir, indexPath }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('rejects http:// URLs', async () => {
    await expect(
      installPlugin('http://github.com/owner/repo', {}, { pluginsDir, indexPath }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('rejects ssh:// URLs', async () => {
    await expect(
      installPlugin('ssh://git@github.com/owner/repo', {}, { pluginsDir, indexPath }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('rejects file:// URLs', async () => {
    await expect(
      installPlugin('file:///home/user/repo', {}, { pluginsDir, indexPath }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('rejects git+ssh:// URLs', async () => {
    await expect(
      installPlugin('git+ssh://git@github.com/owner/repo', {}, { pluginsDir, indexPath }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('rejects git@host: SSH shorthand', async () => {
    await expect(
      installPlugin('git@github.com:owner/repo.git', {}, { pluginsDir, indexPath }),
    ).rejects.toThrow(/https:\/\//i);
  });

  it('does NOT reject a valid https:// URL (passes URL validation)', async () => {
    const { runner } = makeFakeGit();
    // This should not throw on URL validation — it may fail elsewhere but not here.
    // We pass confirm:false so we skip the countdown, and a real runner so clone succeeds.
    const result = await installPlugin(
      'https://github.com/owner/repo.git',
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    expect(result.name).toBe('test-plugin');
    expect(existsSync(result.dir)).toBe(true);
  });

  it('does NOT reject GitHub owner/repo shorthand (expands to https://)', async () => {
    const { runner } = makeFakeGit();
    const result = await installPlugin(
      'owner/legit-repo',
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    expect(result.name).toBe('test-plugin');
  });
});

// ── (b) S7-hooks: clone + checkout `-c` hardening flags ───────────────────

describe('S7-hooks — clone is hardened via -c flags', () => {
  it('passes -c core.hooksPath=/dev/null on clone (suppresses post-checkout)', async () => {
    const { runner, calls } = makeFakeGit();
    await installPlugin(
      'owner/repo',
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    const cloneCall = calls.find((c) => subcommandOf(c.args) === 'clone');
    expect(cloneCall, 'expected a clone invocation').toBeDefined();
    expect(hasFlagPair(cloneCall!.args, 'core.hooksPath=/dev/null')).toBe(true);
  });

  it('passes -c filter.process= on clone (defangs filter drivers)', async () => {
    const { runner, calls } = makeFakeGit();
    await installPlugin(
      'owner/repo',
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    const cloneCall = calls.find((c) => subcommandOf(c.args) === 'clone');
    expect(hasFlagPair(cloneCall!.args, 'filter.process=')).toBe(true);
  });

  it('passes -c filter.smudge= and filter.clean= on clone (.gitattributes confused-deputy defense)', async () => {
    const { runner, calls } = makeFakeGit();
    await installPlugin(
      'owner/repo',
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    const cloneCall = calls.find((c) => subcommandOf(c.args) === 'clone');
    expect(hasFlagPair(cloneCall!.args, 'filter.smudge=')).toBe(true);
    expect(hasFlagPair(cloneCall!.args, 'filter.clean=')).toBe(true);
  });

  it('does NOT rely on GIT_CONFIG_COUNT env (Git ≥ 2.31-only — no-ops on older releases)', async () => {
    // Pin the regression. The previous implementation set GIT_CONFIG_COUNT/
    // KEY_0/VALUE_0 in env, which silently no-op'd on Git < 2.31 (Ubuntu
    // 20.04, macOS Catalina, Debian buster, CentOS 7). The `-c` form is
    // supported on Git ≥ 2.8 (March 2010). Even if env contains the legacy
    // vars (for back-compat), the hardening flags must still be in args.
    const { runner, calls } = makeFakeGit();
    await installPlugin(
      'owner/repo',
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    const cloneCall = calls.find((c) => subcommandOf(c.args) === 'clone');
    expect(hasFlagPair(cloneCall!.args, 'core.hooksPath=/dev/null')).toBe(true);
  });
});

// CRITICAL — this section pins the fix for the `git.checkout()` bypass.
// Before the hardening rewrite, env vars passed to `clone()` were never
// re-applied to the subsequent `git checkout --detach <ref>` inside the
// untrusted cloned repo, so post-checkout hooks fired unblocked.
describe('S7-hooks — checkout is hardened (closes post-checkout hook bypass)', () => {
  it('passes -c core.hooksPath=/dev/null on `checkout --detach`', async () => {
    const { runner, calls } = makeFakeGit();
    // Use an explicit --ref so installPlugin always invokes checkout
    // (not just relying on the default-branch fast-path).
    await installPlugin(
      'owner/repo',
      { ref: 'v1.0.0' },
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout');
    expect(checkoutCall, 'expected a checkout invocation when --ref is set').toBeDefined();
    expect(hasFlagPair(checkoutCall!.args, 'core.hooksPath=/dev/null')).toBe(true);
  });

  it('passes -c filter.smudge= on checkout (smudge filter runs every checkout)', async () => {
    const { runner, calls } = makeFakeGit();
    await installPlugin(
      'owner/repo',
      { ref: 'v1.0.0' },
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout');
    expect(hasFlagPair(checkoutCall!.args, 'filter.smudge=')).toBe(true);
  });

  it('still issues `checkout --detach <ref>` (hardening does not break ref handling)', async () => {
    const { runner, calls } = makeFakeGit();
    await installPlugin(
      'owner/repo',
      { ref: 'abc123' },
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    const checkoutCall = calls.find((c) => subcommandOf(c.args) === 'checkout');
    const args = checkoutCall!.args;
    // The tail of args is the actual git verb + flags + ref.
    expect(args.slice(-3)).toEqual(['checkout', '--detach', 'abc123']);
  });
});

describe('S7-hooks — read-only operations are not hardened (no working-tree mutation)', () => {
  it('listTags / rev-parse / symbolic-ref do not get `-c` prefix', async () => {
    const { runner, calls } = makeFakeGit();
    await installPlugin(
      'owner/repo',
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    const readOnlySubs = ['tag', 'rev-parse', 'symbolic-ref'];
    for (const call of calls) {
      const sub = subcommandOf(call.args);
      if (sub && readOnlySubs.includes(sub)) {
        // First positional should BE the subcommand — no `-c` prefix.
        expect(call.args[0]).toBe(sub);
      }
    }
  });
});

// ── (c) S7-warning: prominent stderr warning ───────────────────────────────

describe('S7-warning — install warning behaviour', () => {
  it('prints a warning to stderr BEFORE the clone when confirm defaults to true (interactive)', async () => {
    const cloneCallOrder: string[] = [];

    const orderTrackingRunner: GitRunner = async (args, _cwd, _env) => {
      const sub = subcommandOf(args);
      if (sub === 'clone') {
        cloneCallOrder.push('clone');
        const dest = args[args.length - 1] as string;
        mkdirSync(dest, { recursive: true });
        writeManifest(dest, 'test-plugin');
        return { stdout: '', stderr: '' };
      }
      if (sub === 'tag') return { stdout: 'v1.0.0\n', stderr: '' };
      if (sub === 'rev-parse') return { stdout: 'abc123\n', stderr: '' };
      if (sub === 'symbolic-ref') return { stdout: 'origin/main\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    // Override stderrSpy to also track ordering relative to clone.
    let warnWritten = false;
    stderrSpy.mockRestore();
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      if (!cloneCallOrder.includes('clone')) {
        warnWritten = true;
      }
      stderrWrites.push(String(chunk));
      return true;
    });

    await installPlugin(
      'https://github.com/owner/repo.git',
      {},
      {
        pluginsDir,
        indexPath,
        gitRunner: orderTrackingRunner,
        confirm: true,
        // confirmDelayMs: 0 so the test doesn't actually wait 3 seconds
        confirmDelayMs: 0,
      },
    );

    expect(warnWritten).toBe(true);
    expect(cloneCallOrder).toContain('clone');
  });

  it('warning mentions "arbitrary code execution"', async () => {
    const { runner } = makeFakeGit();
    await installPlugin(
      'https://github.com/owner/repo.git',
      {},
      {
        pluginsDir,
        indexPath,
        gitRunner: runner,
        confirm: true,
        confirmDelayMs: 0,
      },
    );
    const allStderr = stderrWrites.join('');
    expect(allStderr).toMatch(/arbitrary code execution/i);
  });

  it('warning includes the URL being installed', async () => {
    const { runner } = makeFakeGit();
    const url = 'https://github.com/owner/repo.git';
    await installPlugin(
      url,
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: true, confirmDelayMs: 0 },
    );
    const allStderr = stderrWrites.join('');
    expect(allStderr).toContain(url);
  });

  it('warning instructs the user to audit the source', async () => {
    const { runner } = makeFakeGit();
    await installPlugin(
      'https://github.com/owner/repo.git',
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: true, confirmDelayMs: 0 },
    );
    const allStderr = stderrWrites.join('');
    expect(allStderr).toMatch(/audit/i);
  });

  it('does NOT print a warning to stderr when confirm is false', async () => {
    const { runner } = makeFakeGit();
    await installPlugin(
      'https://github.com/owner/repo.git',
      {},
      { pluginsDir, indexPath, gitRunner: runner, confirm: false },
    );
    const allStderr = stderrWrites.join('');
    // No warning content should be written when confirm=false
    expect(allStderr).not.toMatch(/arbitrary code execution/i);
    expect(allStderr).not.toMatch(/audit/i);
  });
});
