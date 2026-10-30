/**
 * Tests for episode writer (writer.ts).
 *
 * Tests FTS5 sanitization, content cap, and the formatted content structure.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeNarrative, formatEpisodeContent } from './writer.js';
import type { EpisodeRecord } from './types.js';

function makeEpisode(overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    sessionId: 'test-session-abc',
    goal: 'Refactor the auth module',
    approach: 'Read existing code then apply minimal changes',
    pivots: [],
    decisions: ['Use dependency injection', 'Keep backward compat'],
    outcome: 'Auth module refactored successfully',
    openQuestions: [],
    filesKey: ['src/auth.ts', 'src/auth.test.ts'],
    tags: ['refactor', 'auth'],
    narrative: 'The user wanted auth refactored. The agent read files and applied changes. Outcome was successful.',
    synthesizedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sanitizeNarrative', () => {
  it('strips FTS5 AND operator', () => {
    const result = sanitizeNarrative('foo AND bar');
    expect(result).not.toContain('AND');
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });

  it('strips FTS5 OR operator', () => {
    const result = sanitizeNarrative('foo OR bar');
    expect(result).not.toContain('OR');
  });

  it('strips FTS5 NOT operator', () => {
    const result = sanitizeNarrative('NOT something');
    expect(result).not.toContain('NOT');
  });

  it('strips double-quote characters', () => {
    const result = sanitizeNarrative('"quoted phrase"');
    expect(result).not.toContain('"');
  });

  it('strips colon characters', () => {
    const result = sanitizeNarrative('key:value syntax');
    expect(result).not.toContain(':');
  });

  it('strips asterisk characters', () => {
    const result = sanitizeNarrative('prefix* wildcard');
    expect(result).not.toContain('*');
  });

  it('strips parentheses', () => {
    const result = sanitizeNarrative('(grouped) expression');
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
  });

  it('caps narrative at 2000 chars', () => {
    const long = 'a'.repeat(3000);
    const result = sanitizeNarrative(long);
    expect(result.length).toBe(2000);
  });

  it('handles empty string', () => {
    expect(sanitizeNarrative('')).toBe('');
  });

  it('preserves normal prose text', () => {
    const prose = 'The agent refactored the module successfully with minimal changes.';
    const result = sanitizeNarrative(prose);
    expect(result).toBe(prose);
  });

  it('collapses multiple spaces left by stripping', () => {
    const result = sanitizeNarrative('a AND OR b');
    // After stripping operators and collapsing spaces, should not have double spaces
    expect(result).not.toMatch(/\s{2,}/);
  });
});

describe('formatEpisodeContent', () => {
  it('includes [episode:<sessionId>] prefix', () => {
    const episode = makeEpisode();
    const content = formatEpisodeContent(episode);
    expect(content).toContain('[episode:test-session-abc]');
  });

  it('includes goal, approach, and outcome', () => {
    const episode = makeEpisode();
    const content = formatEpisodeContent(episode);
    expect(content).toContain('goal: Refactor the auth module');
    expect(content).toContain('approach: Read existing code then apply minimal changes');
    expect(content).toContain('outcome: Auth module refactored successfully');
  });

  it('includes decisions when present', () => {
    const episode = makeEpisode();
    const content = formatEpisodeContent(episode);
    expect(content).toContain('decisions:');
    expect(content).toContain('Use dependency injection');
  });

  it('omits pivots line when pivots is empty', () => {
    const episode = makeEpisode({ pivots: [] });
    const content = formatEpisodeContent(episode);
    expect(content).not.toContain('pivots:');
  });

  it('includes pivots when present', () => {
    const episode = makeEpisode({ pivots: ['Switched from direct mutation to functional updates'] });
    const content = formatEpisodeContent(episode);
    expect(content).toContain('pivots:');
    expect(content).toContain('Switched from direct mutation');
  });

  it('includes tags when present', () => {
    const episode = makeEpisode();
    const content = formatEpisodeContent(episode);
    expect(content).toContain('tags: refactor, auth');
  });

  it('includes files when present', () => {
    const episode = makeEpisode();
    const content = formatEpisodeContent(episode);
    expect(content).toContain('files: src/auth.ts');
  });

  it('includes synthesizedAt timestamp', () => {
    const episode = makeEpisode();
    const content = formatEpisodeContent(episode);
    expect(content).toContain('synthesized: 2026-01-01T00:00:00.000Z');
  });

  it('sanitizes narrative in the formatted content', () => {
    const episode = makeEpisode({ narrative: 'Used AND query OR NOT filter' });
    const content = formatEpisodeContent(episode);
    // The narrative line must not contain raw FTS5 operators
    const narrativeLine = content.split('\n').find((l) => l.startsWith('narrative:'));
    expect(narrativeLine).toBeDefined();
    expect(narrativeLine).not.toContain('AND');
    expect(narrativeLine).not.toContain('OR');
    expect(narrativeLine).not.toContain('NOT');
  });

  it('omits narrative line when narrative is empty after sanitization', () => {
    // A narrative that sanitizes to empty
    const episode = makeEpisode({ narrative: '' });
    const content = formatEpisodeContent(episode);
    expect(content).not.toContain('narrative:');
  });
});
