/**
 * Tests for src/cli/session-name.ts — the session-name slugifier.
 */

import { describe, it, expect } from 'vitest';
import { slugifySessionName } from './session-name.js';

describe('slugifySessionName', () => {
  it('kebab-cases a short message', () => {
    expect(slugifySessionName('Help me fix the bug')).toBe('help-me-fix-the-bug');
  });

  it('caps the slug at six words', () => {
    expect(slugifySessionName('one two three four five six seven eight')).toBe(
      'one-two-three-four-five-six',
    );
  });

  it('strips punctuation and symbols', () => {
    expect(slugifySessionName('Fix the Telegram resume bug!')).toBe('fix-the-telegram-resume-bug');
  });

  it('drops markdown emphasis characters', () => {
    expect(slugifySessionName('`code` and *bold* text')).toBe('code-and-bold-text');
  });

  it('collapses whitespace and underscores to single hyphens', () => {
    expect(slugifySessionName('a__b   c')).toBe('a-b-c');
  });

  it('preserves existing hyphens', () => {
    expect(slugifySessionName('fix-the-bug')).toBe('fix-the-bug');
  });

  it('keeps digits', () => {
    expect(slugifySessionName('migrate table 42')).toBe('migrate-table-42');
  });

  it('strips emoji and non-word unicode', () => {
    expect(slugifySessionName('deploy 🚀 now')).toBe('deploy-now');
  });

  it('caps length at 48 chars and trims a severed trailing hyphen', () => {
    const out = slugifySessionName(
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda',
    );
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out).not.toMatch(/-$/);
    expect(out.startsWith('alpha-beta-gamma')).toBe(true);
  });

  it('returns empty string for blank or punctuation-only input', () => {
    expect(slugifySessionName('')).toBe('');
    expect(slugifySessionName('   ')).toBe('');
    expect(slugifySessionName('!!!')).toBe('');
    expect(slugifySessionName('***')).toBe('');
  });
});
