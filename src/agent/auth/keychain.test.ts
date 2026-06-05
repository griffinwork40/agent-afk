/**
 * Tests for `parseAccountIdentifier` and `writeLinuxCredentials` in keychain.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseAccountIdentifier, writeLinuxCredentials } from './keychain.js';

/** Build a minimal JWT with the given payload claims. */
function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = 'fakesig';
  return `${header}.${payload}.${sig}`;
}

describe('parseAccountIdentifier', () => {
  it('returns token:(unknown) for empty string', () => {
    expect(parseAccountIdentifier('')).toBe('token:(unknown)');
  });

  it('returns token:(unknown) for string shorter than 3 chars', () => {
    expect(parseAccountIdentifier('ab')).toBe('token:(unknown)');
  });

  it('returns email claim when present', () => {
    const token = makeJwt({ email: 'user@example.com', sub: 'user-123' });
    expect(parseAccountIdentifier(token)).toBe('user@example.com');
  });

  it('falls back to sub when email is absent', () => {
    const token = makeJwt({ sub: 'user-123', account_id: 'acc-456' });
    expect(parseAccountIdentifier(token)).toBe('user-123');
  });

  it('falls back to account_id when email and sub are absent', () => {
    const token = makeJwt({ account_id: 'acc-456', preferred_username: 'alice' });
    expect(parseAccountIdentifier(token)).toBe('acc-456');
  });

  it('falls back to preferred_username when earlier claims are absent', () => {
    const token = makeJwt({ preferred_username: 'alice' });
    expect(parseAccountIdentifier(token)).toBe('alice');
  });

  it('falls back to token:<last-8> when no recognised claim exists', () => {
    const token = makeJwt({ custom_field: 'value' });
    // The token ends with ".fakesig" so last 8 chars of the token are known
    const last8 = token.slice(-8);
    expect(parseAccountIdentifier(token)).toBe(`token:${last8}`);
  });

  it('returns token:<full-token> when token is shorter than 8 chars and has no dots', () => {
    // 3-5 char token with no JWT structure
    const token = 'abc12';
    expect(parseAccountIdentifier(token)).toBe(`token:${token}`);
  });

  it('handles malformed (non-JSON) JWT payload gracefully', () => {
    const header = Buffer.from('{}').toString('base64url');
    const badPayload = Buffer.from('not-json').toString('base64url');
    const token = `${header}.${badPayload}.sig`;
    // Should fall through to the suffix fallback
    const last8 = token.slice(-8);
    expect(parseAccountIdentifier(token)).toBe(`token:${last8}`);
  });

  it('handles token with only one segment (no dots)', () => {
    const token = 'abcdefghijklmno'; // 15 chars, no dots
    const last8 = token.slice(-8);
    expect(parseAccountIdentifier(token)).toBe(`token:${last8}`);
  });
});

// ---------------------------------------------------------------------------
// S3 regression: Linux credential file written with mode 0o600
// ---------------------------------------------------------------------------
describe('writeLinuxCredentials — S3 file mode 0o600 regression', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('writes the credential file with mode 0o600', () => {
    // Constraint: POSIX file-mode — mode must be set at write time (no TOCTOU).
    // We exercise the Linux credential writer directly via the exported helper
    // so this test is platform-independent (no process.platform stub needed).
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-keychain-test-'));
    const credPath = join(tmpDir, '.credentials.json');
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } });

    writeLinuxCredentials(credPath, blob);

    const mode = statSync(credPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes the expected content to the credential file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'afk-keychain-test-'));
    const credPath = join(tmpDir, '.credentials.json');
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc' } });

    writeLinuxCredentials(credPath, blob);

    expect(readFileSync(credPath, 'utf-8')).toBe(blob);
  });
});
