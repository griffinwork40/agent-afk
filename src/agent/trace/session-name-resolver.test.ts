/**
 * Tests for session-name-resolver.ts
 *
 * Uses real temp directories for isolation — no mocking of fs calls.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSessionByName } from './session-name-resolver.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function writeSidecar(
  id: string,
  data: Record<string, unknown>,
): void {
  writeFileSync(join(tmpDir, `${id}.json`), JSON.stringify(data), 'utf-8');
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `snr-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic resolution (existing functionality)
// ---------------------------------------------------------------------------

describe('exact-id resolution', () => {
  it('resolves when idOrName matches the sidecar filename id', () => {
    const sidecarId = 'abc-123';
    const sessionId = 'sdk-session-xyz';
    writeSidecar(sidecarId, { sessionId, name: 'my-session', savedAt: 1000 });

    const result = resolveSessionByName(sidecarId, tmpDir);
    expect(result).toEqual({ sessionId, sidecarId, reason: 'exact-id' });
  });

  it('uses sidecarId as sessionId when sessionId field is absent', () => {
    const sidecarId = 'no-session-id';
    writeSidecar(sidecarId, { name: 'foo', savedAt: 1000 });

    const result = resolveSessionByName(sidecarId, tmpDir);
    expect(result).toEqual({ sessionId: sidecarId, sidecarId, reason: 'exact-id' });
  });
});

describe('exact-session-id resolution', () => {
  it('resolves when idOrName matches the .sessionId field', () => {
    const sidecarId = 'file-id-001';
    const sessionId = 'sdk-exact-match';
    writeSidecar(sidecarId, { sessionId, name: 'other-name', savedAt: 2000 });

    const result = resolveSessionByName(sessionId, tmpDir);
    expect(result).toEqual({ sessionId, sidecarId, reason: 'exact-session-id' });
  });
});

describe('exact-name resolution', () => {
  it('resolves when idOrName matches the .name field', () => {
    const sidecarId = 'file-id-002';
    const sessionId = 'sdk-002';
    const name = 'my-named-session';
    writeSidecar(sidecarId, { sessionId, name, savedAt: 3000 });

    const result = resolveSessionByName(name, tmpDir);
    expect(result).toEqual({ sessionId, sidecarId, reason: 'exact-name' });
  });

  it('uses sidecarId as sessionId when sessionId field is absent (exact-name)', () => {
    const sidecarId = 'file-no-sid';
    const name = 'session-without-sdk-id';
    writeSidecar(sidecarId, { name, savedAt: 500 });

    const result = resolveSessionByName(name, tmpDir);
    expect(result).toEqual({ sessionId: sidecarId, sidecarId, reason: 'exact-name' });
  });
});

describe('prefix-name resolution', () => {
  it('resolves a unique name prefix (>= 3 chars)', () => {
    const sidecarId = 'prefix-session';
    const sessionId = 'sdk-prefix';
    writeSidecar(sidecarId, { sessionId, name: 'unique-prefix-session', savedAt: 1000 });

    const result = resolveSessionByName('unique-p', tmpDir);
    expect(result).toEqual({ sessionId, sidecarId, reason: 'prefix-name' });
  });

  it('returns undefined when prefix matches multiple sessions', () => {
    writeSidecar('s1', { sessionId: 'sdk-s1', name: 'shared-prefix-alpha', savedAt: 1000 });
    writeSidecar('s2', { sessionId: 'sdk-s2', name: 'shared-prefix-beta', savedAt: 2000 });

    const result = resolveSessionByName('shared-p', tmpDir);
    expect(result).toBeUndefined();
  });

  it('does not prefix-match when query is fewer than 3 chars', () => {
    writeSidecar('short', { sessionId: 'sdk-short', name: 'ab-something', savedAt: 1000 });

    const result = resolveSessionByName('ab', tmpDir);
    expect(result).toBeUndefined();
  });
});

describe('no match', () => {
  it('returns undefined when directory is empty', () => {
    expect(resolveSessionByName('anything', tmpDir)).toBeUndefined();
  });

  it('returns undefined when no sidecar matches the query', () => {
    writeSidecar('some-id', { sessionId: 'sdk-some', name: 'some-name', savedAt: 1000 });

    expect(resolveSessionByName('nonexistent', tmpDir)).toBeUndefined();
  });

  it('returns undefined when sessionsDir does not exist', () => {
    const absent = join(tmpDir, 'does-not-exist');
    expect(resolveSessionByName('foo', absent)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NEW: duplicate name — newest savedAt wins
// ---------------------------------------------------------------------------

describe('duplicate name — newest savedAt wins', () => {
  it('returns the session with the higher savedAt when two share the same name', () => {
    const newerSidecarId = 'newer-session';
    const newerSessionId = 'sdk-newer';
    const olderSidecarId = 'older-session';
    const olderSessionId = 'sdk-older';
    const sharedName = 'duplicate-name';

    writeSidecar(olderSidecarId, { sessionId: olderSessionId, name: sharedName, savedAt: 1000 });
    writeSidecar(newerSidecarId, { sessionId: newerSessionId, name: sharedName, savedAt: 9000 });

    const result = resolveSessionByName(sharedName, tmpDir);
    expect(result).toEqual({
      sessionId: newerSessionId,
      sidecarId: newerSidecarId,
      reason: 'exact-name',
    });
  });

  it('returns the session with the higher savedAt when three share the same name', () => {
    writeSidecar('s1', { sessionId: 'sdk-s1', name: 'triple-dupe', savedAt: 100 });
    writeSidecar('s2', { sessionId: 'sdk-s2', name: 'triple-dupe', savedAt: 500 });
    writeSidecar('s3', { sessionId: 'sdk-s3', name: 'triple-dupe', savedAt: 300 });

    const result = resolveSessionByName('triple-dupe', tmpDir);
    expect(result).toMatchObject({ sessionId: 'sdk-s2', reason: 'exact-name' });
  });

  it('sort order does not depend on directory listing order (lexicographic ids)', () => {
    // Write in an order where the lexicographically-first file id has the OLDER savedAt
    writeSidecar('aaa-old', { sessionId: 'sdk-aaa', name: 'same-name', savedAt: 100 });
    writeSidecar('zzz-new', { sessionId: 'sdk-zzz', name: 'same-name', savedAt: 9999 });

    const result = resolveSessionByName('same-name', tmpDir);
    expect(result).toMatchObject({ sessionId: 'sdk-zzz', reason: 'exact-name' });
  });
});

// ---------------------------------------------------------------------------
// Edge case: missing savedAt sorts last
// ---------------------------------------------------------------------------

describe('missing savedAt sorts last', () => {
  it('prefers a session with savedAt over one without, even if listed first', () => {
    // The session with no savedAt is named such that it would sort first lexicographically
    writeSidecar('aaa-no-savedat', { sessionId: 'sdk-no-ts', name: 'contested-name' });
    writeSidecar('zzz-has-savedat', { sessionId: 'sdk-has-ts', name: 'contested-name', savedAt: 1 });

    const result = resolveSessionByName('contested-name', tmpDir);
    // sdk-has-ts has savedAt=1 which beats -Infinity, so it wins
    expect(result).toMatchObject({ sessionId: 'sdk-has-ts', reason: 'exact-name' });
  });

  it('two sessions both missing savedAt — still resolves (does not throw)', () => {
    writeSidecar('no-ts-a', { sessionId: 'sdk-a', name: 'no-ts-dupe' });
    writeSidecar('no-ts-b', { sessionId: 'sdk-b', name: 'no-ts-dupe' });

    // Both have -Infinity; stable outcome = some session is returned, not undefined
    const result = resolveSessionByName('no-ts-dupe', tmpDir);
    expect(result).toBeDefined();
    expect(result!.reason).toBe('exact-name');
    expect(['sdk-a', 'sdk-b']).toContain(result!.sessionId);
  });

  it('session with savedAt is always preferred over one without, regardless of ids', () => {
    writeSidecar('zzz-with', { sessionId: 'sdk-with', name: 'mixed', savedAt: 42 });
    writeSidecar('aaa-without', { sessionId: 'sdk-without', name: 'mixed' });

    const result = resolveSessionByName('mixed', tmpDir);
    expect(result).toMatchObject({ sessionId: 'sdk-with' });
  });
});
