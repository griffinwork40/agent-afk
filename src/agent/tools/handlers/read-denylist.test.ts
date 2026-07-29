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
 * - The reverse gap closed alongside PR #734 (bash/read-denylist parity):
 *   ~/.password-store (whole dir) and per-browser secret trees under
 *   ~/Library/Application Support (Chrome, Chromium, BraveSoftware, Microsoft
 *   Edge, Arc, Firefox) are now read-denied too — but the browser floor is
 *   scoped NARROWER than the bash hook's whole-dir root, so a non-secret
 *   Application Support sibling (e.g. an editor's settings.json) stays
 *   readable. That narrowness is pinned explicitly below.
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
  parseReadDenylistEntries,
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

describe('isReadDenied — reverse-gap closure: password-store + browser secret trees', () => {
  // These roots were bash-only (`builtinBashSensitiveRoots` in
  // bash-restriction-hook.ts) before this change: blocked for `cat`, wide open
  // for read_file/grep/glob/list_directory. See the module-header History note
  // and the inline comment on these BUILTIN_READ_DENYLIST entries for why the
  // browser floor is scoped to secret trees rather than the whole
  // `~/Library/Application Support` directory the bash hook floors.

  it('denies ~/.password-store wholesale — nothing under it is legitimately readable', () => {
    expect(isReadDenied(join(homedir(), '.password-store')).denied).toBe(true);
    expect(
      isReadDenied(join(homedir(), '.password-store', 'personal', 'email.gpg')).denied,
    ).toBe(true);
  });

  describe.each([
    ['Google Chrome', join('Google', 'Chrome'), 'Login Data'],
    ['Chromium', 'Chromium', 'Cookies'],
    ['BraveSoftware', 'BraveSoftware', 'Web Data'],
    ['Microsoft Edge', 'Microsoft Edge', 'Login Data'],
    ['Arc', 'Arc', join('User Data', 'Default', 'Cookies')],
    ['Firefox', 'Firefox', join('Profiles', 'abc123.default-release', 'logins.json')],
  ])('%s profile tree', (_label, vendorRel, secretRel) => {
    const root = join(homedir(), 'Library', 'Application Support', vendorRel);

    it('denies the vendor root itself', () => {
      expect(isReadDenied(root).denied).toBe(true);
    });

    it('denies its secret file', () => {
      expect(isReadDenied(join(root, secretRel)).denied).toBe(true);
    });
  });

  it('every browser root is present in BUILTIN_READ_DENYLIST verbatim', () => {
    const appSupport = join(homedir(), 'Library', 'Application Support');
    const expectedRoots = [
      join(appSupport, 'Google', 'Chrome'),
      join(appSupport, 'Chromium'),
      join(appSupport, 'BraveSoftware'),
      join(appSupport, 'Microsoft Edge'),
      join(appSupport, 'Arc'),
      join(appSupport, 'Firefox'),
    ];
    for (const root of expectedRoots) {
      expect(BUILTIN_READ_DENYLIST).toContain(root);
    }
  });

  it('does NOT floor the whole ~/Library/Application Support directory (narrow-scope pin)', () => {
    // The point of scoping to secret trees instead of the bash hook's whole-dir
    // root: a non-secret Application Support sibling must stay readable. This
    // is the assertion the deliberate narrowing exists to satisfy — if a future
    // edit widens BUILTIN_READ_DENYLIST to the whole directory (matching the
    // bash extra), THIS test is what catches it.
    expect(
      isReadDenied(
        join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'),
      ).denied,
    ).toBe(false);
    // Second, independent non-browser sibling — the terminal_font_size feature's
    // other target — so the pin isn't resting on a single editor's config path.
    expect(
      isReadDenied(
        join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
      ).denied,
    ).toBe(false);
    // And a plain top-level sibling with no relation to any browser.
    expect(
      isReadDenied(join(homedir(), 'Library', 'Application Support', 'SomeOtherApp')).denied,
    ).toBe(false);
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

  // Invariant: a leading `~` is expanded. The documented way to re-protect the
  // MCP registry is itself tilde-spelled, and `resolve('~/x')` yields a literal
  // `<cwd>/~/x` that matches nothing — so before PR #734's review fix this
  // exact instruction silently protected no path on either surface. A plain
  // `resolve()` regression fails here rather than in an operator's session.
  it('expands a leading ~/ so the documented tilde-spelled entry actually denies', () => {
    process.env['AFK_READ_DENYLIST'] = '~/.afk/config/mcp.json';
    _resetReadDenylistCacheForTests();

    // The carve-out is re-denied, exactly as the absolute spelling would.
    expect(isReadDenied(join(homedir(), '.afk', 'config', 'mcp.json')).denied).toBe(true);
    // And no literal `~` segment survives into the resolved list.
    expect(getReadDenylist().some((p) => p.includes('~'))).toBe(false);
  });

  it('leaves ~user/ unexpanded (no portable home lookup) rather than guessing', () => {
    process.env['AFK_READ_DENYLIST'] = '~someone/.ssh';
    _resetReadDenylistCacheForTests();
    // Resolved relative to cwd, not to another user's home — and crucially it
    // does NOT widen into the real ~/.ssh floor, which stands on its own.
    expect(getReadDenylist().some((p) => p.endsWith('~someone/.ssh'))).toBe(true);
    expect(isReadDenied(join(homedir(), '.ssh', 'id_rsa')).denied).toBe(true);
  });
});

describe('parseReadDenylistEntries — the single parser both surfaces share', () => {
  // Invariant: bash-restriction-hook.ts imports THIS function instead of
  // re-implementing the parse. The duplicate it used to keep is how the tilde
  // bug reached both surfaces at once (PR #734 review, MAJOR 1).
  it('splits on colons, trims, drops empties, and absolutizes', () => {
    expect(parseReadDenylistEntries('  /a/b : :/c/d  ')).toEqual(['/a/b', '/c/d']);
    expect(parseReadDenylistEntries(undefined)).toEqual([]);
    expect(parseReadDenylistEntries('')).toEqual([]);
  });

  it('expands a bare ~ and a leading ~/', () => {
    expect(parseReadDenylistEntries('~')).toEqual([homedir()]);
    expect(parseReadDenylistEntries('~/.netrc')).toEqual([join(homedir(), '.netrc')]);
  });
});
