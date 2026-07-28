/**
 * Unit tests for the read-denylist shared utility.
 *
 * Covers:
 * - Credential stores (~/.ssh, ~/.aws, ~/.gnupg, ~/.afk/config, ~/.npmrc,
 *   ~/.docker/config.json) plus git/gh/k8s token files (~/.git-credentials,
 *   ~/.netrc, ~/.config/gh/hosts.yml, ~/.kube/config) are read-denied.
 * - Deliberate divergence from the WRITE denylist: ~/.afk/STATE is NOT denied
 *   (forks must read skill-preflight/todos/transcripts — #544/#547/#554), and
 *   /etc is not blanket-denied (only specific secret files).
 * - Symlink bypass is blocked: a symlink into a denylisted dir is dereferenced
 *   (via a tmpdir fixture that always runs, not gated on ~/.ssh existing).
 * - Custom AFK_READ_DENYLIST entries are applied (with cache reset).
 * - The ~/.afk/config/mcp.json exception: allowed, exact-file only (backups and
 *   pseudo-children stay denied), re-deniable via AFK_READ_DENYLIST, and
 *   resolved leaf-un-dereferenced so a symlinked registry cannot launder a
 *   protected target into the exception set (PR #728 review P1).
 *
 * @module agent/tools/handlers/read-denylist.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  isReadDenied,
  assertNotReadDenied,
  getReadDenylist,
  BUILTIN_READ_DENYLIST,
  BUILTIN_READ_ALLOWLIST,
  resolveExceptionEntry,
  _resetReadDenylistCacheForTests,
} from './read-denylist.js';
import { safeRealpath } from './write-denylist.js';

let tmpDir: string;

beforeEach(() => {
  _resetReadDenylistCacheForTests();
  tmpDir = join(tmpdir(), `afk-read-denylist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  delete process.env['AFK_READ_DENYLIST'];
  _resetReadDenylistCacheForTests();
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('isReadDenied — credential stores', () => {
  const credPaths = [
    join(homedir(), '.ssh', 'id_rsa'),
    join(homedir(), '.aws', 'credentials'),
    join(homedir(), '.gnupg', 'secring.gpg'),
    join(homedir(), '.afk', 'config', 'afk.env'),
    join(homedir(), '.npmrc'),
    join(homedir(), '.docker', 'config.json'),
    // Git/HTTP credential stores and CLI OAuth tokens (read-exfil hardening).
    join(homedir(), '.git-credentials'),
    join(homedir(), '.netrc'),
    join(homedir(), '.config', 'gh', 'hosts.yml'),
    join(homedir(), '.kube', 'config'),
  ];

  for (const p of credPaths) {
    it(`denies ${p.replace(homedir(), '~')}`, () => {
      expect(isReadDenied(p).denied).toBe(true);
    });
  }

  it('every BUILTIN_READ_DENYLIST entry triggers the guard', () => {
    for (const entry of BUILTIN_READ_DENYLIST) {
      expect(isReadDenied(join(entry, 'probe')).denied).toBe(true);
    }
  });
});

describe('isReadDenied — deliberate divergence from the write denylist', () => {
  it('does NOT deny ~/.afk/state (forks must read skill-preflight/todos/transcripts)', () => {
    expect(isReadDenied(join(homedir(), '.afk', 'state', 'skill-preflight', 's', 'pr.diff')).denied).toBe(false);
    expect(isReadDenied(join(homedir(), '.afk', 'state', 'todos', 't.json')).denied).toBe(false);
  });

  it('DOES deny ~/.afk/config (afk.env credentials)', () => {
    expect(isReadDenied(join(homedir(), '.afk', 'config', 'afk.env')).denied).toBe(true);
    // afk.config.json may carry a literal `apiKey` (cli/config/types.ts) — the
    // whole-dir floor must keep covering it and every operator backup sibling.
    expect(isReadDenied(join(homedir(), '.afk', 'config', 'afk.config.json')).denied).toBe(true);
    expect(
      isReadDenied(join(homedir(), '.afk', 'config', 'afk.env.bak-20260617')).denied,
    ).toBe(true);
  });

  it('does NOT blanket-deny /etc (ordinary system reads stay allowed)', () => {
    expect(isReadDenied('/etc/hosts').denied).toBe(false);
    expect(isReadDenied('/etc/resolv.conf').denied).toBe(false);
  });

  it('DOES deny the enumerated secret system files', () => {
    expect(isReadDenied('/etc/shadow').denied).toBe(true);
    expect(isReadDenied('/etc/sudoers').denied).toBe(true);
  });

  it('does NOT deny an ordinary project path', () => {
    expect(isReadDenied(join(tmpDir, 'src', 'index.ts')).denied).toBe(false);
    expect(isReadDenied('/tmp/some-repo/package.json').denied).toBe(false);
  });
});

describe('isReadDenied — built-in exception for ~/.afk/config/mcp.json', () => {
  const mcp = join(homedir(), '.afk', 'config', 'mcp.json');

  it('allows the MCP registry itself (it holds ${VAR} placeholders, not secrets)', () => {
    expect(isReadDenied(mcp).denied).toBe(false);
  });

  it('is an EXACT-file carve-out — siblings and pseudo-children stay denied', () => {
    expect(isReadDenied(mcp + '.bak').denied).toBe(true);
    expect(isReadDenied(join(mcp, 'child.json')).denied).toBe(true);
    expect(isReadDenied(join(homedir(), '.afk', 'config', 'mcp.json.old')).denied).toBe(true);
    expect(isReadDenied(join(homedir(), '.afk', 'config')).denied).toBe(true);
  });

  it('stays re-deniable via AFK_READ_DENYLIST (extras outrank the exception)', () => {
    process.env['AFK_READ_DENYLIST'] = mcp;
    _resetReadDenylistCacheForTests();
    const verdict = isReadDenied(mcp);
    expect(verdict.denied).toBe(true);
    expect(verdict.matched).toBe(mcp);
  });

  it('re-denies via a DIRECTORY extra that contains the exception', () => {
    process.env['AFK_READ_DENYLIST'] = join(homedir(), '.afk', 'config');
    _resetReadDenylistCacheForTests();
    expect(isReadDenied(mcp).denied).toBe(true);
  });

  it('assertNotReadDenied does not throw for the carve-out', () => {
    expect(() => assertNotReadDenied(mcp)).not.toThrow();
  });
});

// Regression guard for PR #728 review P1: the exception list must never be
// expressed as the symlink TARGET of its own leaf. `safeRealpath` on the whole
// entry would let a `mcp.json` symlinked at a protected file put THAT file in
// the exception set — and because exceptions are consulted before the built-in
// prefixes, a DIRECT read of the protected file would return allowed.
// The built-in lists are keyed to the real homedir(), so the invariant is
// asserted against `resolveExceptionEntry` with tmpdir fixtures.
describe('read-denylist — exception entries dereference the dir chain, never the leaf', () => {
  it('resolves a symlinked config DIRECTORY (dotfiles relocation still works)', () => {
    const realCfg = join(tmpDir, 'real-cfg');
    mkdirSync(realCfg, { recursive: true });
    const linkCfg = join(tmpDir, 'link-cfg');
    symlinkSync(realCfg, linkCfg);

    // safeRealpath on the expectation too: on macOS tmpdir() sits under /var,
    // itself a symlink to /private/var, so the dir chain legitimately resolves.
    expect(resolveExceptionEntry(join(linkCfg, 'mcp.json'))).toBe(
      join(safeRealpath(realCfg), 'mcp.json'),
    );
  });

  it('does NOT resolve a leaf symlink pointing at a protected file', () => {
    const cfg = join(tmpDir, 'cfg');
    const secretDir = join(tmpDir, 'fake-ssh');
    mkdirSync(cfg, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    const secret = join(secretDir, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY', 'utf-8');
    const entry = join(cfg, 'mcp.json');
    symlinkSync(secret, entry);

    const resolved = resolveExceptionEntry(entry);
    // The protected target never becomes the exception…
    expect(resolved).not.toBe(secret);
    expect(resolved).not.toBe(safeRealpath(secret));
    expect(resolved).not.toContain('id_rsa');
    // …the entry stays its own nominal leaf inside the (resolved) config dir.
    expect(resolved).toBe(join(safeRealpath(cfg), 'mcp.json'));
    expect(basename(resolved)).toBe('mcp.json');
  });

  it('keeps every built-in exception inside the resolved ~/.afk/config dir', () => {
    for (const entry of BUILTIN_READ_ALLOWLIST) {
      const resolved = resolveExceptionEntry(entry);
      expect(basename(resolved)).toBe(basename(entry));
      expect(dirname(resolved)).toBe(safeRealpath(join(homedir(), '.afk', 'config')));
    }
  });

  it('a protected path is still denied when reached directly (the P1 regression)', () => {
    // Belt-and-braces on the real built-ins: whatever the exception list resolves
    // to, a direct credential read must never be admitted by it.
    for (const entry of BUILTIN_READ_ALLOWLIST) {
      expect(resolveExceptionEntry(entry)).not.toMatch(/\/\.(ssh|aws|gnupg)\//);
    }
    expect(isReadDenied(join(homedir(), '.ssh', 'id_rsa')).denied).toBe(true);
    expect(isReadDenied(join(homedir(), '.afk', 'config', 'afk.env')).denied).toBe(true);
  });
});

describe('assertNotReadDenied', () => {
  it('throws for a credential path, with the handler name in the message', () => {
    expect(() => assertNotReadDenied(join(homedir(), '.ssh', 'id_rsa'), 'grep')).toThrow(/grep/);
    expect(() => assertNotReadDenied(join(homedir(), '.ssh', 'id_rsa'))).toThrow(
      /refusing to read protected path/,
    );
  });

  it('does not throw for a normal path', () => {
    expect(() => assertNotReadDenied(join(tmpDir, 'ok.ts'))).not.toThrow();
  });
});

describe('read-denylist — symlink dereference', () => {
  // Robust fixture: build a real denylisted dir inside tmpDir (registered via
  // AFK_READ_DENYLIST) and point a symlink at it, so the dereference path is
  // exercised UNCONDITIONALLY — not gated on ~/.ssh existing on the runner
  // (the prior test silently returned when it didn't, asserting nothing).
  it('blocks a read through a symlink that resolves into a denylisted dir', () => {
    const secretDir = join(tmpDir, 'real-secret');
    mkdirSync(secretDir, { recursive: true });
    process.env['AFK_READ_DENYLIST'] = secretDir;
    _resetReadDenylistCacheForTests();

    const linkPath = join(tmpDir, 'secret-link');
    symlinkSync(secretDir, linkPath);

    // Reading THROUGH the symlink must be denied (safeRealpath dereferences it
    // to the denylisted target before the prefix comparison).
    const via = isReadDenied(join(linkPath, 'token.txt'));
    expect(via.denied).toBe(true);
    // And the innocuous symlink path is not what matched — the resolved target is.
    expect(via.matched).not.toBe(linkPath);
  });

  it('dereferences a symlink into a built-in denylisted dir when it exists', () => {
    // Bonus real-world case against a built-in (~/.ssh). Kept guarded because
    // the runner may lack ~/.ssh; the tmpdir fixture above is the authoritative
    // dereference assertion, so skipping here never leaves the suite vacuous.
    const sshDir = join(homedir(), '.ssh');
    if (!existsSync(sshDir)) return;
    const linkPath = join(tmpDir, 'ssh-link');
    symlinkSync(sshDir, linkPath);
    expect(isReadDenied(join(linkPath, 'id_rsa')).denied).toBe(true);
  });
});

describe('read-denylist — AFK_READ_DENYLIST extras', () => {
  it('applies a custom colon-separated denylist entry (built-ins still apply)', () => {
    const projectSecret = join(tmpDir, 'secrets');
    mkdirSync(projectSecret, { recursive: true });
    process.env['AFK_READ_DENYLIST'] = projectSecret;
    _resetReadDenylistCacheForTests();

    expect(isReadDenied(join(projectSecret, '.env')).denied).toBe(true);
    // Built-ins are unaffected by the custom list.
    expect(isReadDenied(join(homedir(), '.ssh', 'id_rsa')).denied).toBe(true);
    // The resolved list contains the custom entry.
    expect(getReadDenylist().some((p) => p.includes('secrets'))).toBe(true);
  });
});
