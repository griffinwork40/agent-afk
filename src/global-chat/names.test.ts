import { describe, expect, it } from 'vitest';
import { formatDisplayName, isReservedName, parseDisplayName, RESERVED_NAMES, validateName } from './names.js';

describe('names', () => {
  it.each(['ab', 'alice', 'griffin', 'name-1_2', 'a'.repeat(16)])('accepts %s', name => {
    expect(validateName(name)).toEqual({ ok: true });
  });
  it.each(['', 'a', 'a'.repeat(17), 'Alice', 'na me', 'ál', 'ab\n', 'ab#1234'])('rejects %s', name => {
    expect(validateName(name)).toEqual({ ok: false, code: 'bad_name' });
  });
  it('rejects every reserved name but not griffin', () => {
    for (const name of RESERVED_NAMES) expect(validateName(name)).toEqual({ ok: false, code: 'reserved_name' });
    expect(isReservedName('ADMIN')).toBe(true);
    expect(isReservedName('griffin')).toBe(false);
  });
  it('round-trips the exact display syntax', () => {
    expect(formatDisplayName('alice', 'a3f2')).toBe('alice#a3f2');
    expect(parseDisplayName('alice#a3f2')).toEqual({ name: 'alice', tag: 'a3f2' });
    expect(parseDisplayName('admin#abcd')).toEqual({ name: 'admin', tag: 'abcd' });
  });
  it.each(['alice', 'alice#A3F2', 'alice#ab', 'alice#abcd extra', ' alice#abcd', 'alice#abcd\n'])
    ('rejects malformed display %s', display => expect(parseDisplayName(display)).toBeNull());
  it('refuses to format invalid names or tags', () => {
    expect(() => formatDisplayName('A', 'abcd')).toThrow();
    expect(() => formatDisplayName('alice', 'ABCD')).toThrow();
  });
});
