import { describe, it, expect } from 'vitest';
import {
  mintToken,
  tokensMatch,
  bearerFromHeader,
  tokenFromQuery,
  originAllowed,
  allowedOrigins,
  checkBind,
} from './auth.js';

describe('mintToken', () => {
  it('returns 64 hex chars', () => {
    expect(mintToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat', () => {
    expect(mintToken()).not.toBe(mintToken());
  });
});

describe('tokensMatch', () => {
  const token = 'a'.repeat(64);

  it('accepts the exact token', () => {
    expect(tokensMatch(token, token)).toBe(true);
  });

  it('rejects a wrong token of equal length', () => {
    expect(tokensMatch(token, 'b'.repeat(64))).toBe(false);
  });

  // timingSafeEqual throws on length mismatch — the length guard must come
  // first, so this asserts "false", never a throw.
  it('rejects a shorter token without throwing', () => {
    expect(() => tokensMatch(token, 'short')).not.toThrow();
    expect(tokensMatch(token, 'short')).toBe(false);
  });

  it('rejects a longer token without throwing', () => {
    expect(tokensMatch(token, 'a'.repeat(128))).toBe(false);
  });

  it('rejects undefined and empty', () => {
    expect(tokensMatch(token, undefined)).toBe(false);
    expect(tokensMatch(token, '')).toBe(false);
  });
});

describe('bearerFromHeader', () => {
  it('extracts a bearer token', () => {
    expect(bearerFromHeader('Bearer abc123')).toBe('abc123');
  });

  it('is case-insensitive on the scheme', () => {
    expect(bearerFromHeader('bearer abc123')).toBe('abc123');
  });

  it('returns undefined for missing or malformed headers', () => {
    expect(bearerFromHeader(undefined)).toBeUndefined();
    expect(bearerFromHeader('')).toBeUndefined();
    expect(bearerFromHeader('Basic abc123')).toBeUndefined();
    expect(bearerFromHeader('Bearer')).toBeUndefined();
  });
});

describe('tokenFromQuery', () => {
  it('reads ?token=', () => {
    expect(tokenFromQuery('/?token=xyz')).toBe('xyz');
  });

  it('reads token among other params', () => {
    expect(tokenFromQuery('/index.html?a=1&token=xyz&b=2')).toBe('xyz');
  });

  it('returns undefined when absent', () => {
    expect(tokenFromQuery('/')).toBeUndefined();
    expect(tokenFromQuery('/?other=1')).toBeUndefined();
  });
});

describe('originAllowed', () => {
  it('allows a missing Origin (non-browser clients)', () => {
    expect(originAllowed(undefined, '127.0.0.1', 4000)).toBe(true);
    expect(originAllowed('', '127.0.0.1', 4000)).toBe(true);
  });

  it('allows this server’s own loopback origins', () => {
    expect(originAllowed('http://127.0.0.1:4000', '127.0.0.1', 4000)).toBe(true);
    expect(originAllowed('http://localhost:4000', '127.0.0.1', 4000)).toBe(true);
  });

  it('rejects a foreign site', () => {
    expect(originAllowed('https://evil.example', '127.0.0.1', 4000)).toBe(false);
  });

  // The CSRF case that a loopback bind alone does not stop: another local
  // process/page on a different port driving the agent.
  it('rejects a different local port', () => {
    expect(originAllowed('http://127.0.0.1:9999', '127.0.0.1', 4000)).toBe(false);
  });
});

describe('allowedOrigins', () => {
  it('expands loopback aliases', () => {
    expect(allowedOrigins('127.0.0.1', 3000)).toEqual([
      'http://127.0.0.1:3000',
      'http://localhost:3000',
      'http://[::1]:3000',
    ]);
  });

  it('uses only the given host when not loopback', () => {
    expect(allowedOrigins('192.168.1.5', 3000)).toEqual(['http://192.168.1.5:3000']);
  });
});

describe('checkBind', () => {
  it('allows loopback without an explicit token', () => {
    expect(checkBind('127.0.0.1', false).ok).toBe(true);
    expect(checkBind('localhost', false).ok).toBe(true);
    expect(checkBind('::1', false).ok).toBe(true);
  });

  it('refuses a non-loopback bind without an explicit token', () => {
    const res = checkBind('0.0.0.0', false);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('refusing to bind');
  });

  it('allows a non-loopback bind once a token is explicit', () => {
    expect(checkBind('0.0.0.0', true).ok).toBe(true);
  });
});
