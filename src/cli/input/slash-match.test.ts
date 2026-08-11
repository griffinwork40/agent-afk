/**
 * Invariant under test: ONE ranking implementation serves both surfaces.
 *
 * The web dropdown and the REPL dropdown must order candidates identically —
 * that parity is the whole reason the ranking core was lifted out of
 * `trigger.ts` (which imports `fs` and so cannot be bundled for a browser)
 * into this dependency-free module. These cases pin the four ranking rules
 * the REPL has always had: prefix bucket first, subsequence bucket appended,
 * recency within a bucket, alphabetical as the terminal tie-break — plus the
 * cap and the de-duplication that keep the viewport honest.
 */

import { describe, it, expect } from 'vitest';
import { matchSlashCandidates, isSubsequence, MAX_SLASH_MATCHES, type CommandEntry } from './slash-match.js';

const universe: CommandEntry[] = [
  { name: '/config', summary: 'configure' },
  { name: '/cost', summary: 'show cost' },
  { name: '/clear', summary: 'clear screen' },
  { name: '/mint', summary: 'ship a feature', hint: 'use for greenfield work' },
  { name: '/model', summary: 'switch model' },
];

const values = (q: string, history: readonly string[] = []): string[] =>
  matchSlashCandidates(universe, q, history).map((c) => c.value);

describe('matchSlashCandidates', () => {
  it('returns every command for an empty query, alphabetically', () => {
    expect(values('')).toEqual(['/clear', '/config', '/cost', '/mint', '/model']);
  });

  it('ranks prefix matches alphabetically', () => {
    expect(values('co')).toEqual(['/config', '/cost']);
  });

  it('matches case-insensitively', () => {
    expect(values('CO')).toEqual(['/config', '/cost']);
  });

  it('appends subsequence matches BELOW prefix matches', () => {
    // `co` prefixes /config and /cost, and is also a non-contiguous
    // subsequence of /checkout (c...o). Both buckets must be present, and
    // every prefix hit must outrank the subsequence hit regardless of
    // alphabetical order — /checkout would sort first on name alone.
    const mixed: CommandEntry[] = [
      { name: '/checkout', summary: 'switch branch' },
      { name: '/config', summary: 'configure' },
      { name: '/cost', summary: 'show cost' },
    ];
    expect(matchSlashCandidates(mixed, 'co').map((c) => c.value)).toEqual([
      '/config',
      '/cost',
      '/checkout',
    ]);
  });

  it('never lists a command in both buckets', () => {
    const out = values('c');
    expect(new Set(out).size).toBe(out.length);
  });

  it('promotes recently-used commands within a bucket', () => {
    // /cost sorts after /config alphabetically, but a newer history entry wins.
    expect(values('co', ['/cost'])).toEqual(['/cost', '/config']);
  });

  it('falls back to alphabetical when history is empty', () => {
    expect(values('co', [])).toEqual(values('co'));
  });

  it('carries summary and hint through unchanged', () => {
    const [first] = matchSlashCandidates(universe, 'mint');
    expect(first).toEqual({ value: '/mint', summary: 'ship a feature', hint: 'use for greenfield work' });
  });

  it('omits hint when the source entry has none', () => {
    const [first] = matchSlashCandidates(universe, 'cost');
    expect(first).not.toHaveProperty('hint');
  });

  it('returns nothing when no command matches', () => {
    expect(values('zzz')).toEqual([]);
  });

  it(`caps results at ${MAX_SLASH_MATCHES}`, () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `/cmd${i}`, summary: 's' }));
    expect(matchSlashCandidates(many, '')).toHaveLength(MAX_SLASH_MATCHES);
  });

  it('tolerates an empty universe', () => {
    expect(matchSlashCandidates([], 'anything')).toEqual([]);
  });
});

describe('isSubsequence', () => {
  it('matches non-contiguous characters in order', () => {
    expect(isSubsequence('cfg', 'config')).toBe(true);
  });

  it('rejects out-of-order characters', () => {
    expect(isSubsequence('gfc', 'config')).toBe(false);
  });

  it('treats the empty needle as always matching', () => {
    expect(isSubsequence('', 'config')).toBe(true);
  });
});
