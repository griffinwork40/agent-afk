/**
 * Unit tests for git-snapshot.exec: credential scrubbing in buildSnapshotEnv
 * and aggregate blob-bytes cap in fetchPriors (via git-snapshot.diff exports).
 *
 * Finding #2 (issue #4469): CREDENTIAL_EXACT must cover connection-string vars
 * (DATABASE_URL, REDIS_URL, MONGODB_URI/URL, SENTRY_DSN) that end in _URL/_URI/_DSN,
 * bypassing CREDENTIAL_SUFFIX_RE, but commonly carry embedded passwords.
 *
 * Finding #11 (issue #4469): an aggregate blob-bytes cap prevents a diff with
 * many under-per-blob-cap files from buffering unbounded data.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSnapshotEnv } from './git-snapshot.exec.js';
import { _setMaxAggregateBlobBytesForTests, _setMaxBlobBytesForTests } from './git-snapshot.diff.js';

// --- #2: credential scrubbing ---

describe('buildSnapshotEnv credential scrubbing', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('strips vars matched by the suffix regex (_KEY, _TOKEN, _SECRET, _PASSWORD, _CREDENTIAL)', () => {
    vi.stubEnv('MY_API_KEY', 'k');
    vi.stubEnv('MY_TOKEN', 't');
    vi.stubEnv('MY_SECRET', 's');
    vi.stubEnv('MY_PASSWORD', 'p');
    vi.stubEnv('MY_CREDENTIAL', 'c');
    const env = buildSnapshotEnv();
    expect(env['MY_API_KEY']).toBeUndefined();
    expect(env['MY_TOKEN']).toBeUndefined();
    expect(env['MY_SECRET']).toBeUndefined();
    expect(env['MY_PASSWORD']).toBeUndefined();
    expect(env['MY_CREDENTIAL']).toBeUndefined();
  });

  it('strips GOOGLE_APPLICATION_CREDENTIALS (exact list: ends in _CREDENTIALS not _CREDENTIAL)', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/path/to/creds.json');
    expect(buildSnapshotEnv()['GOOGLE_APPLICATION_CREDENTIALS']).toBeUndefined();
  });

  it('strips DATABASE_URL (finding #2: _URL suffix bypasses regex but carries embedded password)', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:secret@host/db');
    expect(buildSnapshotEnv()['DATABASE_URL']).toBeUndefined();
  });

  it('strips REDIS_URL', () => {
    vi.stubEnv('REDIS_URL', 'redis://:secret@host:6379');
    expect(buildSnapshotEnv()['REDIS_URL']).toBeUndefined();
  });

  it('strips MONGODB_URI', () => {
    vi.stubEnv('MONGODB_URI', 'mongodb+srv://user:pass@cluster/db');
    expect(buildSnapshotEnv()['MONGODB_URI']).toBeUndefined();
  });

  it('strips MONGODB_URL', () => {
    vi.stubEnv('MONGODB_URL', 'mongodb://user:pass@host/db');
    expect(buildSnapshotEnv()['MONGODB_URL']).toBeUndefined();
  });

  it('strips SENTRY_DSN (_DSN suffix bypasses regex but is a credential-bearing URI)', () => {
    vi.stubEnv('SENTRY_DSN', 'https://key@sentry.io/123');
    expect(buildSnapshotEnv()['SENTRY_DSN']).toBeUndefined();
  });

  it('strips all GIT_* vars from the inherited env', () => {
    vi.stubEnv('GIT_DIR', '/some/repo/.git');
    vi.stubEnv('GIT_INDEX_FILE', '/tmp/fake-index');
    const env = buildSnapshotEnv();
    expect(env['GIT_DIR']).toBeUndefined();
    expect(env['GIT_INDEX_FILE']).toBeUndefined();
    // But the vars set by buildSnapshotEnv itself are present.
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['GIT_ATTR_NOSYSTEM']).toBe('1');
  });

  it('preserves a non-credential var like PATH', () => {
    vi.stubEnv('MY_SAFE_VAR', 'keep');
    expect(buildSnapshotEnv()['MY_SAFE_VAR']).toBe('keep');
  });
});

// --- #11: aggregate blob-bytes cap ---

describe('_setMaxAggregateBlobBytesForTests seam', () => {
  afterEach(() => {
    _setMaxBlobBytesForTests(undefined);
    _setMaxAggregateBlobBytesForTests(undefined);
  });

  it('export is callable and restores to default on undefined', () => {
    _setMaxAggregateBlobBytesForTests(1024);
    _setMaxAggregateBlobBytesForTests(undefined);
    // No throw means the seam works; behavioural coverage is in git-snapshot.test.ts.
  });
});
