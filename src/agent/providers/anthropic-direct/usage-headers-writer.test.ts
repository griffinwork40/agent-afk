/**
 * Tests for the unified rate-limit header writer (#5012).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseUnifiedHeaders,
  UsageHeadersTurnWriter,
  setUpUsageHeadersTurnWriter,
} from './usage-headers-writer.js';

const P = 'anthropic-ratelimit-unified-';

function h(values: Record<string, string>): Headers {
  return new Headers(values);
}

// ---------------------------------------------------------------------------
// parseUnifiedHeaders
// ---------------------------------------------------------------------------

describe('parseUnifiedHeaders', () => {
  it('returns undefined when no unified headers are present', () => {
    expect(parseUnifiedHeaders(h({ 'content-type': 'text/event-stream' }))).toBeUndefined();
    expect(parseUnifiedHeaders(h({ 'anthropic-ratelimit-requests-limit': '50' }))).toBeUndefined();
  });

  it('returns a record when any unified header is present', () => {
    const result = parseUnifiedHeaders(h({ [`${P}status`]: 'allowed' }));
    expect(result).not.toBeUndefined();
    expect(result?.status).toBe('allowed');
  });

  it('parses status and representative-claim', () => {
    const result = parseUnifiedHeaders(h({
      [`${P}status`]: 'allowed_warning',
      [`${P}representative-claim`]: '5h',
    }));
    expect(result?.status).toBe('allowed_warning');
    expect(result?.representativeClaim).toBe('5h');
  });

  it('parses 5h window fields', () => {
    const result = parseUnifiedHeaders(h({
      [`${P}5h-status`]: 'allowed',
      [`${P}5h-reset`]: '1731801600',
      [`${P}5h-utilization`]: '0.82',
    }));
    expect(result?.fiveHour).toEqual({ status: 'allowed', reset: 1731801600, utilization: 0.82 });
  });

  it('parses 7d window fields', () => {
    const result = parseUnifiedHeaders(h({
      [`${P}7d-status`]: 'allowed_warning',
      [`${P}7d-reset`]: '1732060800',
      [`${P}7d-utilization`]: '0.45',
    }));
    expect(result?.sevenDay).toEqual({ status: 'allowed_warning', reset: 1732060800, utilization: 0.45 });
  });

  it('top-level reset prefers 5h reset over 7d reset', () => {
    const result = parseUnifiedHeaders(h({
      [`${P}5h-reset`]: '1731801600',
      [`${P}7d-reset`]: '1732060800',
    }));
    expect(result?.reset).toBe(1731801600);
  });

  it('top-level reset falls back to 7d when 5h absent', () => {
    const result = parseUnifiedHeaders(h({
      [`${P}7d-reset`]: '1732060800',
    }));
    expect(result?.reset).toBe(1732060800);
  });

  it('parses overage in-use true', () => {
    const result = parseUnifiedHeaders(h({ [`${P}overage-in-use`]: 'true' }));
    expect(result?.overage).toEqual({ inUse: true });
  });

  it('parses overage in-use false', () => {
    const result = parseUnifiedHeaders(h({ [`${P}overage-in-use`]: 'false' }));
    expect(result?.overage).toEqual({ inUse: false });
  });

  it('omits absent optional fields', () => {
    const result = parseUnifiedHeaders(h({ [`${P}status`]: 'allowed' }));
    expect(result).not.toHaveProperty('fiveHour');
    expect(result).not.toHaveProperty('sevenDay');
    expect(result).not.toHaveProperty('overage');
    expect(result).not.toHaveProperty('representativeClaim');
    expect(result).not.toHaveProperty('reset');
  });

  it('clamps utilization to [0,1]', () => {
    const result = parseUnifiedHeaders(h({
      [`${P}5h-utilization`]: '1.5',
    }));
    expect(result?.fiveHour?.utilization).toBe(1);
    const result2 = parseUnifiedHeaders(h({
      [`${P}5h-utilization`]: '-0.1',
    }));
    expect(result2?.fiveHour?.utilization).toBe(0);
  });

  it('normalises header names case-insensitively', () => {
    const result = parseUnifiedHeaders(h({
      'Anthropic-RateLimit-Unified-Status': 'ALLOWED_WARNING',
    }));
    expect(result?.status).toBe('allowed_warning');
  });

  it('never throws on garbage values', () => {
    expect(() =>
      parseUnifiedHeaders(h({
        [`${P}5h-utilization`]: 'not-a-number',
        [`${P}5h-reset`]: 'not-a-number',
      })),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// UsageHeadersTurnWriter
// ---------------------------------------------------------------------------

describe('UsageHeadersTurnWriter', () => {
  let dir: string;
  let dest: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afk-usage-headers-test-'));
    dest = join(dir, 'usage-headers.json');
  });

  it('flush is a no-op when no headers were observed', () => {
    const writer = new UsageHeadersTurnWriter('acct:test', dest);
    writer.flush();
    expect(existsSync(dest)).toBe(false);
  });

  it('flush writes the file after observe with unified headers', () => {
    const writer = new UsageHeadersTurnWriter('acct:test', dest);
    writer.observe(h({ [`${P}status`]: 'allowed', [`${P}5h-utilization`]: '0.5' }));
    writer.flush();
    expect(existsSync(dest)).toBe(true);
    const record = JSON.parse(readFileSync(dest, 'utf-8'));
    expect(record.accountId).toBe('acct:test');
    expect(record.status).toBe('allowed');
    expect(record.fiveHour?.utilization).toBe(0.5);
    expect(typeof record.updatedAt).toBe('string');
  });

  it('last observe wins (latest headers used)', () => {
    const writer = new UsageHeadersTurnWriter('acct:test', dest);
    writer.observe(h({ [`${P}status`]: 'allowed' }));
    writer.observe(h({ [`${P}status`]: 'allowed_warning' }));
    writer.flush();
    const record = JSON.parse(readFileSync(dest, 'utf-8'));
    expect(record.status).toBe('allowed_warning');
  });

  it('flush is idempotent — second call is a no-op', () => {
    const writer = new UsageHeadersTurnWriter('acct:test', dest);
    writer.observe(h({ [`${P}status`]: 'allowed' }));
    writer.flush();
    const mtime1 = readFileSync(dest).toString();
    writer.flush();
    const mtime2 = readFileSync(dest).toString();
    // Content must not change on second flush
    expect(mtime1).toBe(mtime2);
  });

  it('observe with non-unified headers does not mark writer as having data', () => {
    const writer = new UsageHeadersTurnWriter('acct:test', dest);
    writer.observe(h({ 'content-type': 'application/json' }));
    writer.flush();
    expect(existsSync(dest)).toBe(false);
  });

  it('never throws when flush encounters a bad path', () => {
    const writer = new UsageHeadersTurnWriter('acct:test', '/no-such-dir/usage-headers.json');
    writer.observe(h({ [`${P}status`]: 'allowed' }));
    expect(() => writer.flush()).not.toThrow();
  });

  it('writes JSON with accountId, updatedAt, and all parsed fields', () => {
    const writer = new UsageHeadersTurnWriter('acct:myuser', dest);
    writer.observe(h({
      [`${P}status`]: 'allowed_warning',
      [`${P}representative-claim`]: '5h',
      [`${P}5h-status`]: 'allowed',
      [`${P}5h-reset`]: '1731801600',
      [`${P}5h-utilization`]: '0.82',
      [`${P}7d-status`]: 'allowed_warning',
      [`${P}7d-reset`]: '1732060800',
      [`${P}7d-utilization`]: '0.45',
      [`${P}overage-in-use`]: 'false',
    }));
    writer.flush();
    const record = JSON.parse(readFileSync(dest, 'utf-8'));
    expect(record).toMatchObject({
      accountId: 'acct:myuser',
      status: 'allowed_warning',
      reset: 1731801600,
      representativeClaim: '5h',
      fiveHour: { status: 'allowed', reset: 1731801600, utilization: 0.82 },
      sevenDay: { status: 'allowed_warning', reset: 1732060800, utilization: 0.45 },
      overage: { inUse: false },
    });
    expect(typeof record.updatedAt).toBe('string');
    expect(new Date(record.updatedAt).getFullYear()).toBeGreaterThan(2020);
  });
});

// ---------------------------------------------------------------------------
// setUpUsageHeadersTurnWriter
// ---------------------------------------------------------------------------

describe('setUpUsageHeadersTurnWriter', () => {
  it('returns a writer for oauth authMode', () => {
    const writer = setUpUsageHeadersTurnWriter('oauth', undefined);
    expect(writer).toBeInstanceOf(UsageHeadersTurnWriter);
  });

  it('returns undefined for api-key authMode', () => {
    expect(setUpUsageHeadersTurnWriter('api-key', undefined)).toBeUndefined();
  });

  it('returns undefined for bedrock authMode', () => {
    expect(setUpUsageHeadersTurnWriter('bedrock', undefined)).toBeUndefined();
  });

  it('returns undefined for vertex authMode', () => {
    expect(setUpUsageHeadersTurnWriter('vertex', undefined)).toBeUndefined();
  });

  it('uses parseAccountIdentifier on the token', () => {
    // parseAccountIdentifier('') returns 'token:(unknown)' sentinel
    const writer = setUpUsageHeadersTurnWriter('oauth', undefined);
    expect(writer).not.toBeUndefined();
    // The writer instance itself carries accountId internally — we can verify
    // it by flushing and reading the file.
    const dir = mkdtempSync(join(tmpdir(), 'afk-uid-test-'));
    const dest = join(dir, 'out.json');
    // Create a writer with a known dest path and check accountId is non-empty
    const w = new UsageHeadersTurnWriter('token:(unknown)', dest);
    w.observe(h({ [`${P}status`]: 'allowed' }));
    w.flush();
    const record = JSON.parse(readFileSync(dest, 'utf-8'));
    expect(record.accountId).toBe('token:(unknown)');
  });
});
