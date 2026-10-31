/**
 * Tests for the OS-level bash sandbox (issue #3845).
 *
 * @module agent/tools/handlers/bash-sandbox.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseSandboxPolicy,
  buildSandboxedCommand,
  sandboxDescription,
  _resetBwrapCacheForTests,
  _forceBwrapUnavailableForTests,
} from './bash-sandbox.js';
import { canonicalSandboxPath, sandboxSchemeString, sandboxWriteFloor } from './bash-sandbox.paths.js';
import { getWriteDenylist } from './write-denylist.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Stub process.platform for a test scope. Restores afterEach. */
function withPlatform(platform: string, fn: () => void): void {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
}

// ── parseSandboxPolicy ─────────────────────────────────────────────────────

describe('parseSandboxPolicy', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('returns undefined when AFK_BASH_SANDBOX is unset', () => {
    delete process.env['AFK_BASH_SANDBOX']; // audit-env-access: allow — test env mutation
    expect(parseSandboxPolicy()).toBeUndefined();
  });

  it('returns undefined when AFK_BASH_SANDBOX is empty string', () => {
    process.env['AFK_BASH_SANDBOX'] = ''; // audit-env-access: allow — test env mutation
    expect(parseSandboxPolicy()).toBeUndefined();
  });

  it.each([
    ['workspace-write', 'workspace-write'],
    ['read-only', 'read-only'],
    ['off', 'off'],
    ['WORKSPACE-WRITE', 'workspace-write'],
    ['  read-only  ', 'read-only'],
  ] as const)('parses "%s" → %s', (raw, expected) => {
    process.env['AFK_BASH_SANDBOX'] = raw; // audit-env-access: allow — test env mutation
    expect(parseSandboxPolicy()).toBe(expected);
  });

  it('throws on unrecognised value', () => {
    process.env['AFK_BASH_SANDBOX'] = 'restricted'; // audit-env-access: allow — test env mutation
    expect(() => parseSandboxPolicy()).toThrow(/not a recognised policy/);
    expect(() => parseSandboxPolicy()).toThrow(/workspace-write | read-only | off/);
  });
});

// ── buildSandboxedCommand — off policy ────────────────────────────────────

describe('buildSandboxedCommand — off', () => {
  it('returns sandboxed:false for off policy on any platform', () => {
    const result = buildSandboxedCommand('echo hi', 'off', '/workspace');
    expect(result.sandboxed).toBe(false);
    expect(result.command).toBe('echo hi');
  });
});

// ── buildSandboxedCommand — Windows ───────────────────────────────────────

describe('buildSandboxedCommand — win32', () => {
  afterEach(() => {
    _resetBwrapCacheForTests();
  });

  it('throws for workspace-write (fail-closed)', () => {
    withPlatform('win32', () => {
      expect(() =>
        buildSandboxedCommand('echo hi', 'workspace-write', 'C:\\workspace'),
      ).toThrow(/not supported on Windows/);
    });
  });

  it('throws for read-only (fail-closed)', () => {
    withPlatform('win32', () => {
      expect(() =>
        buildSandboxedCommand('echo hi', 'read-only', undefined),
      ).toThrow(/not supported on Windows/);
    });
  });

  it('error message mentions existing string-based guards remain active', () => {
    withPlatform('win32', () => {
      expect(() =>
        buildSandboxedCommand('echo hi', 'workspace-write', undefined),
      ).toThrow(/string-based path guards remain active/);
    });
  });

  it('does not throw for off on win32', () => {
    withPlatform('win32', () => {
      expect(() =>
        buildSandboxedCommand('echo hi', 'off', undefined),
      ).not.toThrow();
    });
  });
});

// ── buildSandboxedCommand — macOS ─────────────────────────────────────────

describe('buildSandboxedCommand — darwin', () => {
  it('returns sandboxed:true for workspace-write', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('ls -la', 'workspace-write', '/Users/me/project');
      expect(result.sandboxed).toBe(true);
      expect(result.command).toBe('ls -la');
    });
  });

  it('sandbox-exec is the shell executable', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('ls', 'workspace-write', '/tmp/work');
      expect(result.shell).toContain('sandbox-exec');
    });
  });

  it('args include -p flag for inline profile', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('ls', 'workspace-write', '/tmp/work');
      expect(result.args[0]).toBe('-p');
    });
  });

  it('profile allows file-read*', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('cat /etc/hostname', 'workspace-write', '/work');
      const profile = result.args[1] as string;
      expect(profile).toContain('(allow file-read*)');
    });
  });

  it('workspace-write profile allows writes to cwd', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('touch out.txt', 'workspace-write', '/my/workspace');
      const profile = result.args[1] as string;
      const expected = sandboxSchemeString(canonicalSandboxPath('/my/workspace'));
      expect(profile).toContain(`(allow file-write* (subpath ${expected}))`);
    });
  });

  it('workspace-write profile denies writes to ~/.ssh', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('echo x', 'workspace-write', '/work');
      const profile = result.args[1] as string;
      expect(profile).toContain('(deny file-write*');
      expect(profile).toContain('.ssh');
    });
  });

  it('workspace-write profile denies writes to ~/.aws', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('echo x', 'workspace-write', '/work');
      const profile = result.args[1] as string;
      expect(profile).toContain('.aws');
    });
  });

  it('workspace-write profile denies writes to ~/.afk/config', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('echo x', 'workspace-write', '/work');
      const profile = result.args[1] as string;
      expect(profile).toContain('.afk');
    });
  });

  it('read-only profile has no file-write* allow rule', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('cat file', 'read-only', '/my/workspace');
      const profile = result.args[1] as string;
      // No allow file-write* line (deny lines are present but no allow)
      expect(profile).not.toContain('(allow file-write*');
    });
  });

  it('profile starts with (version 1)', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('ls', 'workspace-write', '/tmp');
      const profile = result.args[1] as string;
      expect(profile.trimStart()).toMatch(/^\(version 1\)/);
    });
  });

  it('profile preserves non-write operations with allow default', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('ls', 'workspace-write', '/tmp');
      const profile = result.args[1] as string;
      expect(profile).toContain('(allow default)');
      expect(profile).toContain('(deny file-write*)');
    });
  });

  it('args end with /bin/sh -c so the command runs in a shell', () => {
    withPlatform('darwin', () => {
      const result = buildSandboxedCommand('ls', 'read-only', undefined);
      const args = result.args as string[];
      const shIdx = args.indexOf('/bin/sh');
      expect(shIdx).toBeGreaterThan(-1);
      expect(args[shIdx + 1]).toBe('-c');
    });
  });
});

// ── buildSandboxedCommand — Linux ─────────────────────────────────────────
// Linux tests exercise the bwrap path directly when bwrap is installed, and
// verify fail-closed behaviour via the exported _forceBwrapAvailableForTests
// test hook. vi.mock is not used here — the bwrap availability cache is
// controlled via the exported test helpers instead.

describe('buildSandboxedCommand — linux (bwrap available on host)', () => {
  afterEach(() => {
    _resetBwrapCacheForTests();
  });

  it('returns sandboxed:true with an absolute trusted bwrap path when installed', () => {
    withPlatform('linux', () => {
      _resetBwrapCacheForTests();
      try {
        const result = buildSandboxedCommand('ls', 'workspace-write', '/work', '/synthetic-disjoint-temp');
        // When bwrap is installed: sandboxed result expected.
        expect(result.shell).toMatch(/^\/usr\/(?:bin|local\/bin|sbin)\/bwrap$/);
        expect(result.sandboxed).toBe(true);
        expect(result.command).toBe('ls');
      } catch (err: unknown) {
        // bwrap not installed on this host — fail-closed error is correct.
        if (err instanceof Error && err.message.includes('no sandbox mechanism')) return;
        throw err;
      }
    });
  });

  it('bwrap args include --ro-bind / / for workspace-write', () => {
    withPlatform('linux', () => {
      _resetBwrapCacheForTests();
      try {
        const result = buildSandboxedCommand('ls', 'workspace-write', '/my/project', '/synthetic-disjoint-temp');
        const args = result.args as string[];
        expect(args).toContain('--ro-bind');
        expect(args).toContain('--bind');
        expect(args).toContain('/my/project');
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('no sandbox mechanism')) return;
        throw err;
      }
    });
  });

  it('bwrap args do NOT include --bind for read-only policy', () => {
    withPlatform('linux', () => {
      _resetBwrapCacheForTests();
      try {
        const result = buildSandboxedCommand('cat file', 'read-only', '/my/project');
        const args = result.args as string[];
        // read-only: no rw bind for cwd
        expect(args).toContain('--ro-bind');
        expect(args).not.toContain('--bind');
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('no sandbox mechanism')) return;
        throw err;
      }
    });
  });
});

describe('buildSandboxedCommand — linux (fail-closed when bwrap unavailable)', () => {
  afterEach(() => {
    _resetBwrapCacheForTests();
  });

  it('throws with install instructions when policy is workspace-write and bwrap missing', () => {
    // Use the exported test hook to force bwrap-unavailable.
    _forceBwrapUnavailableForTests();
    withPlatform('linux', () => {
      expect(() =>
        buildSandboxedCommand('ls', 'workspace-write', '/work'),
      ).toThrow(/no sandbox mechanism/);
    });
  });

  it('error message includes package manager install commands', () => {
    _forceBwrapUnavailableForTests();
    withPlatform('linux', () => {
      expect(() =>
        buildSandboxedCommand('ls', 'read-only', '/work'),
      ).toThrow(/bubblewrap/);
    });
  });

  it('error message mentions string-based guards remain active', () => {
    _forceBwrapUnavailableForTests();
    withPlatform('linux', () => {
      expect(() =>
        buildSandboxedCommand('ls', 'workspace-write', '/work'),
      ).toThrow(/string-based path guards remain active/);
    });
  });
});

// ── sandboxDescription ────────────────────────────────────────────────────

describe('sandboxDescription', () => {
  it('returns "sandbox: off" for off policy', () => {
    expect(sandboxDescription('off')).toBe('sandbox: off');
  });

  it('contains sandbox-exec for darwin', () => {
    withPlatform('darwin', () => {
      expect(sandboxDescription('workspace-write')).toContain('sandbox-exec');
    });
  });

  it('contains bwrap for linux', () => {
    withPlatform('linux', () => {
      expect(sandboxDescription('read-only')).toContain('bwrap');
    });
  });

  it('contains policy name in description', () => {
    withPlatform('darwin', () => {
      expect(sandboxDescription('workspace-write')).toContain('workspace-write');
      expect(sandboxDescription('read-only')).toContain('read-only');
    });
  });
});

// ── Security: credential paths are always denied ─────────────────────────

describe('credential path denial (macOS profile)', () => {
  it('uses every entry of the actual shared floor, not a partial credential copy', () => {
    withPlatform('darwin', () => {
      const profile = buildSandboxedCommand('true', 'workspace-write', '/work').args[1]!;
      const floor = sandboxWriteFloor();
      // The profile must contain a deny rule for every floor entry.
      for (const entry of floor) {
        expect(profile).toContain(`(deny file-write* (subpath ${sandboxSchemeString(entry)}))`);
      }
    });
  });

  const CREDENTIAL_PATHS = ['.ssh', '.aws', '.gnupg', '.afk', '.npmrc', '.docker'];

  for (const credPath of CREDENTIAL_PATHS) {
    it(`denies writes to ${credPath} in workspace-write profile`, () => {
      withPlatform('darwin', () => {
        const result = buildSandboxedCommand('echo x', 'workspace-write', '/work');
        const profile = result.args[1] as string;
        // Profile must contain a deny rule mentioning this credential path.
        expect(profile).toContain(credPath);
        // SBPL last matching rule wins: floor denies follow all write grants.
        const denyIdx = profile.indexOf(`(deny file-write*`);
        const allowWriteIdx = profile.indexOf(`(allow file-write* (subpath "/work")`);
        expect(denyIdx).toBeGreaterThan(-1);
        // The first deny is the blanket write restriction; floor denies are last.
        if (allowWriteIdx !== -1) {
          expect(profile.lastIndexOf('(deny file-write*')).toBeGreaterThan(allowWriteIdx);
        }
      });
    });
  }
});
