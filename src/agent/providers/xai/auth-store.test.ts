/**
 * Unit tests for the xAI OAuth token store.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearXaiTokens,
  last4OfToken,
  parseXaiTokenBundle,
  readXaiTokens,
  writeXaiTokens,
  type XaiAuthStoreDeps,
  type XaiTokenBundle,
} from './auth-store.js';

function memStore(): XaiAuthStoreDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    authPath: () => '/tmp/xai-auth.json',
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, data) => {
      files.set(p, data);
    },
    mkdir: () => undefined,
    unlink: (p) => {
      files.delete(p);
    },
    exists: (p) => files.has(p),
  };
}

const sample: XaiTokenBundle = {
  access_token: 'access-token-abcd',
  refresh_token: 'refresh-token-efgh',
  expires_at: 1_700_000_000,
  token_type: 'Bearer',
  scope: 'openid',
};

describe('parseXaiTokenBundle', () => {
  it('accepts a valid bundle', () => {
    expect(parseXaiTokenBundle(JSON.stringify(sample))).toEqual(sample);
  });

  it('rejects invalid JSON', () => {
    expect(parseXaiTokenBundle('{')).toBeNull();
  });

  it('rejects missing refresh_token', () => {
    expect(
      parseXaiTokenBundle(JSON.stringify({ access_token: 'a', expires_at: 1 })),
    ).toBeNull();
  });

  it('rejects non-number expires_at', () => {
    expect(
      parseXaiTokenBundle(
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_at: 'soon',
        }),
      ),
    ).toBeNull();
  });
});

describe('read/write/clearXaiTokens', () => {
  let store: ReturnType<typeof memStore>;

  beforeEach(() => {
    store = memStore();
  });

  it('round-trips a bundle', () => {
    writeXaiTokens(sample, store);
    expect(readXaiTokens(store)).toEqual(sample);
  });

  it('overwrites both access and refresh tokens (rotation path)', () => {
    writeXaiTokens(sample, store);
    writeXaiTokens(
      {
        access_token: 'new-access-9999',
        refresh_token: 'new-refresh-8888',
        expires_at: 1_800_000_000,
      },
      store,
    );
    const got = readXaiTokens(store);
    expect(got?.access_token).toBe('new-access-9999');
    expect(got?.refresh_token).toBe('new-refresh-8888');
  });

  it('returns null when missing', () => {
    expect(readXaiTokens(store)).toBeNull();
  });

  it('clear removes the file', () => {
    writeXaiTokens(sample, store);
    clearXaiTokens(store);
    expect(readXaiTokens(store)).toBeNull();
  });

  it('write uses JSON that does not leak into last4 helper', () => {
    expect(last4OfToken(sample.access_token)).toBe('abcd');
    expect(last4OfToken('xy')).toBe('xy');
  });
});
