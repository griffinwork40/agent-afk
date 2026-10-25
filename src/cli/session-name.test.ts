/**
 * Tests for src/cli/session-name.ts — the session-name slugifier.
 */

import { describe, it, expect } from 'vitest';
import { slugifySessionName } from './session-name.js';

describe('slugifySessionName', () => {
  it('kebab-cases a short message', () => {
    // 'the' is a stop word; 'help', 'me', 'fix', 'bug' survive.
    expect(slugifySessionName('Help me fix the bug')).toBe('help-me-fix-bug');
  });

  it('caps the slug at six words', () => {
    expect(slugifySessionName('one two three four five six seven eight')).toBe(
      'one-two-three-four-five-six',
    );
  });

  it('strips punctuation and symbols', () => {
    expect(slugifySessionName('Fix the Telegram resume bug!')).toBe('fix-telegram-resume-bug');
  });

  it('drops markdown emphasis characters', () => {
    expect(slugifySessionName('`code` and *bold* text')).toBe('code-bold-text');
  });

  it('collapses whitespace and underscores to single hyphens', () => {
    // 'a' is not in stop words (removed from list to avoid breaking short inputs).
    expect(slugifySessionName('a__b   c')).toBe('a-b-c');
  });

  it('preserves existing hyphens in hyphenated tokens', () => {
    // 'fix-the-bug' is a single space-free token; stop-word filter operates on
    // space-separated words so the embedded 'the' is not stripped.
    expect(slugifySessionName('fix-the-bug')).toBe('fix-the-bug');
  });

  it('keeps digits', () => {
    expect(slugifySessionName('migrate table 42')).toBe('migrate-table-42');
  });

  it('strips emoji and non-word unicode', () => {
    // 'now' is a stop word → only 'deploy' survives.
    expect(slugifySessionName('deploy 🚀 now')).toBe('deploy');
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

  // --- stop-word stripping ---

  it('strips stop words from free text', () => {
    expect(slugifySessionName('we were shooting the shit awhile ago about naming')).toBe(
      'shooting-shit-awhile-ago-naming',
    );
  });

  it('falls back to original words when all are stop words', () => {
    // 'i', 'do', 'so' are stop words; 'think' is not — so filtered=['think'],
    // which is non-empty, so no fallback. Result is just 'think'.
    expect(slugifySessionName('I do think so')).toBe('think');
  });

  it('fallback: all-stop-word input uses original words', () => {
    // Every word in this input is a stop word → falls back to original.
    expect(slugifySessionName('i do so')).toBe('i-do-so');
  });

  it('strips stop words: fix the bug in session resume', () => {
    expect(slugifySessionName('fix the bug in session resume')).toBe('fix-bug-session-resume');
  });

  // --- slash-command handling ---

  it('/pr-triage --limit 10 --auto-merge → pr-triage-10', () => {
    // --limit and --auto-merge are stripped; bare value '10' is not a flag and survives.
    expect(slugifySessionName('/pr-triage --limit 10 --auto-merge')).toBe('pr-triage-10');
  });

  it('/god audit the codebase for issues → audit-codebase-issues', () => {
    expect(slugifySessionName('/god audit the codebase for issues')).toBe(
      'audit-codebase-issues',
    );
  });

  it('/forge stays forge', () => {
    expect(slugifySessionName('/forge')).toBe('forge');
  });

  it('/tackle-issues 10 → tackle-issues-10', () => {
    expect(slugifySessionName('/tackle-issues 10')).toBe('tackle-issues-10');
  });

  it('/god --continue implement authentication → implement-authentication', () => {
    // --continue is a boolean flag with no attached value; must not consume 'implement'.
    expect(slugifySessionName('/god --continue implement authentication')).toBe(
      'implement-authentication',
    );
  });

  it('/pr-triage --auto-merge fix flaky tests → pr-triage-fix-flaky-tests', () => {
    // --auto-merge is a boolean flag; 'fix', 'flaky', 'tests' must all survive.
    expect(slugifySessionName('/pr-triage --auto-merge fix flaky tests')).toBe(
      'pr-triage-fix-flaky-tests',
    );
  });

  it('boolean flag after value-taking flag does not consume task text', () => {
    // Regression guard for the flag-stripping regex. The pattern
    // /--[\w-]+(?:=\S+)?/g must only consume the `=value` form for
    // value-taking flags — NOT the next word. So after `--limit 10`, the
    // bare `10` must survive, and the subsequent boolean flag `--dry-run`
    // must be stripped without consuming the following task text.
    //
    // Input:  /tackle-issues --limit 10 --dry-run refactor auth module
    // After strip:            <spc> 10 <spc>       refactor auth module
    // Slugified:             10-refactor-auth-module  (tackle-issues prefix + those words)
    expect(slugifySessionName('/tackle-issues --limit 10 --dry-run refactor auth module')).toBe(
      'tackle-issues-10-refactor-auth-module',
    );
  });

  it('value-taking flag with =value form strips only the flag token', () => {
    // --limit=10 is stripped as a single token; surrounding task words survive.
    expect(slugifySessionName('/tackle-issues --limit=10 refactor auth')).toBe(
      'tackle-issues-refactor-auth',
    );
  });
});
