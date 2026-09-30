/**
 * Unit tests for FTS5 query sanitization (memory-store.fts.ts).
 *
 * Guards against the silent-empty-result bug (issue #2669) where queries with
 * bareword hyphens, colons, or other FTS5 syntax characters were discarded by
 * a catch-all in MemoryStore.search() instead of being sanitized and retried.
 *
 * @module agent/memory/memory-store.fts.test
 */

import { describe, it, expect } from 'vitest';
import { sanitizeFtsQuery } from './memory-store.fts.js';

describe('sanitizeFtsQuery', () => {
  // ── Hyphenated terms ──────────────────────────────────────────
  it('wraps a hyphenated bare token in double-quotes', () => {
    expect(sanitizeFtsQuery('agent-afk')).toBe('"agent-afk"');
  });

  it('wraps a multi-hyphen token (e.g. a compound name)', () => {
    expect(sanitizeFtsQuery('ground-state')).toBe('"ground-state"');
  });

  // ── Colon-containing terms ────────────────────────────────────
  it('wraps a colon-containing bare token in double-quotes', () => {
    expect(sanitizeFtsQuery('foo:bar')).toBe('"foo:bar"');
  });

  // ── No-op cases — explicit FTS5 operators preserved ──────────
  it('leaves plain tokens unchanged (no special chars)', () => {
    expect(sanitizeFtsQuery('pnpm')).toBe('pnpm');
  });

  it('leaves an explicit AND operator unchanged', () => {
    expect(sanitizeFtsQuery('foo AND bar')).toBe('foo AND bar');
  });

  it('leaves an explicit OR operator unchanged', () => {
    expect(sanitizeFtsQuery('foo OR bar')).toBe('foo OR bar');
  });

  it('leaves an explicit NOT operator unchanged', () => {
    expect(sanitizeFtsQuery('foo NOT bar')).toBe('foo NOT bar');
  });

  it('leaves a prefix wildcard unchanged', () => {
    expect(sanitizeFtsQuery('pref*')).toBe('pref*');
  });

  it('leaves an already-quoted phrase unchanged', () => {
    expect(sanitizeFtsQuery('"agent-afk"')).toBe('"agent-afk"');
  });

  it('leaves a multi-word already-quoted phrase unchanged', () => {
    expect(sanitizeFtsQuery('"ground state"')).toBe('"ground state"');
  });

  // ── Mixed queries — operators + hyphenated terms ──────────────
  it('sanitizes a hyphenated term alongside an AND operator', () => {
    // "agent-afk AND pnpm" → only the hyphenated token is quoted; AND and pnpm are left alone
    expect(sanitizeFtsQuery('agent-afk AND pnpm')).toBe('"agent-afk" AND pnpm');
  });

  it('sanitizes multiple hyphenated tokens in one query', () => {
    expect(sanitizeFtsQuery('agent-afk ground-state')).toBe('"agent-afk" "ground-state"');
  });

  it('keeps a plain term before/after a hyphenated one unchanged', () => {
    expect(sanitizeFtsQuery('foo bar-baz qux')).toBe('foo "bar-baz" qux');
  });

  // ── Prefix wildcard on a hyphenated token ────────────────────
  it('handles a prefix wildcard on a hyphenated term by quoting the base and appending *', () => {
    // FTS5 supports "term"* — the * must sit outside the quotes.
    expect(sanitizeFtsQuery('agent-*')).toBe('"agent-"*');
  });

  // ── Dot and slash ────────────────────────────────────────────
  it('wraps a dot-containing token', () => {
    expect(sanitizeFtsQuery('v1.2.3')).toBe('"v1.2.3"');
  });

  it('wraps a slash-containing token', () => {
    expect(sanitizeFtsQuery('src/config')).toBe('"src/config"');
  });
});
