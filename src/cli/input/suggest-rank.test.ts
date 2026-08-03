import { describe, it, expect } from 'vitest';
import {
  buildRecencyRanks,
  compareByRecency,
  rankOf,
  sortByRecency,
  UNRANKED,
} from './suggest-rank.js';

describe('buildRecencyRanks', () => {
  it('ranks the newest entry 0 and increases with age', () => {
    const ranks = buildRecencyRanks(['/review', '/diagnose', '/ship']);
    expect(ranks.get('/review')).toBe(0);
    expect(ranks.get('/diagnose')).toBe(1);
    expect(ranks.get('/ship')).toBe(2);
  });

  it('keeps the newest rank when a command recurs', () => {
    const ranks = buildRecencyRanks(['/ship', '/diagnose', '/ship']);
    expect(ranks.get('/ship')).toBe(0);
  });

  it('extracts a mid-sentence command', () => {
    const ranks = buildRecencyRanks(['can you run /refactor on this module']);
    expect(ranks.get('/refactor')).toBe(0);
  });

  it('extracts every command in one entry', () => {
    const ranks = buildRecencyRanks(['/diagnose then /review']);
    expect(ranks.get('/diagnose')).toBe(0);
    expect(ranks.get('/review')).toBe(0);
  });

  it('lowercases names so casing does not split the index', () => {
    const ranks = buildRecencyRanks(['/ReView']);
    expect(ranks.get('/review')).toBe(0);
  });

  it('accepts registry-legal punctuation in names', () => {
    const ranks = buildRecencyRanks(['/awa-dev:qualify', '/fix-pr 42']);
    expect(ranks.get('/awa-dev:qualify')).toBe(0);
    expect(ranks.get('/fix-pr')).toBe(1);
  });

  it('ignores a slash that is not a command token', () => {
    const ranks = buildRecencyRanks(['src/cli/input', 'http://x.dev/y', '/2fa']);
    expect(ranks.size).toBe(0);
  });

  it('returns an empty index for empty history', () => {
    expect(buildRecencyRanks([]).size).toBe(0);
  });

  it('does not drop matches across entries (global regex lastIndex reset)', () => {
    // Regression: SLASH_TOKEN is module-scoped and global. Without resetting
    // lastIndex per entry, the second entry's match would be skipped.
    const ranks = buildRecencyRanks(['/aaaaaaaaaa', '/bb']);
    expect(ranks.get('/aaaaaaaaaa')).toBe(0);
    expect(ranks.get('/bb')).toBe(1);
  });
});

describe('rankOf', () => {
  const ranks = buildRecencyRanks(['/review']);

  it('resolves a value carrying a leading slash', () => {
    expect(rankOf('/review', ranks)).toBe(0);
  });

  it('resolves a bare registry key', () => {
    expect(rankOf('review', ranks)).toBe(0);
  });

  it('returns UNRANKED for an unused command', () => {
    expect(rankOf('/never-run', ranks)).toBe(UNRANKED);
  });
});

describe('compareByRecency', () => {
  it('orders a used command ahead of an unused one', () => {
    const ranks = buildRecencyRanks(['/review']);
    expect(compareByRecency('/review', '/accept', ranks)).toBeLessThan(0);
  });

  it('orders the more recent of two used commands first', () => {
    const ranks = buildRecencyRanks(['/ship', '/accept']);
    expect(compareByRecency('/ship', '/accept', ranks)).toBeLessThan(0);
  });

  it('falls back to alphabetical when both are unranked', () => {
    const ranks = buildRecencyRanks([]);
    expect(compareByRecency('/accept', '/review', ranks)).toBeLessThan(0);
    expect(compareByRecency('/review', '/accept', ranks)).toBeGreaterThan(0);
  });

  it('is symmetric and self-consistent', () => {
    const ranks = buildRecencyRanks(['/ship']);
    expect(compareByRecency('/ship', '/ship', ranks)).toBe(0);
    expect(Math.sign(compareByRecency('/ship', '/accept', ranks))).toBe(
      -Math.sign(compareByRecency('/accept', '/ship', ranks)),
    );
  });
});

describe('sortByRecency', () => {
  const REAL_COLLISION = ['/reauth', '/recover', '/refactor', '/reground', '/research', '/review'];

  it('is pure alphabetical with no history (preserves prior behaviour)', () => {
    expect(sortByRecency(REAL_COLLISION, [])).toEqual([
      '/reauth',
      '/recover',
      '/refactor',
      '/reground',
      '/research',
      '/review',
    ]);
  });

  it('surfaces the recently used command ahead of the alphabetical winner', () => {
    // The motivating case: `/re` alphabetically resolves to `/reauth`, which is
    // almost never what a user who just ran /review wants.
    expect(sortByRecency(REAL_COLLISION, ['/review something'])[0]).toBe('/review');
  });

  it('orders multiple used commands by recency, unused ones alphabetically after', () => {
    expect(sortByRecency(REAL_COLLISION, ['/research x', '/refactor y'])).toEqual([
      '/research',
      '/refactor',
      '/reauth',
      '/recover',
      '/reground',
      '/review',
    ]);
  });

  it('does not mutate its input', () => {
    const input = ['/review', '/accept'];
    const copy = [...input];
    sortByRecency(input, ['/accept']);
    expect(input).toEqual(copy);
  });

  it('ignores history entries naming commands outside the candidate list', () => {
    expect(sortByRecency(['/accept', '/review'], ['/unrelated-command'])).toEqual([
      '/accept',
      '/review',
    ]);
  });
});
