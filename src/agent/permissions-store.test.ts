/**
 * Tests for the persisted path-approval grant store
 * (`~/.afk/config/permissions.json`).
 *
 * Coverage:
 *   - Empty/missing file → returns empty
 *   - Corrupt file → returns empty (fail-soft, never throws)
 *   - Append round-trip via temp dir
 *   - ULID format (26 chars, sortable by time)
 *   - Revoke by ID
 *   - `allowedPathsForMode` honors expiresAt
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  allowedPathsForMode,
  appendGrant,
  generateUlid,
  loadPermissionsFile,
  revokeGrantById,
  seedPersistedGrants,
} from './permissions-store.js';

let scratch: string;
let storePath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'afk-permissions-test-'));
  storePath = join(scratch, 'permissions.json');
});

describe('generateUlid', () => {
  it('produces a 26-character string in the Crockford-base32 alphabet', () => {
    const ulid = generateUlid();
    expect(ulid).toHaveLength(26);
    expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('encodes the provided timestamp in the leading 10 chars', () => {
    const t1 = generateUlid(0);
    const t2 = generateUlid(Date.now());
    // Lexicographic comparison on Crockford-base32 = numeric comparison
    // when both have the same length, so t2 > t1.
    expect(t2 > t1).toBe(true);
  });
});

describe('loadPermissionsFile', () => {
  it('returns an empty file when none exists', () => {
    const file = loadPermissionsFile(storePath);
    expect(file).toEqual({ version: 1, grants: [] });
  });

  it('returns an empty file on JSON parse error (fail-soft)', () => {
    writeFileSync(storePath, '{ corrupt', 'utf8');
    expect(loadPermissionsFile(storePath)).toEqual({ version: 1, grants: [] });
  });

  it('returns an empty file when version is wrong', () => {
    writeFileSync(storePath, JSON.stringify({ version: 999, grants: [] }), 'utf8');
    expect(loadPermissionsFile(storePath)).toEqual({ version: 1, grants: [] });
  });

  it('drops invalid grant entries silently', () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        grants: [
          { id: 'a', path: '/x', mode: 'read', decision: 'allow', grantedAt: 'now', source: 'manual' },
          { id: 'b', path: '/y' /* missing mode */ },
          'not-an-object',
        ],
      }),
      'utf8',
    );
    const file = loadPermissionsFile(storePath);
    expect(file.grants).toHaveLength(1);
    expect(file.grants[0]?.path).toBe('/x');
  });
});

describe('appendGrant', () => {
  it('stamps ID + grantedAt and persists atomically', () => {
    const grant = appendGrant(
      {
        path: '/Users/alice/.ssh',
        mode: 'read',
        decision: 'allow',
        source: 'elicit:repl',
        reason: 'test',
      },
      storePath,
    );

    expect(grant.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(grant.grantedAt).toBeDefined();
    expect(existsSync(storePath)).toBe(true);

    // Reload from disk and verify the grant round-trips.
    const reloaded = loadPermissionsFile(storePath);
    expect(reloaded.grants).toHaveLength(1);
    expect(reloaded.grants[0]?.path).toBe('/Users/alice/.ssh');
  });

  it('appends multiple grants in order', () => {
    appendGrant(
      { path: '/a', mode: 'read', decision: 'allow', source: 'manual' },
      storePath,
    );
    appendGrant(
      { path: '/b', mode: 'write', decision: 'allow', source: 'manual' },
      storePath,
    );
    const file = loadPermissionsFile(storePath);
    expect(file.grants.map((g) => g.path)).toEqual(['/a', '/b']);
  });

  it('produces JSON that is human-readable (pretty-printed)', () => {
    appendGrant(
      { path: '/a', mode: 'read', decision: 'allow', source: 'manual' },
      storePath,
    );
    const raw = readFileSync(storePath, 'utf8');
    // Two-space indent + grant body on its own line.
    expect(raw).toContain('"version": 1');
    expect(raw).toContain('"grants":');
    expect(raw).toContain('\n');
  });
});

describe('revokeGrantById', () => {
  it('removes the matching grant and returns true', () => {
    const a = appendGrant({ path: '/a', mode: 'read', decision: 'allow', source: 'manual' }, storePath);
    const b = appendGrant({ path: '/b', mode: 'read', decision: 'allow', source: 'manual' }, storePath);

    expect(revokeGrantById(a.id, storePath)).toBe(true);
    const after = loadPermissionsFile(storePath);
    expect(after.grants.map((g) => g.id)).toEqual([b.id]);
  });

  it('returns false when no record matches', () => {
    appendGrant({ path: '/a', mode: 'read', decision: 'allow', source: 'manual' }, storePath);
    expect(revokeGrantById('NONEXISTENT', storePath)).toBe(false);
  });
});

describe('allowedPathsForMode', () => {
  it('returns paths for the requested mode (read sees both read+write grants)', () => {
    appendGrant({ path: '/r', mode: 'read', decision: 'allow', source: 'manual' }, storePath);
    appendGrant({ path: '/w', mode: 'write', decision: 'allow', source: 'manual' }, storePath);
    expect(allowedPathsForMode('read', storePath).sort()).toEqual(['/r', '/w']);
    expect(allowedPathsForMode('write', storePath)).toEqual(['/w']);
  });

  it('filters out denied grants', () => {
    appendGrant({ path: '/blocked', mode: 'read', decision: 'deny', source: 'manual' }, storePath);
    expect(allowedPathsForMode('read', storePath)).toEqual([]);
  });

  it('respects expiresAt', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    appendGrant({
      path: '/expired',
      mode: 'read',
      decision: 'allow',
      source: 'manual',
      expiresAt: past,
    }, storePath);
    appendGrant({
      path: '/live',
      mode: 'read',
      decision: 'allow',
      source: 'manual',
      expiresAt: future,
    }, storePath);

    expect(allowedPathsForMode('read', storePath)).toEqual(['/live']);
  });
});

describe('seedPersistedGrants', () => {
  it('seeds read + write roots from persisted allow grants (F1 regression)', () => {
    appendGrant({ path: '/r', mode: 'read', decision: 'allow', source: 'manual' }, storePath);
    appendGrant({ path: '/w', mode: 'write', decision: 'allow', source: 'manual' }, storePath);

    const reads: string[] = [];
    const writes: string[] = [];
    seedPersistedGrants(
      { addReadRoot: (p) => reads.push(p), addWriteRoot: (p) => writes.push(p) },
      storePath,
    );

    // read loop sees read+write grants (read ⊆ write); write loop only write grants.
    expect(reads.sort()).toEqual(['/r', '/w']);
    expect(writes).toEqual(['/w']);
  });

  it('is a no-op when the store is empty/absent', () => {
    const reads: string[] = [];
    const writes: string[] = [];
    seedPersistedGrants(
      { addReadRoot: (p) => reads.push(p), addWriteRoot: (p) => writes.push(p) },
      storePath,
    );
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });
});
