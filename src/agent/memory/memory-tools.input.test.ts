/**
 * Unit tests for the pure parsing/validation helpers in memory-tools.input.ts.
 *
 * Focus: `parseOptionalFactCategory` — the shared helper extracted in #3268.
 * The full `parseMemorySearchInput` / `parseMemoryUpdateInput` roundtrip paths
 * are exercised by the integration tests in `tests/agent/memory/memory-tools.test.ts`.
 *
 * @module agent/memory/memory-tools.input.test
 */

import { describe, it, expect } from 'vitest';
import {
  parseOptionalFactCategory,
  parseMemorySearchInput,
  parseMemoryUpdateInput,
} from './memory-tools.input.js';

describe('parseOptionalFactCategory', () => {
  it('returns undefined when category is absent', () => {
    expect(parseOptionalFactCategory({})).toBeUndefined();
  });

  it('accepts all four valid categories', () => {
    for (const cat of ['preference', 'convention', 'decision', 'learning'] as const) {
      expect(parseOptionalFactCategory({ category: cat })).toBe(cat);
    }
  });

  it('throws when category is a non-string', () => {
    expect(() => parseOptionalFactCategory({ category: 42 })).toThrow(
      'category must be a string',
    );
  });

  it('throws with the canonical message when category is an unrecognised string', () => {
    expect(() => parseOptionalFactCategory({ category: 'opinion' })).toThrow(
      'category must be one of: preference, convention, decision, learning',
    );
  });
});

describe('parseMemorySearchInput — category field (via parseOptionalFactCategory)', () => {
  it('omits category when not supplied', () => {
    const result = parseMemorySearchInput({ query: 'hello' });
    expect(result.category).toBeUndefined();
  });

  it('parses a valid category', () => {
    const result = parseMemorySearchInput({ query: 'hello', category: 'learning' });
    expect(result.category).toBe('learning');
  });

  it('throws on an invalid category string', () => {
    expect(() => parseMemorySearchInput({ query: 'hello', category: 'bogus' })).toThrow(
      /category must be one of/,
    );
  });
});

describe('parseMemoryUpdateInput — category field (via parseOptionalFactCategory)', () => {
  const base = { target: 'fact', action: 'set', content: 'data' };

  it('omits category when not supplied', () => {
    const result = parseMemoryUpdateInput(base);
    expect(result.category).toBeUndefined();
  });

  it('parses a valid category', () => {
    const result = parseMemoryUpdateInput({ ...base, category: 'decision' });
    expect(result.category).toBe('decision');
  });

  it('throws on an invalid category string', () => {
    expect(() => parseMemoryUpdateInput({ ...base, category: 'invalid' })).toThrow(
      /category must be one of/,
    );
  });
});
