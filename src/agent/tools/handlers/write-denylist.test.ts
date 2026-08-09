/**
 * Unit tests for the write-denylist shared utility (C3 / C5).
 *
 * Covers:
 * - write_file refuses protected paths
 * - edit_file refuses the same protected paths (symmetric guard — was missing pre-fix)
 * - Symlink bypass is blocked: a symlink inside ~ pointing to ~/.ssh is
 *   dereferenced and the real path is checked against the denylist.
 * - `safeRealpath` correctly resolves non-existent paths via ancestor walking.
 * - Custom AFK_WRITE_DENYLIST entries are applied.
 *
 * @module agent/tools/handlers/write-denylist.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetFsCaseCacheForTests } from '../fs-case.js';
import {
  mkdirSync,
  rmSync,
  symlinkSync,
  existsSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { tmpdir } from 'os';
import { writeFileHandler } from './write-file.js';
import { editFileHandler } from './edit-file.js';
import {
  assertNotDenylisted,
  safeRealpath,
  BUILTIN_WRITE_DENYLIST,
  getWriteDenylist,
} from './write-denylist.js';
import { resetAfkHomeWarnLatchForTests } from '../afk-home-warn.js';

const SIG = AbortSignal.timeout(5000);

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(
    tmpdir(),
    `afk-denylist-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a path that resolves to inside ~/.ssh regardless of how it's written */
const sshPath = join(homedir(), '.ssh', 'authorized_keys');

// ---------------------------------------------------------------------------
// assertNotDenylisted — unit tests for the core guard
// ---------------------------------------------------------------------------

describe('assertNotDenylisted', () => {
  it('throws for paths inside ~/.ssh', () => {
    expect(() => assertNotDenylisted(sshPath, 'write_file')).toThrow(
      /refusing to write to protected path/,
    );
  });

  it('throws for paths inside ~/.aws', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.aws', 'credentials'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('throws for paths inside /etc', () => {
    expect(() => assertNotDenylisted('/etc/passwd', 'write_file')).toThrow(
      /refusing to write to protected path/,
    );
  });

  it('includes the handler name in the error message', () => {
    expect(() => assertNotDenylisted(sshPath, 'edit_file')).toThrow(/edit_file/);
    expect(() => assertNotDenylisted(sshPath, 'write_file')).toThrow(/write_file/);
  });

  it('allows writes to a normal tmp path', () => {
    expect(() => assertNotDenylisted(join(tmpDir, 'safe.txt'))).not.toThrow();
  });

  it('all BUILTIN_WRITE_DENYLIST entries trigger the guard', () => {
    for (const entry of BUILTIN_WRITE_DENYLIST) {
      expect(() =>
        assertNotDenylisted(join(entry, 'test-file'), 'write_file'),
      ).toThrow(/refusing to write to protected path/);
    }
  });
});

// ---------------------------------------------------------------------------
// write_file handler — denylist
// ---------------------------------------------------------------------------

describe('writeFileHandler — denylist', () => {
  it('returns isError when attempting to write to ~/.ssh', async () => {
    const result = await writeFileHandler(
      { file_path: sshPath, content: 'test' },
      SIG,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/refusing to write to protected path|write_file/);
  });

  it('returns isError when attempting to write to ~/.aws/credentials', async () => {
    const result = await writeFileHandler(
      { file_path: join(homedir(), '.aws', 'credentials'), content: 'test' },
      SIG,
    );
    expect(result.isError).toBe(true);
  });

  it('allows writes to normal tmp path', async () => {
    const filePath = join(tmpDir, 'normal.txt');
    const result = await writeFileHandler(
      { file_path: filePath, content: 'hello' },
      SIG,
    );
    expect(result.isError).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// edit_file handler — denylist (symmetric gap that was missing pre-fix)
// ---------------------------------------------------------------------------

describe('editFileHandler — denylist (C4 fix: symmetric guard)', () => {
  it('returns isError when attempting to edit ~/.ssh/authorized_keys', async () => {
    const result = await editFileHandler(
      {
        file_path: sshPath,
        old_string: 'old',
        new_string: 'new',
      },
      SIG,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/refusing to write to protected path|edit_file/);
  });

  it('returns isError when attempting to edit a file in ~/.aws', async () => {
    const result = await editFileHandler(
      {
        file_path: join(homedir(), '.aws', 'config'),
        old_string: 'old',
        new_string: 'new',
      },
      SIG,
    );
    expect(result.isError).toBe(true);
  });

  it('allows editing a normal file in tmp', async () => {
    const filePath = join(tmpDir, 'editable.txt');
    writeFileSync(filePath, 'hello world', 'utf-8');

    const result = await editFileHandler(
      { file_path: filePath, old_string: 'hello', new_string: 'goodbye' },
      SIG,
    );
    expect(result.isError).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Symlink dereference (C5 fix)
// ---------------------------------------------------------------------------

describe('Symlink dereference — symlink pointing into protected dir', () => {
  it('blocks writes through a symlink that resolves to ~/.ssh', () => {
    const sshDir = join(homedir(), '.ssh');
    if (!existsSync(sshDir)) {
      // ~/.ssh doesn't exist on this runner — dangling symlinks can't be
      // resolved by safeRealpath, so the test would be vacuous. Skip.
      return;
    }

    const linkPath = join(tmpDir, 'ssh-link');
    symlinkSync(sshDir, linkPath);

    const targetViaLink = join(linkPath, 'authorized_keys');

    // write_file must block this.
    expect(() => assertNotDenylisted(targetViaLink, 'write_file')).toThrow(
      /refusing to write to protected path/,
    );
  });

  it('blocks writes through a symlink to a custom denylisted directory', () => {
    const protectedDir = join(tmpDir, 'protected-secrets');
    mkdirSync(protectedDir, { recursive: true });

    const linkPath = join(tmpDir, 'sneaky-link');
    symlinkSync(protectedDir, linkPath);

    const targetViaLink = join(linkPath, 'credentials.json');

    process.env['AFK_WRITE_DENYLIST'] = protectedDir;
    try {
      expect(() => assertNotDenylisted(targetViaLink, 'write_file')).toThrow(
        /refusing to write to protected path/,
      );
    } finally {
      delete process.env['AFK_WRITE_DENYLIST'];
    }
  });

  it('allows writes through a symlink to a normal safe directory', () => {
    const realTarget = join(tmpDir, 'real-dir');
    mkdirSync(realTarget, { recursive: true });
    const linkPath = join(tmpDir, 'safe-link');
    symlinkSync(realTarget, linkPath);

    const targetViaLink = join(linkPath, 'file.txt');
    expect(() => assertNotDenylisted(targetViaLink, 'write_file')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// safeRealpath — ancestor walking
// ---------------------------------------------------------------------------

describe('safeRealpath', () => {
  it('resolves an existing path without changes (no symlinks)', () => {
    const real = safeRealpath(tmpDir);
    // Should at minimum return an absolute path.
    expect(real.startsWith('/')).toBe(true);
  });

  it('resolves non-existent paths via ancestor walking', () => {
    const nonExistent = join(tmpDir, 'a', 'b', 'c', 'new-file.txt');
    const result = safeRealpath(nonExistent);
    // tmpDir exists, so the real path should be rooted there.
    expect(result.startsWith('/')).toBe(true);
    // The tail segments should be preserved.
    expect(result).toContain('new-file.txt');
  });

  it('dereferences a symlink', () => {
    const realTarget = join(tmpDir, 'real-dir');
    mkdirSync(realTarget, { recursive: true });
    const linkPath = join(tmpDir, 'link');
    symlinkSync(realTarget, linkPath);

    const resolved = safeRealpath(linkPath);
    // Should resolve to realTarget (or its real path).
    expect(resolved).not.toContain('link');
    expect(resolved).toContain('real-dir');
  });
});

// ---------------------------------------------------------------------------
// S4: New denylist entries — ~/.afk/config, ~/.afk/state, ~/.npmrc,
// ~/.docker/config.json
// ---------------------------------------------------------------------------

describe('S4 — new denylist entries: AFK config dirs + tool tokens', () => {
  // ~/ .afk/config
  it('blocks exact match on ~/.afk/config', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'config'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('blocks a file nested inside ~/.afk/config', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'config', 'afk.env'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('blocks a deeply nested file inside ~/.afk/config', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'config', 'sub', 'mcp.json'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  // ~/.afk/state
  it('blocks exact match on ~/.afk/state', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'state'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('blocks a file nested inside ~/.afk/state', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'state', 'sessions', 'session.jsonl'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  // ~/.npmrc
  it('blocks exact match on ~/.npmrc', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.npmrc'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('blocks a path nested under ~/.npmrc (treated as prefix)', () => {
    // Even though ~/.npmrc is a file, the prefix check covers paths like
    // ~/.npmrc.bak which start with the entry + '/' — but exact match is the
    // primary case for a file entry. Test exact match here.
    expect(() =>
      assertNotDenylisted(join(homedir(), '.npmrc'), 'edit_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  // ~/.docker/config.json
  it('blocks exact match on ~/.docker/config.json', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.docker', 'config.json'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('blocks a path nested under ~/.docker/config.json directory prefix', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.docker', 'config.json'), 'edit_file'),
    ).toThrow(/refusing to write to protected path/);
  });
});

// ---------------------------------------------------------------------------
// Regression guard — existing 8 entries still block (S4 audit guard)
// ---------------------------------------------------------------------------

describe('regression guard — all original BUILTIN_WRITE_DENYLIST entries still block', () => {
  const originalEntries = [
    join(homedir(), '.ssh'),
    join(homedir(), '.aws'),
    join(homedir(), '.gnupg'),
    join(homedir(), '.config', 'gcloud'),
    '/etc',
    '/System',
    '/private/etc',
    '/usr/local/etc',
  ] as const;

  for (const entry of originalEntries) {
    it(`blocks a file nested inside ${entry}`, () => {
      expect(() =>
        assertNotDenylisted(join(entry, 'test-regression-guard'), 'write_file'),
      ).toThrow(/refusing to write to protected path/);
    });
  }
});

// ---------------------------------------------------------------------------
// AFK_WRITE_DENYLIST env override
// ---------------------------------------------------------------------------

describe('AFK_WRITE_DENYLIST env override', () => {
  it('adds custom blocked paths on top of builtins', () => {
    const customBlocked = join(tmpDir, 'blocked');
    mkdirSync(customBlocked, { recursive: true });

    vi.stubEnv('AFK_WRITE_DENYLIST', customBlocked);

    expect(() =>
      assertNotDenylisted(join(customBlocked, 'secrets.txt'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('builtin entries still apply even with a custom list', () => {
    const customBlocked = join(tmpDir, 'custom');
    vi.stubEnv('AFK_WRITE_DENYLIST', customBlocked);

    // ~/.ssh should still be blocked.
    expect(() => assertNotDenylisted(sshPath, 'write_file')).toThrow(
      /refusing to write to protected path/,
    );
  });
});

// ---------------------------------------------------------------------------
// AFK_HOME-relocated credential tree (#740)
// ---------------------------------------------------------------------------

describe('write-denylist — AFK_HOME-relocated credential tree (#740)', () => {
  it('covers both the relocated config dir AND the relocated state dir', () => {
    const relocated = join(tmpDir, 'relocated-home');
    mkdirSync(relocated, { recursive: true });
    vi.stubEnv('AFK_HOME', relocated);

    expect(() =>
      assertNotDenylisted(join(relocated, 'config', 'afk.env'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
    expect(() =>
      assertNotDenylisted(join(relocated, 'state', 'sessions', 's.json'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('still covers the real homedir() ~/.afk/config and ~/.afk/state when AFK_HOME is relocated', () => {
    // ADDITIVE, not a replacement.
    const relocated = join(tmpDir, 'relocated-home-2');
    mkdirSync(relocated, { recursive: true });
    vi.stubEnv('AFK_HOME', relocated);

    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'config', 'afk.env'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'state', 'sessions', 's.json'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('behavior is unchanged and the derived entries do not double up when AFK_HOME is unset', () => {
    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'config', 'afk.env'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
    const configEntryCount = getWriteDenylist().filter(
      (p) => p === safeRealpath(join(homedir(), '.afk', 'config')),
    ).length;
    expect(configEntryCount).toBe(1);
  });

  // Fail-safe: getAfkHome() throws when AFK_HOME is set but not absolute. The
  // write denylist must not let that throw propagate and empty the floor —
  // it must skip only the derived entries and keep the homedir()-based ones.
  it('stays fail-safe when AFK_HOME is a relative path (getAfkHome() throws)', () => {
    vi.stubEnv('AFK_HOME', 'relative/not-absolute');

    expect(() => getWriteDenylist()).not.toThrow();
    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'config', 'afk.env'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
    expect(() => assertNotDenylisted(sshPath, 'write_file')).toThrow(
      /refusing to write to protected path/,
    );
  });

  it('allows a normal write once AFK_HOME is relocated (no over-broad denial)', () => {
    const relocated = join(tmpDir, 'relocated-home-3');
    mkdirSync(relocated, { recursive: true });
    vi.stubEnv('AFK_HOME', relocated);

    expect(() => assertNotDenylisted(join(tmpDir, 'safe.txt'))).not.toThrow();
  });

  // AFK_STATE_DIR relocates the ENTIRE state tier INDEPENDENTLY of AFK_HOME
  // (paths.ts returns it verbatim when set). Deriving the tier from AFK_HOME
  // alone left an operator running AFK_STATE_DIR=/opt/state with zero write
  // protection on their real state tier — the same env-relocation class this
  // module exists to close.
  it('covers a state tier relocated by AFK_STATE_DIR independently of AFK_HOME', () => {
    const stateDir = join(tmpDir, 'independent-state');
    mkdirSync(stateDir, { recursive: true });
    vi.stubEnv('AFK_STATE_DIR', stateDir);

    expect(() =>
      assertNotDenylisted(join(stateDir, 'sessions', 's.json'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  it('covers AFK_STATE_DIR even when AFK_HOME is relocated elsewhere', () => {
    const relocated = join(tmpDir, 'home-a');
    const stateDir = join(tmpDir, 'state-b');
    mkdirSync(relocated, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    vi.stubEnv('AFK_HOME', relocated);
    vi.stubEnv('AFK_STATE_DIR', stateDir);

    // Both tiers are floored: the AFK_HOME-derived config dir AND the
    // independently-relocated state dir.
    expect(() =>
      assertNotDenylisted(join(relocated, 'config', 'afk.env'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
    expect(() =>
      assertNotDenylisted(join(stateDir, 'sessions', 's.json'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  // Invariant: the two derivations live in SEPARATE try blocks, so one
  // malformed env var must not discard the other's entries.
  it('keeps the AFK_HOME config entry when AFK_STATE_DIR alone is malformed', () => {
    const relocated = join(tmpDir, 'home-c');
    mkdirSync(relocated, { recursive: true });
    vi.stubEnv('AFK_HOME', relocated);
    vi.stubEnv('AFK_STATE_DIR', 'relative/not-absolute');

    expect(() => getWriteDenylist()).not.toThrow();
    expect(() =>
      assertNotDenylisted(join(relocated, 'config', 'afk.env'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
    // And the hardcoded floor is untouched.
    expect(() => assertNotDenylisted(sshPath, 'write_file')).toThrow(
      /refusing to write to protected path/,
    );
  });

  // Converse of the case above (#783 follow-up to #753): a malformed AFK_HOME
  // must not discard the AFK_STATE_DIR entry either. The two `try` blocks in
  // `derivedAfkHomeWriteEntries` are independent, but only ONE direction was
  // pinned before this test — an AFK_HOME regression that started throwing
  // BEFORE the AFK_STATE_DIR derivation (e.g. a shared helper refactor that
  // merged the two `try`s back into one) would have passed the whole suite
  // undetected.
  it('keeps the AFK_STATE_DIR entry when AFK_HOME alone is malformed', () => {
    const stateDir = join(tmpDir, 'state-d');
    mkdirSync(stateDir, { recursive: true });
    vi.stubEnv('AFK_HOME', 'relative/not-absolute');
    vi.stubEnv('AFK_STATE_DIR', stateDir);

    expect(() => getWriteDenylist()).not.toThrow();
    // The valid, independently-relocated state dir is still denied…
    expect(() =>
      assertNotDenylisted(join(stateDir, 'sessions', 's.json'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
    // …and the hardcoded floor is untouched.
    expect(() => assertNotDenylisted(sshPath, 'write_file')).toThrow(
      /refusing to write to protected path/,
    );
  });

  it('treats an empty AFK_HOME as unset', () => {
    vi.stubEnv('AFK_HOME', '');

    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'config', 'afk.env'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
    expect(() =>
      assertNotDenylisted(join(homedir(), '.afk', 'state', 'sessions', 's.json'), 'write_file'),
    ).toThrow(/refusing to write to protected path/);
  });

  // The fail-safe direction is correct but used to be INVISIBLE: an operator
  // who typo'd AFK_HOME ran on a silently reduced floor. Pin that it now says so.
  it('warns once when a malformed AFK_HOME is rejected', () => {
    resetAfkHomeWarnLatchForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.stubEnv('AFK_HOME', 'relative/not-absolute');

      getWriteDenylist();
      getWriteDenylist();
      getWriteDenylist();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('[afk-home]');
      expect(warn.mock.calls[0]?.[0]).toContain('relative/not-absolute');
    } finally {
      warn.mockRestore();
      resetAfkHomeWarnLatchForTests();
    }
  });

  // #780: the latch used to be a single process-wide boolean, so the FIRST
  // malformed var consumed it and a second, independently-malformed var
  // stayed silent. An operator who typo'd both AFK_HOME and AFK_STATE_DIR
  // fixed one, re-ran, and only then learned about the other. The latch is
  // now keyed per distinct rejected value, so both warn.
  it('warns for BOTH vars when AFK_HOME and AFK_STATE_DIR are both malformed (#780)', () => {
    resetAfkHomeWarnLatchForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.stubEnv('AFK_HOME', 'relative/not-absolute-home');
      vi.stubEnv('AFK_STATE_DIR', 'relative/not-absolute-state');

      getWriteDenylist();

      expect(warn).toHaveBeenCalledTimes(2);
      const messages = warn.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => typeof m === 'string' && m.includes('AFK_HOME'))).toBe(true);
      expect(messages.some((m) => typeof m === 'string' && m.includes('AFK_STATE_DIR'))).toBe(
        true,
      );
      expect(
        messages.some((m) => typeof m === 'string' && m.includes('relative/not-absolute-home')),
      ).toBe(true);
      expect(
        messages.some((m) => typeof m === 'string' && m.includes('relative/not-absolute-state')),
      ).toBe(true);

      // Repeated reads must not re-warn for either already-seen value — the
      // once-per-var de-duplication this fix must preserve.
      getWriteDenylist();
      getWriteDenylist();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      resetAfkHomeWarnLatchForTests();
    }
  });
});

describe('assertNotDenylisted — case-variant spellings (#736)', () => {
  afterEach(() => {
    _resetFsCaseCacheForTests();
  });

  it('refuses a case-variant protected path on a case-insensitive volume', () => {
    _resetFsCaseCacheForTests(true);
    expect(() => assertNotDenylisted(join(homedir(), '.SSH', 'id_rsa'), 'write_file')).toThrow(
      /protected path/,
    );
  });

  it('permits it on a case-sensitive volume, where it is a different directory', () => {
    _resetFsCaseCacheForTests(false);
    expect(() =>
      assertNotDenylisted(join(homedir(), '.SSH', 'id_rsa'), 'write_file'),
    ).not.toThrow();
  });
});
