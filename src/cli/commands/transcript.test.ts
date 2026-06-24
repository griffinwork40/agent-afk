/**
 * Tests for the `afk transcript search --limit` normalization helper.
 *
 * @module cli/commands/transcript.test
 */

import { describe, it, expect } from 'vitest';
import { normalizeLimit, MAX_SEARCH_LIMIT } from './transcript.js';

describe('normalizeLimit', () => {
  it('returns the parsed value for a valid positive integer', () => {
    expect(normalizeLimit('5')).toBe(5);
    expect(normalizeLimit('1')).toBe(1);
  });

  it('falls back to the default (10) for zero', () => {
    expect(normalizeLimit('0')).toBe(10);
  });

  it('falls back to the default (10) for negative values', () => {
    expect(normalizeLimit('-5')).toBe(10);
  });

  it('falls back to the default (10) for non-numeric input', () => {
    expect(normalizeLimit('abc')).toBe(10);
  });

  it('falls back to the default (10) for empty input', () => {
    expect(normalizeLimit('')).toBe(10);
  });

  it('caps values above MAX_SEARCH_LIMIT', () => {
    expect(normalizeLimit(String(MAX_SEARCH_LIMIT + 50))).toBe(MAX_SEARCH_LIMIT);
    expect(normalizeLimit('999999999')).toBe(MAX_SEARCH_LIMIT);
  });

  it('returns MAX_SEARCH_LIMIT exactly at the cap', () => {
    expect(normalizeLimit(String(MAX_SEARCH_LIMIT))).toBe(MAX_SEARCH_LIMIT);
  });

  it('honors a custom fallback for invalid input', () => {
    expect(normalizeLimit('nope', 25)).toBe(25);
  });

  it('uses parseInt leading-integer semantics for mixed input', () => {
    expect(normalizeLimit('7abc')).toBe(7);
  });
});
