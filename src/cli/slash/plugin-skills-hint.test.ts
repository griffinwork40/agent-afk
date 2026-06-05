/**
 * Tests for `extractHintFromDescription` — the "Use when..." sentence parser
 * that powers tooltip hints on plugin-skill passthrough commands.
 *
 * Plugin SKILL.md descriptions don't carry a structured `whenToUse` field, so
 * the dropdown leans on the convention of embedding a "Use when..." sentence
 * in the description body. These cases lock the heuristic against shipped
 * plugin examples and a few adversarial shapes.
 */

import { describe, it, expect } from 'vitest';
import { extractHintFromDescription } from './plugin-skills.js';

describe('extractHintFromDescription', () => {
  it('returns undefined for empty input', () => {
    expect(extractHintFromDescription('')).toBeUndefined();
  });

  it('returns undefined when no "Use when..." sentence is present', () => {
    const desc = 'Generic skill that does generic things and offers value.';
    expect(extractHintFromDescription(desc)).toBeUndefined();
  });

  it('extracts a leading "Use when" sentence', () => {
    const desc = 'Use when a proposal will drive a decision. Generates alternatives.';
    expect(extractHintFromDescription(desc)).toBe('Use when a proposal will drive a decision.');
  });

  it('extracts a "Used when" variant', () => {
    const desc = 'Surveys the diff for regressions. Used when changes are ready for merge.';
    expect(extractHintFromDescription(desc)).toBe('Used when changes are ready for merge.');
  });

  it('extracts a trailing "Use when" sentence inside a longer description', () => {
    const desc =
      'Adversarial critic skill. Dispatches three lenses in parallel. ' +
      'Use when a plan or recommendation will drive decisions.';
    expect(extractHintFromDescription(desc)).toBe(
      'Use when a plan or recommendation will drive decisions.',
    );
  });

  it('extracts a "When the user wants" sentence', () => {
    const desc =
      'Ships an idea to a working PR. ' +
      'When the user wants a feature delivered end-to-end.';
    expect(extractHintFromDescription(desc)).toBe(
      'When the user wants a feature delivered end-to-end.',
    );
  });

  it('ignores tiny pathological matches', () => {
    // "When." would technically pattern-match but is useless as a hint.
    expect(extractHintFromDescription('When.')).toBeUndefined();
  });
});
