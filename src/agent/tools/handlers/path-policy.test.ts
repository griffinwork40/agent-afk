/**
 * Tests for the single resolve-then-decide policy point (#3847).
 *
 * Covers:
 *  - Credential-store paths produce `{ kind: 'deny' }` for reads and writes.
 *  - Scoped actor-root and precedence cases live in path-policy.scope.test.ts.
 *  - Non-secret paths produce `{ kind: 'allow' }` for reads.
 *  - Carve-out paths (mcp.json, schedules.json, .ssh/config, .ssh/known_hosts)
 *    produce `{ kind: 'allow' }` for reads.
 *  - Symlink bypass is blocked when the target dir exists (guarded skip otherwise,
 *    matching the pattern in read-denylist.test.ts — the authoritative symlink
 *    dereference test suite uses AFK_READ_DENYLIST fixtures for portability).
 *  - `decidePathAccess` produces the same verdict as the former direct
 *    `isReadDenied(resolve(p))` call for every case above (equivalence proof).
 *
 * @module agent/tools/handlers/path-policy.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { decidePathAccess } from './path-policy.js';
import { isReadDenied, _resetReadDenylistCacheForTests } from './read-denylist.js';
import { safeRealpath } from './write-denylist.js';

const HOME = homedir();

beforeEach(() => {
  _resetReadDenylistCacheForTests();
});
afterEach(() => {
  _resetReadDenylistCacheForTests();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Reference verdict from the former direct `isReadDenied(resolve(p))` call —
 *  used for equivalence proofs below. This is exactly what `resolveAndContain`
 *  and `path-approval-hook` called before #3847. */
function legacyVerdict(p: string): 'allow' | 'deny' {
  return isReadDenied(resolve(p)).denied ? 'deny' : 'allow';
}

function policyVerdict(p: string, op: 'read' | 'write' = 'read'): 'allow' | 'deny' {
  return decidePathAccess(p, op).kind;
}

// ─── Credential-store paths: deny on read ────────────────────────────────────

describe('decidePathAccess — credential stores denied for reads', () => {
  const credPaths = [
    join(HOME, '.ssh', 'id_rsa'),
    join(HOME, '.ssh', 'id_ed25519'),
    join(HOME, '.aws', 'credentials'),
    join(HOME, '.gnupg', 'secring.gpg'),
    join(HOME, '.afk', 'config', 'afk.env'),
    join(HOME, '.npmrc'),
    join(HOME, '.docker', 'config.json'),
    join(HOME, '.git-credentials'),
    join(HOME, '.netrc'),
    join(HOME, '.config', 'gh', 'hosts.yml'),
    join(HOME, '.kube', 'config'),
    '/etc/shadow',
    '/etc/sudoers',
  ];

  for (const p of credPaths) {
    it(`denies read of ${p}`, () => {
      expect(policyVerdict(p, 'read')).toBe('deny');
    });

    it(`matches isReadDenied verdict for ${p}`, () => {
      // Equivalence proof: same result as the direct isReadDenied(resolve(p))
      // call that resolveAndContain / path-approval-hook used before #3847.
      expect(policyVerdict(p, 'read')).toBe(legacyVerdict(p));
    });
  }
});

// ─── Credential-store paths: write axis is NOT gated here ────────────────────

describe('decidePathAccess — write floor', () => {
  it('denies write of ~/.ssh/id_rsa', () => {
    expect(policyVerdict(join(HOME, '.ssh', 'id_rsa'), 'write')).toBe('deny');
  });

  it('denies write of ~/.afk/config/afk.env', () => {
    expect(policyVerdict(join(HOME, '.afk', 'config', 'afk.env'), 'write')).toBe('deny');
  });
});

// ─── Non-secret paths: allow ─────────────────────────────────────────────────

describe('decidePathAccess — non-secret paths allowed for reads', () => {
  const allowPaths = [
    join(HOME, 'Documents', 'notes.txt'),
    join(HOME, '.afk', 'state', 'todos', 'todo.json'),
    '/etc/hosts',
    '/tmp/scratch.txt',
  ];

  for (const p of allowPaths) {
    it(`allows read of ${p}`, () => {
      expect(policyVerdict(p, 'read')).toBe('allow');
    });

    it(`matches isReadDenied verdict for ${p}`, () => {
      expect(policyVerdict(p, 'read')).toBe(legacyVerdict(p));
    });
  }
});

// ─── Carve-out paths: allow ───────────────────────────────────────────────────

describe('decidePathAccess — built-in carve-outs allowed for reads', () => {
  const carveOuts = [
    join(HOME, '.afk', 'config', 'mcp.json'),
    join(HOME, '.afk', 'config', 'schedules.json'),
    join(HOME, '.ssh', 'config'),
    join(HOME, '.ssh', 'known_hosts'),
  ];

  for (const p of carveOuts) {
    it(`allows read of ${p}`, () => {
      expect(policyVerdict(p, 'read')).toBe('allow');
    });

    it(`matches isReadDenied verdict for ${p}`, () => {
      expect(policyVerdict(p, 'read')).toBe(legacyVerdict(p));
    });
  }
});

// ─── Symlink bypass blocked (guarded — requires the target dir to exist) ─────

describe('decidePathAccess — symlink bypass is blocked', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = safeRealpath(mkdtempSync(join(tmpdir(), 'afk-path-policy-')));
    mkdirSync(join(tmpDir, 'workspace'));
    writeFileSync(join(tmpDir, 'workspace', 'file.txt'), 'safe');
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('denies a symlink pointing into an existing denied dir (~/.ssh)', () => {
    // Guard: skip when ~/.ssh does not exist (CI / synthetic test home).
    // The authoritative portable symlink test lives in read-denylist.test.ts
    // (uses AFK_READ_DENYLIST to create a real denied fixture). This test
    // exercises the same code path against a real builtin entry when available.
    const sshDir = join(HOME, '.ssh');
    if (!existsSync(sshDir)) return;

    const link = join(tmpDir, 'workspace', 'escape.link');
    symlinkSync(sshDir, link);

    expect(policyVerdict(link, 'read')).toBe('deny');
    // Equivalence: same verdict as legacy isReadDenied(resolve(p)).
    expect(policyVerdict(link, 'read')).toBe(legacyVerdict(link));
  });

  it('allows a real (non-symlink) file inside workspace', () => {
    const safe = join(tmpDir, 'workspace', 'file.txt');
    expect(policyVerdict(safe, 'read')).toBe('allow');
    expect(policyVerdict(safe, 'read')).toBe(legacyVerdict(safe));
  });
});

// ─── `matched` field ─────────────────────────────────────────────────────────

describe('decidePathAccess — deny result carries matched/canonical entry', () => {
  it('matched and canonical are set for a credential path', () => {
    const result = decidePathAccess(join(HOME, '.ssh', 'id_rsa'), 'read');
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny' && result.reason === 'credential') {
      expect(typeof result.matched).toBe('string');
      expect(result.matched.length).toBeGreaterThan(0);
      expect(typeof result.canonical).toBe('string');
      expect(result.canonical.length).toBeGreaterThan(0);
    }
  });

  it('roots deny result has no matched field', () => {
    // Roots deny variant deliberately omits `matched` — its semantics were
    // divergent (it held the candidate path itself, not a denylist entry).
    // Use `roots` instead.
    // We need a scoped call to reach a roots deny.
    const result = decidePathAccess(join(HOME, 'outside'), 'read', {
      resolveBase: HOME,
      readRoots: [join(HOME, 'inner')],
      writeRoots: [join(HOME, 'inner')],
    });
    expect(result.kind).toBe('deny');
    if (result.kind === 'deny' && result.reason === 'roots') {
      expect('matched' in result).toBe(false);
      expect(Array.isArray(result.roots)).toBe(true);
    }
  });

  it('allow result has no matched field', () => {
    const result = decidePathAccess(join(HOME, 'Documents', 'safe.txt'), 'read');
    expect(result.kind).toBe('allow');
    expect('matched' in result).toBe(false);
  });
});
