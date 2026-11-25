/**
 * Characterization (golden / equivalence) tests for the shared sensitive-root
 * candidate derivation (#3847, sensitive-root derivation slice).
 *
 * Purpose:
 *   These tests pin the **current output** of `deriveRestrictedSubstrings` and
 *   `headlessRestrictedSubstrings` BEFORE `buildSensitiveRootCandidates` is
 *   wired in. They must pass identically before and after the refactor; any
 *   divergence indicates a behaviour change that must be investigated before
 *   merging.
 *
 * Invariant (load-bearing — do not weaken):
 *   - Every path present in the pre-refactor candidate set must appear in the
 *     post-refactor set.
 *   - No new paths may be added.
 *   - The interactive grant-filter and headless unfiltered semantics must be
 *     preserved exactly.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';

import { deriveRestrictedSubstrings, builtinBashSensitiveRoots } from './bash-restriction-hook.js';
import { buildSensitiveRootCandidates } from './bash-restriction-hook.policy.js';
import { _resetReadDenylistCacheForTests, getReadDenylist, parseReadDenylistEntries } from '../handlers/read-denylist.js';
import { safeRealpath } from '../handlers/write-denylist.js';
import { resetAfkHomeWarnLatchForTests } from '../afk-home-warn.js';

const HOME = homedir();

afterEach(() => {
  _resetReadDenylistCacheForTests();
  resetAfkHomeWarnLatchForTests();
  delete process.env['AFK_READ_DENYLIST'];
});

// ---------------------------------------------------------------------------
// Helper: narrow grants (cwd rooted at /tmp/repo — does NOT cover any
// credential root, so ALL candidates survive the grant filter)
// ---------------------------------------------------------------------------

function narrowGrants() {
  const base = resolve('/tmp/repo');
  return { resolveBase: base, readRoots: [base], writeRoots: [base] };
}

// ---------------------------------------------------------------------------
// 1. buildSensitiveRootCandidates() output mirrors the pre-refactor inlined
//    sets from both deriveRestrictedSubstrings and headlessRestrictedSubstrings
// ---------------------------------------------------------------------------

describe('buildSensitiveRootCandidates: mirrors pre-refactor inlined candidate assembly', () => {
  it('contains every builtinBashSensitiveRoot', () => {
    const candidates = buildSensitiveRootCandidates();
    for (const root of builtinBashSensitiveRoots()) {
      expect(candidates).toContain(root);
    }
  });

  it('contains ~/.ssh (via BUILTIN_READ_DENYLIST / getReadDenylist)', () => {
    const candidates = buildSensitiveRootCandidates();
    const sshRoot = join(HOME, '.ssh');
    expect(candidates.some((c) => c === sshRoot || c.startsWith(sshRoot))).toBe(true);
  });

  it('contains ~/.aws', () => {
    const candidates = buildSensitiveRootCandidates();
    expect(candidates.some((c) => c.includes('.aws'))).toBe(true);
  });

  it('contains ~/.afk/config', () => {
    const candidates = buildSensitiveRootCandidates();
    expect(candidates.some((c) => c.includes('.afk') && c.includes('config'))).toBe(true);
  });

  it('contains ~/Library/Application Support (bash-only extra)', () => {
    const candidates = buildSensitiveRootCandidates();
    expect(candidates.some((c) => c.includes('Application Support'))).toBe(true);
  });

  it('contains ~/Library/LaunchAgents (bash-only extra)', () => {
    const candidates = buildSensitiveRootCandidates();
    expect(candidates.some((c) => c.includes('LaunchAgents'))).toBe(true);
  });

  it('returns a deduplicated array (no duplicate entries)', () => {
    const candidates = buildSensitiveRootCandidates();
    expect(candidates.length).toBe(new Set(candidates).size);
  });

  it('returns a non-empty array', () => {
    expect(buildSensitiveRootCandidates().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. deriveRestrictedSubstrings (interactive) uses the same candidate set
//    — with narrow grants, the grant filter drops nothing, so the output of
//      deriveRestrictedSubstrings equals the candidates.
// ---------------------------------------------------------------------------

describe('deriveRestrictedSubstrings (narrow grants) == buildSensitiveRootCandidates', () => {
  it('every candidate survives the grant filter under narrow grants', () => {
    const candidates = buildSensitiveRootCandidates();
    const filtered = deriveRestrictedSubstrings(narrowGrants());
    // Every candidate must appear in the filtered set when no grant covers it.
    // (Some candidates may appear in multiple spellings after grant-filter;
    // we check containment not set-equality.)
    for (const c of candidates) {
      expect(filtered).toContain(c);
    }
  });

  it('filtered set is non-empty under narrow grants', () => {
    expect(deriveRestrictedSubstrings(narrowGrants()).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Grant-filter semantics: home-anchored grants drop home-relative credential
//    roots from the interactive set (Option A, #740).
// ---------------------------------------------------------------------------

describe('deriveRestrictedSubstrings grant-filter semantics preserved', () => {
  const homeGrants = {
    resolveBase: HOME,
    readRoots: [HOME],
    writeRoots: [HOME],
  };

  it('drops ~/.ssh when resolveBase=HOME (home covers the root)', () => {
    const filtered = deriveRestrictedSubstrings(homeGrants);
    const sshRoot = join(HOME, '.ssh');
    // No element should BE or start with sshRoot
    expect(filtered.some((c) => c === sshRoot || c.startsWith(sshRoot + '/'))).toBe(false);
  });

  it('drops ~/.afk/config when resolveBase=HOME', () => {
    const filtered = deriveRestrictedSubstrings(homeGrants);
    expect(filtered.some((c) => c.includes('.afk') && c.includes('config'))).toBe(false);
  });

  it('keeps /etc/shadow even with home-anchored grants (outside home)', () => {
    const filtered = deriveRestrictedSubstrings(homeGrants);
    expect(filtered.some((c) => c.includes('shadow') || c.includes('sudoers'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. headlessRestrictedSubstrings == buildSensitiveRootCandidates
//    (headless applies NO grant filter — full candidate set, always)
//
//    We test this indirectly: the hook with nonInteractive=true blocks every
//    builtin credential root regardless of a home-anchored grant manager. This
//    is already pinned by check2-policy.test.ts; here we test the derivation
//    side directly by confirming the unfiltered set equals the candidates.
// ---------------------------------------------------------------------------

describe('headless floor (no grant filter) == buildSensitiveRootCandidates', () => {
  it('buildSensitiveRootCandidates covers every builtinBashSensitiveRoot unconditionally', () => {
    // On headless surfaces headlessRestrictedSubstrings() returns exactly
    // buildSensitiveRootCandidates() — no grant filter applied. We verify the
    // shape via builtinBashSensitiveRoots(), which is a subset.
    const candidates = buildSensitiveRootCandidates();
    for (const root of builtinBashSensitiveRoots()) {
      expect(candidates).toContain(root);
    }
  });

  it('contains /etc/shadow (absolute, outside home — always blocked on headless)', () => {
    const candidates = buildSensitiveRootCandidates();
    expect(candidates.some((c) => c.includes('/etc/shadow') || c.includes('private/etc/shadow'))).toBe(true);
  });

  it('contains /etc/sudoers (absolute, always blocked on headless)', () => {
    const candidates = buildSensitiveRootCandidates();
    expect(candidates.some((c) => c.includes('/etc/sudoers') || c.includes('private/etc/sudoers'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Stability: repeated calls return the same set (deterministic, no drift)
// ---------------------------------------------------------------------------

describe('buildSensitiveRootCandidates stability', () => {
  it('two consecutive calls return identical arrays', () => {
    const a = buildSensitiveRootCandidates();
    const b = buildSensitiveRootCandidates();
    expect(a).toEqual(b);
  });

  it('deriveRestrictedSubstrings is stable across calls with identical grants', () => {
    const grants = narrowGrants();
    const a = deriveRestrictedSubstrings(grants);
    const b = deriveRestrictedSubstrings(grants);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// 6. AFK_READ_DENYLIST dual-spelling contract
//    When AFK_READ_DENYLIST is set, buildSensitiveRootCandidates() must include
//    BOTH the as-spelled expanded form (from parseReadDenylistEntries) AND the
//    resolved form (from getReadDenylist), so bash commands that name symlinks
//    rather than their real paths are still blocked.
// ---------------------------------------------------------------------------

describe('AFK_READ_DENYLIST dual-spelling contract through buildSensitiveRootCandidates', () => {
  it('includes the as-spelled expanded form from parseReadDenylistEntries', () => {
    process.env['AFK_READ_DENYLIST'] = '~/sensitive-custom';
    _resetReadDenylistCacheForTests();
    const candidates = buildSensitiveRootCandidates();
    const asSpelled = parseReadDenylistEntries(process.env['AFK_READ_DENYLIST']);
    // parseReadDenylistEntries expands leading ~ → HOME; the result must appear
    // in candidates so bash commands that use the as-spelled path are blocked.
    const expected = join(HOME, 'sensitive-custom');
    expect(asSpelled).toContain(expected);
    expect(candidates).toContain(expected);
  });

  it('includes the resolved form (at least one element ends with sensitive-custom)', () => {
    process.env['AFK_READ_DENYLIST'] = '~/sensitive-custom';
    _resetReadDenylistCacheForTests();
    const candidates = buildSensitiveRootCandidates();
    // getReadDenylist() returns symlink-resolved paths; on most systems
    // ~/sensitive-custom resolves to the same expanded path, but we check
    // by suffix to be filesystem-agnostic.
    expect(candidates.some((c) => c.endsWith('sensitive-custom'))).toBe(true);
  });

  it('getReadDenylist includes the entry when AFK_READ_DENYLIST is set', () => {
    process.env['AFK_READ_DENYLIST'] = '~/sensitive-custom';
    _resetReadDenylistCacheForTests();
    const denylist = getReadDenylist();
    expect(denylist.some((c) => c.endsWith('sensitive-custom'))).toBe(true);
  });

  it('symlink fixture: candidates contains BOTH as-spelled symlink path (source 3) AND resolved real dir (source 2)', () => {
    // This test exercises the exact regression vector from PR #734:
    // when AFK_READ_DENYLIST names a symlink, the resolved real path must
    // also appear in candidates — otherwise a bash command that navigates
    // through the real path bypasses the block.
    const realDir = fs.mkdtempSync(join(tmpdir(), 'afk-denylist-real-'));
    const spelledPath = join(tmpdir(), `afk-denylist-symlink-${Date.now()}`);
    fs.symlinkSync(realDir, spelledPath);
    try {
      vi.stubEnv('AFK_READ_DENYLIST', spelledPath);
      _resetReadDenylistCacheForTests();
      const candidates = buildSensitiveRootCandidates();
      // Source 3 (as-spelled via parseReadDenylistEntries): the symlink path itself
      expect(candidates).toContain(spelledPath);
      // Source 2 (resolved via getReadDenylist): the real directory the symlink points to.
      // Use safeRealpath to match how resolveLists() canonicalises the entry
      // (on macOS /tmp is a symlink to /private/tmp, so realDir and its
      // safeRealpath form differ — the candidates list holds the canonical form).
      expect(candidates).toContain(safeRealpath(realDir));
    } finally {
      vi.unstubAllEnvs();
      fs.unlinkSync(spelledPath);
      fs.rmdirSync(realDir);
    }
  });
});
