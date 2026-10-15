import { describe, it, expect } from 'vitest';
import { findMatchingOpen, findMatchingClose } from './json-brace-scanner.js';

describe('findMatchingOpen', () => {
  it('finds the matching { for a closing }', () => {
    const s = '{"key": "value"}';
    const closeIdx = s.lastIndexOf('}');
    expect(findMatchingOpen(s, closeIdx)).toBe(0);
  });

  it('handles nested braces', () => {
    const s = '{"a": {"b": 1}}';
    const closeIdx = s.lastIndexOf('}');
    expect(findMatchingOpen(s, closeIdx)).toBe(0);
  });

  it('skips braces inside string literals', () => {
    const s = '{"key": "va}lue"}';
    const closeIdx = s.lastIndexOf('}');
    expect(findMatchingOpen(s, closeIdx)).toBe(0);
  });

  it('returns -1 when no matching open brace exists', () => {
    const s = '"key": "value"}';
    expect(findMatchingOpen(s, s.length - 1)).toBe(-1);
  });

  it('works when the object is embedded in surrounding text', () => {
    const s = 'prefix {"a": 1} suffix';
    const closeIdx = s.indexOf('}');
    expect(findMatchingOpen(s, closeIdx)).toBe(7);
  });
});

describe('findMatchingClose', () => {
  it('finds the matching } for an opening {', () => {
    const s = '{"key": "value"}';
    expect(findMatchingClose(s, 0)).toBe(s.length - 1);
  });

  it('handles nested braces', () => {
    const s = '{"a": {"b": 1}}';
    expect(findMatchingClose(s, 0)).toBe(s.length - 1);
  });

  it('skips braces inside string literals', () => {
    const s = '{"key": "va}lue"}';
    expect(findMatchingClose(s, 0)).toBe(s.length - 1);
  });

  it('returns -1 when no matching close brace exists', () => {
    const s = '{"key": "value"';
    expect(findMatchingClose(s, 0)).toBe(-1);
  });

  it('works when the object is embedded in surrounding text', () => {
    const s = 'prefix {"a": 1} suffix';
    const openIdx = s.indexOf('{');
    expect(findMatchingClose(s, openIdx)).toBe(s.indexOf('}'));
  });

  it('round-trips with findMatchingOpen', () => {
    const s = 'text {"x": {"y": "z}{"}} end';
    const openIdx = s.indexOf('{');
    const closeIdx = findMatchingClose(s, openIdx);
    expect(closeIdx).toBeGreaterThan(openIdx);
    expect(findMatchingOpen(s, closeIdx)).toBe(openIdx);
  });
});
