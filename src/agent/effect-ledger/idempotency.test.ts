/**
 * Unit tests for idempotency key computation.
 */

import { describe, it, expect } from 'vitest';
import { computeIdempotencyKey } from './idempotency.js';

describe('computeIdempotencyKey', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const key = computeIdempotencyKey('send_telegram', { message: 'hello' });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same inputs produce the same key', () => {
    const k1 = computeIdempotencyKey('send_telegram', { message: 'hello' });
    const k2 = computeIdempotencyKey('send_telegram', { message: 'hello' });
    expect(k1).toBe(k2);
  });

  it('different operationType produces different key', () => {
    const k1 = computeIdempotencyKey('send_telegram', { message: 'hello' });
    const k2 = computeIdempotencyKey('mcp_write', { message: 'hello' });
    expect(k1).not.toBe(k2);
  });

  it('different args produce different key', () => {
    const k1 = computeIdempotencyKey('send_telegram', { message: 'hello' });
    const k2 = computeIdempotencyKey('send_telegram', { message: 'world' });
    expect(k1).not.toBe(k2);
  });

  it('key is stable regardless of object key order', () => {
    const k1 = computeIdempotencyKey('bash_external', { command: 'git push', cwd: '/tmp' });
    const k2 = computeIdempotencyKey('bash_external', { cwd: '/tmp', command: 'git push' });
    expect(k1).toBe(k2);
  });

  it('nested object key order is also stable', () => {
    const k1 = computeIdempotencyKey('mcp_write', { a: { z: 1, y: 2 }, b: 3 });
    const k2 = computeIdempotencyKey('mcp_write', { b: 3, a: { y: 2, z: 1 } });
    expect(k1).toBe(k2);
  });

  it('array element order is preserved (different order = different key)', () => {
    const k1 = computeIdempotencyKey('some_op', { files: ['a.ts', 'b.ts'] });
    const k2 = computeIdempotencyKey('some_op', { files: ['b.ts', 'a.ts'] });
    expect(k1).not.toBe(k2);
  });

  it('null args produce a stable key', () => {
    const k1 = computeIdempotencyKey('send_telegram', null);
    const k2 = computeIdempotencyKey('send_telegram', null);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('undefined args produce a stable key', () => {
    const k1 = computeIdempotencyKey('send_telegram', undefined);
    const k2 = computeIdempotencyKey('send_telegram', undefined);
    expect(k1).toBe(k2);
  });

  it('empty object is stable', () => {
    const k1 = computeIdempotencyKey('bash_external', {});
    const k2 = computeIdempotencyKey('bash_external', {});
    expect(k1).toBe(k2);
  });
});
