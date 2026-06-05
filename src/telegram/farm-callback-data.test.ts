/**
 * Tests for src/telegram/farm-callback-data.ts
 */

import { describe, it, expect } from 'vitest';
import {
  buildFarmCallback,
  parseFarmCallback,
  FARM_CALLBACK_PREFIX,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
} from './farm-callback-data.js';

describe('parseFarmCallback', () => {
  it('parses all four valid actions', () => {
    for (const a of ['p', 'd', 'r', 'x'] as const) {
      const parsed = parseFarmCallback(`${FARM_CALLBACK_PREFIX}${a}:20260514T150724-add-jose-auth-59fb`);
      expect(parsed).toEqual({ action: a, taskSlug: '20260514T150724-add-jose-auth-59fb' });
    }
  });

  it('returns null on unknown action', () => {
    expect(parseFarmCallback('afk:f:z:my-slug')).toBeNull();
  });

  it('returns null on missing prefix', () => {
    expect(parseFarmCallback('not-afk:f:p:my-slug')).toBeNull();
    expect(parseFarmCallback('afk:other:p:my-slug')).toBeNull();
  });

  it('returns null on path-traversal slug', () => {
    expect(parseFarmCallback('afk:f:x:../../../etc/passwd')).toBeNull();
    expect(parseFarmCallback('afk:f:x:..')).toBeNull();
    expect(parseFarmCallback('afk:f:x:foo/bar')).toBeNull();
  });

  it('returns null on uppercase / disallowed characters', () => {
    // `T` is allowed (it's in the isoCompact timestamp); other uppercase isn't.
    expect(parseFarmCallback('afk:f:x:MySlug')).toBeNull();
    expect(parseFarmCallback('afk:f:x:my slug')).toBeNull();
    expect(parseFarmCallback('afk:f:x:my.slug')).toBeNull();
  });

  it('returns null on empty / nullish input', () => {
    expect(parseFarmCallback(undefined)).toBeNull();
    expect(parseFarmCallback(null)).toBeNull();
    expect(parseFarmCallback('')).toBeNull();
    expect(parseFarmCallback('afk:f:x:')).toBeNull();
  });

  it('returns null when payload exceeds the 64-byte limit', () => {
    const overflow = `afk:f:x:${'a'.repeat(64)}`;
    expect(Buffer.byteLength(overflow)).toBeGreaterThan(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    expect(parseFarmCallback(overflow)).toBeNull();
  });
});

describe('buildFarmCallback', () => {
  it('round-trips through parseFarmCallback', () => {
    const slug = '20260514T150724-add-jose-auth-59fb';
    const built = buildFarmCallback('p', slug);
    expect(built).toBe('afk:f:p:20260514T150724-add-jose-auth-59fb');
    expect(parseFarmCallback(built)).toEqual({ action: 'p', taskSlug: slug });
  });

  it('throws on an invalid slug', () => {
    expect(() => buildFarmCallback('p', '../escape')).toThrow(/invalid taskSlug/);
  });

  it('stays under the 64-byte limit for realistic worst-case slugs', () => {
    // 15 (isoCompact) + 1 + 32 (slug max) + 1 + 4 (hex) = 53 chars.
    const worstCase = '20260514T150724-' + 'a'.repeat(32) + '-1234';
    const built = buildFarmCallback('p', worstCase);
    expect(Buffer.byteLength(built)).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
  });

  it('throws when a future slug grammar would exceed the budget', () => {
    // Force-feed an oversized but valid-by-regex slug; the byte check must fire.
    const oversized = 'a'.repeat(63);
    expect(() => buildFarmCallback('p', oversized)).toThrow(/exceeds/);
  });
});
