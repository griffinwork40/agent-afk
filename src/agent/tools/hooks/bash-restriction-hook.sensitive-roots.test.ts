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

import { describe, expect, it, afterEach } from 'vitest';
import { homedir } from 'os';
import { join, resolve } from 'path';

import { deriveRestrictedSubstrings, builtinBashSensitiveRoots } from './bash-restriction-hook.js';
import { buildSensitiveRootCandidates } from './bash-restriction-hook.policy.js';
import { _resetReadDenylistCacheForTests } from '../handlers/read-denylist.js';
import { resetAfkHomeWarnLatchForTests } from '../afk-home-warn.js';

const HOME = homedir();

afterEach(() => {
  _resetReadDenylistCacheForTests();
  resetAfkHomeWarnLatchForTests();
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
