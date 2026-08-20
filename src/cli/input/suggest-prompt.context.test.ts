/**
 * Tests for `src/cli/input/suggest-prompt.context.ts` — the structured context
 * extraction helpers for the empty-prompt suggestion.
 */

import { describe, it, expect } from 'vitest';
import { extractOutcome, buildUserArc } from './suggest-prompt.context.js';
import type { SuggestContext } from './suggest-types.js';

function makeCtx(overrides: Partial<SuggestContext> = {}): SuggestContext {
  return {
    model: 'claude-sonnet-4-5',
    cwd: '/home/user/my-project',
    getHistory: () => [],
    getDropdownTopCandidate: () => null,
    getTranscriptTail: () => '',
    getRecentCommands: () => [],
    llmEnabled: () => true,
    promptSuggestEnabled: () => true,
    ...overrides,
  };
}

describe('extractOutcome', () => {
  it('extracts a **Done** terminal-state block', () => {
    const response = [
      'I investigated the issue and found the root cause.',
      'Here is what I did: edited 3 files, ran tests, all passing.',
      '',
      '**Done**',
      '- Fixed the parser to handle nested brackets',
      '- Tests pass: `pnpm test src/parser.test.ts`',
      '- Uncommitted changes in `src/parser.ts`',
    ].join('\n');
    const outcome = extractOutcome(response);
    expect(outcome).toContain('**Done**');
    expect(outcome).toContain('Fixed the parser');
    expect(outcome).not.toContain('I investigated');
  });

  it('extracts a **Blocked** terminal-state block', () => {
    const response = [
      'Attempted to deploy but hit a credentials issue.',
      '',
      '**Blocked**',
      '- Missing AWS_SECRET_ACCESS_KEY',
      '- Set the env var and re-run',
    ].join('\n');
    const outcome = extractOutcome(response);
    expect(outcome).toContain('**Blocked**');
    expect(outcome).toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('extracts a **Asking** terminal-state block', () => {
    const response = [
      'I found two possible approaches.',
      '',
      '**Asking**',
      '- Should I use SQLite or PostgreSQL?',
    ].join('\n');
    const outcome = extractOutcome(response);
    expect(outcome).toContain('**Asking**');
    expect(outcome).toContain('SQLite or PostgreSQL');
  });

  it('extracts a **Interrupted** terminal-state block', () => {
    const response = [
      'Working on the migration.',
      '',
      '**Interrupted**',
      '- Was mid-way through the refactor',
    ].join('\n');
    const outcome = extractOutcome(response);
    expect(outcome).toContain('**Interrupted**');
  });

  it('falls back to the tail of the response when no terminal state found', () => {
    const response = 'Here is a long explanation without a terminal state block. '.repeat(30);
    const outcome = extractOutcome(response);
    // Should take the last 600 chars (tail), not the first 600 (head).
    expect(outcome).toBe(response.slice(-600).trim());
  });

  it('returns short responses in full when under budget', () => {
    const response = 'Tests pass, all good.';
    expect(extractOutcome(response)).toBe('Tests pass, all good.');
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(extractOutcome('')).toBe('');
    expect(extractOutcome('   ')).toBe('');
  });

  it('caps a very long terminal-state block at the outcome budget', () => {
    const longBlock = [
      '',
      '**Done**',
      '- ' + 'x'.repeat(700),
    ].join('\n');
    const outcome = extractOutcome(longBlock);
    expect(outcome.length).toBeLessThanOrEqual(600);
    expect(outcome).toContain('**Done**');
  });

  it('selects the LAST terminal-state heading when multiple are present', () => {
    const response = [
      'First attempt failed.',
      '',
      '**Blocked**',
      '- Missing credentials',
      '',
      'Retried with a different approach.',
      '',
      '**Done**',
      '- Fixed the issue',
      '- Tests pass',
    ].join('\n');
    const outcome = extractOutcome(response);
    expect(outcome).toContain('**Done**');
    expect(outcome).toContain('Fixed the issue');
    expect(outcome).not.toContain('**Blocked**');
  });
});

describe('buildUserArc', () => {
  it('returns empty string when getUserArc is not provided', () => {
    const ctx = makeCtx();
    expect(buildUserArc(ctx)).toBe('');
  });

  it('returns empty string for an empty message list', () => {
    const ctx = makeCtx({ getUserArc: () => [] });
    expect(buildUserArc(ctx)).toBe('');
  });

  it('joins messages with arrow separators', () => {
    const ctx = makeCtx({
      getUserArc: () => ['fix the parser', 'run the tests', 'ship it'],
    });
    const arc = buildUserArc(ctx);
    expect(arc).toBe('fix the parser → run the tests → ship it');
  });

  it('truncates individual messages over 80 chars', () => {
    const longMsg = 'a'.repeat(100);
    const ctx = makeCtx({ getUserArc: () => [longMsg] });
    const arc = buildUserArc(ctx);
    expect(arc.length).toBeLessThan(100);
    expect(arc).toContain('…');
  });

  it('limits to 8 most recent messages', () => {
    const messages = Array.from({ length: 12 }, (_, i) => `step ${i}`);
    const ctx = makeCtx({ getUserArc: () => messages });
    const arc = buildUserArc(ctx);
    // Should NOT contain the first 4 messages (0-3).
    expect(arc).not.toContain('step 0');
    expect(arc).not.toContain('step 3');
    // Should contain the last 8 messages (4-11).
    expect(arc).toContain('step 4');
    expect(arc).toContain('step 11');
  });

  it('respects the total arc budget and preserves NEWEST messages', () => {
    // Each message ~75 chars, total budget 400 — should fit ~5 of 8.
    // The NEWEST messages should survive, not the oldest.
    const messages = Array.from({ length: 8 }, (_, i) => `m${i} ` + 'x'.repeat(70));
    const ctx = makeCtx({ getUserArc: () => messages });
    const arc = buildUserArc(ctx);
    expect(arc.length).toBeLessThanOrEqual(500); // budget + separators
    // Newest messages (m7, m6, m5) should be present; oldest (m0, m1) should not.
    expect(arc).toContain('m7');
    expect(arc).toContain('m6');
    expect(arc).not.toContain('m0');
  });
});
