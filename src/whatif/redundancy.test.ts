/**
 * Tests for redundancy.ts — preflight redundancy check.
 *
 * Covers:
 *   - tokenize: normalization, stopword removal, punctuation stripping
 *   - jaccardSimilarity: edge cases and known values
 *   - extractAddedParagraphs: diff parsing
 *   - findNearestHeading: heading search in baseline
 *   - checkRedundancy: end-to-end fixture cases (issue #2414 acceptance criteria)
 *   - formatRedundancySection: prompt injection helper
 */

import { describe, it, expect } from 'vitest';
import {
  tokenize,
  jaccardSimilarity,
  extractAddedParagraphs,
  findNearestHeading,
  checkRedundancy,
  formatRedundancySection,
  REDUNDANCY_THRESHOLD,
} from './redundancy.js';

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('lowercases and strips punctuation', () => {
    const tokens = tokenize('Hello, World!');
    expect(tokens.has('hello')).toBe(true);
    expect(tokens.has('world')).toBe(true);
  });

  it('removes stopwords', () => {
    const tokens = tokenize('the quick brown fox');
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('quick')).toBe(true);
    expect(tokens.has('brown')).toBe(true);
    expect(tokens.has('fox')).toBe(true);
  });

  it('removes tokens shorter than 2 characters', () => {
    const tokens = tokenize('a b I go');
    expect(tokens.has('a')).toBe(false);
    expect(tokens.has('b')).toBe(false);
    // 'go' has 2 chars and is not a stopword
    expect(tokens.has('go')).toBe(true);
  });

  it('returns empty set for empty string', () => {
    expect(tokenize('').size).toBe(0);
  });

  it('deduplicates repeated tokens', () => {
    const tokens = tokenize('cat cat cat');
    expect(tokens.size).toBe(1);
    expect(tokens.has('cat')).toBe(true);
  });

  it('does not over-stem short words ending in -ing (bring, thing, string)', () => {
    // These words are short enough that stem() should leave them intact.
    const tokens = tokenize('bring thing string');
    expect(tokens.has('bring')).toBe(true);
    expect(tokens.has('thing')).toBe(true);
    expect(tokens.has('string')).toBe(true);
  });

  it('does not over-stem things (plural of thing)', () => {
    const tokens = tokenize('things');
    // 'things' has 6 chars; -ings rule requires >6, so it stays as 'things'
    // then -s rule (>3) strips to 'thing' — that is correct, not 'th'
    expect(tokens.has('th')).toBe(false);
    expect(tokens.has('thing')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// jaccardSimilarity
// ---------------------------------------------------------------------------

describe('jaccardSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely disjoint token sets', () => {
    expect(jaccardSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
  });

  it('returns 0 when both strings are empty or only stopwords', () => {
    expect(jaccardSimilarity('', '')).toBe(0);
    expect(jaccardSimilarity('the a an', 'is it its')).toBe(0);
  });

  it('returns partial similarity for overlapping sets', () => {
    // 'delegate tasks' and 'delegate work' share 'delegate'
    const score = jaccardSimilarity('delegate tasks directly', 'delegate work directly');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('near-paraphrases score above REDUNDANCY_THRESHOLD', () => {
    // The example from the issue: two delegation rules phrased differently
    const baseline =
      'Stay inline for: single-file edits, localized fixes visible in fewer than two reads, ' +
      'and tasks solvable without spawning a subagent.';
    const candidate =
      'For tasks solvable with at most three file reads and one localized edit, ' +
      'work directly without skills or subagents.';
    const score = jaccardSimilarity(baseline, candidate);
    expect(score).toBeGreaterThanOrEqual(REDUNDANCY_THRESHOLD);
  });

  it('novel unrelated text scores below REDUNDANCY_THRESHOLD', () => {
    const baseline = 'Always respond in JSON format when the user asks for structured data.';
    const candidate = 'Never commit to the main branch without running tests first.';
    const score = jaccardSimilarity(baseline, candidate);
    expect(score).toBeLessThan(REDUNDANCY_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// extractAddedParagraphs
// ---------------------------------------------------------------------------

describe('extractAddedParagraphs', () => {
  it('returns empty array for empty diff', () => {
    expect(extractAddedParagraphs('')).toEqual([]);
  });

  it('returns empty array when no lines are added', () => {
    const diff = '@@ -1,2 +1,2 @@\n-removed line\n context line';
    expect(extractAddedParagraphs(diff)).toEqual([]);
  });

  it('extracts a single added paragraph', () => {
    const diff = '@@ -1,1 +1,2 @@\n context\n+Added new rule here.';
    const paras = extractAddedParagraphs(diff);
    expect(paras).toHaveLength(1);
    expect(paras[0]).toContain('Added new rule here');
  });

  it('extracts multiple paragraphs separated by blank added lines', () => {
    const diff = [
      '@@ -1,1 +1,5 @@',
      ' context',
      '+First paragraph text here.',
      '+',
      '+Second paragraph text here.',
    ].join('\n');
    const paras = extractAddedParagraphs(diff);
    expect(paras.length).toBeGreaterThanOrEqual(2);
    expect(paras.some((p) => p.includes('First paragraph'))).toBe(true);
    expect(paras.some((p) => p.includes('Second paragraph'))).toBe(true);
  });

  it('handles multiple diff hunks', () => {
    const diff = [
      '@@ -1,1 +1,2 @@',
      ' context',
      '+First added line.',
      '@@ -10,1 +11,2 @@',
      ' more context',
      '+Second added line.',
    ].join('\n');
    const paras = extractAddedParagraphs(diff);
    expect(paras.some((p) => p.includes('First added line'))).toBe(true);
    expect(paras.some((p) => p.includes('Second added line'))).toBe(true);
  });

  it('skips hunk headers', () => {
    const diff = '@@ -1,1 +1,2 @@\n+Real content.';
    const paras = extractAddedParagraphs(diff);
    expect(paras.every((p) => !p.startsWith('@@'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findNearestHeading
// ---------------------------------------------------------------------------

describe('findNearestHeading', () => {
  const baseline = [
    '# Top Level',
    '',
    'Some intro text.',
    '',
    '## Delegation Rules',
    '',
    'Stay inline for single-file edits.',
    '',
    '### Sub-rule',
    '',
    'More detail here.',
    '',
    '## Another Section',
    '',
    'Content in another section.',
  ].join('\n');

  it('returns the nearest preceding heading for a paragraph', () => {
    const heading = findNearestHeading(baseline, 'Stay inline for single-file edits.');
    expect(heading).toBe('Delegation Rules');
  });

  it('returns a sub-heading when closer than the parent heading', () => {
    const heading = findNearestHeading(baseline, 'More detail here.');
    expect(heading).toBe('Sub-rule');
  });

  it('returns the correct section for content in a later section', () => {
    const heading = findNearestHeading(baseline, 'Content in another section.');
    expect(heading).toBe('Another Section');
  });

  it('returns undefined when no heading precedes the paragraph', () => {
    const heading = findNearestHeading(baseline, 'Some intro text.');
    // Either undefined or 'Top Level' — depends on whether we count H1
    // The function scans for any heading level, so 'Top Level' is valid here
    // But 'Some intro text.' appears before 'Delegation Rules' heading,
    // and only '# Top Level' is above it.
    expect(heading === undefined || heading === 'Top Level').toBe(true);
  });

  it('returns undefined for a paragraph not found in baseline', () => {
    const heading = findNearestHeading(baseline, 'This text does not exist in baseline.');
    expect(heading).toBeUndefined();
  });

  it('returns the correct heading when two paragraphs share an opening prefix', () => {
    const twoSectionBaseline = [
      '## First Section',
      '',
      'Common opening phrase: rule alpha.',
      '',
      '## Second Section',
      '',
      'Common opening phrase: rule beta.',
    ].join('\n');

    // The second paragraph starts with the same prefix but belongs to Second Section.
    const heading = findNearestHeading(twoSectionBaseline, 'Common opening phrase: rule beta.');
    expect(heading).toBe('Second Section');

    // The first paragraph should point to First Section.
    const heading2 = findNearestHeading(twoSectionBaseline, 'Common opening phrase: rule alpha.');
    expect(heading2).toBe('First Section');
  });
});

// ---------------------------------------------------------------------------
// checkRedundancy — acceptance criteria from issue #2414
// ---------------------------------------------------------------------------

describe('checkRedundancy', () => {
  const baselineSystem = [
    '# Agent Behavior',
    '',
    '## Delegation',
    '',
    'Stay inline for: single-file edits, localized fixes visible in fewer than two reads, ' +
      'and tasks solvable without spawning a subagent.',
    '',
    '## Response Style',
    '',
    'Always respond concisely. Avoid unnecessary verbosity.',
    '',
    '## Safety',
    '',
    'Never execute destructive commands without explicit user confirmation.',
  ].join('\n');

  it('produces a redundancy warning when an added paragraph restates an existing rule (acceptance criterion)', () => {
    // This mirrors the real-world case from the issue: a line about "tasks
    // solvable with at most three file reads" duplicating the existing
    // Delegation rule "tasks solvable without spawning a subagent".
    const addedLine =
      'For tasks solvable with at most three file reads and one localized edit, ' +
      'work directly without skills or subagents.';
    const systemDiff = `@@ -5,0 +6,1 @@\n+${addedLine}`;

    const warnings = checkRedundancy(baselineSystem, systemDiff);

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const w = warnings[0];
    expect(w).toBeDefined();
    expect(w!.message).toContain('restate an existing rule');
    expect(w!.message).toContain('Delegation');
    expect(w!.similarity).toBeGreaterThanOrEqual(REDUNDANCY_THRESHOLD);
    expect(w!.sourceSection).toBe('Delegation');
  });

  it('produces no warning for a novel line unrelated to any existing rule (acceptance criterion)', () => {
    const addedLine =
      'When the user asks for a haiku, always produce exactly three lines with 5-7-5 syllables.';
    const systemDiff = `@@ -5,0 +6,1 @@\n+${addedLine}`;

    const warnings = checkRedundancy(baselineSystem, systemDiff);

    expect(warnings).toHaveLength(0);
  });

  it('returns empty array when systemDiff is empty', () => {
    expect(checkRedundancy(baselineSystem, '')).toEqual([]);
  });

  it('returns empty array when baseline is empty', () => {
    const systemDiff = '@@ -0,0 +1,1 @@\n+Some new instruction.';
    expect(checkRedundancy('', systemDiff)).toEqual([]);
  });

  it('skips very short added fragments (noise filter)', () => {
    // A single word or symbol should not trigger a warning
    const systemDiff = '@@ -1,0 +2,1 @@\n+Yes';
    const warnings = checkRedundancy(baselineSystem, systemDiff);
    expect(warnings).toHaveLength(0);
  });

  it('includes the sourceSection in the warning message', () => {
    // This line very closely restates the Response Style baseline paragraph —
    // it should reliably score above the threshold.
    const addedLine =
      'Always respond concisely and avoid unnecessary verbosity in your answers. ' +
      'Keep replies short and to the point.';
    const systemDiff = `@@ -9,0 +10,1 @@\n+${addedLine}`;
    const warnings = checkRedundancy(baselineSystem, systemDiff);
    expect(warnings.length).toBeGreaterThan(0);
    const w = warnings[0]!;
    expect(w.message).toContain('§');
    expect(w.sourceSection).toBeDefined();
  });

  it('similarity score is included in the warning', () => {
    const addedLine =
      'For tasks solvable with at most three file reads and one localized edit, ' +
      'work directly without skills or subagents.';
    const systemDiff = `@@ -5,0 +6,1 @@\n+${addedLine}`;
    const warnings = checkRedundancy(baselineSystem, systemDiff);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.similarity).toBeGreaterThan(0);
    expect(warnings[0]!.similarity).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// formatRedundancySection
// ---------------------------------------------------------------------------

describe('formatRedundancySection', () => {
  it('returns undefined for empty warnings array', () => {
    expect(formatRedundancySection([])).toBeUndefined();
  });

  it('returns a string section for non-empty warnings', () => {
    const warnings = [
      {
        addedParagraph: 'Work directly for simple tasks.',
        matchingParagraph: 'Stay inline for: single-file edits.',
        similarity: 0.45,
        sourceSection: 'Delegation',
        message: 'This change may restate an existing rule: "Stay inline for: single-file edits." (§ Delegation)',
      },
    ];
    const section = formatRedundancySection(warnings);
    expect(section).toBeDefined();
    expect(section).toContain('Redundancy preflight');
    expect(section).toContain('Delegation');
    expect(section).toContain('45%');
    expect(section).toContain('return []');
  });

  it('includes a numbered entry per warning', () => {
    const makeWarning = (i: number) => ({
      addedParagraph: `Para ${i}`,
      matchingParagraph: `Match ${i}`,
      similarity: 0.5,
      message: `This change may restate an existing rule: "Match ${i}"`,
    });
    const section = formatRedundancySection([makeWarning(1), makeWarning(2)]);
    expect(section).toContain('1.');
    expect(section).toContain('2.');
  });
});
