/**
 * Tests for probe-grounding.ts
 *
 * Acceptance test: with a manifest of only .ts/.md files, a returned probe
 * referencing src/main.py is dropped before episodes are built.
 */

import { describe, it, expect } from 'vitest';
import { extractPathTokens, groundProbes, makeSetChecker } from './probe-grounding.js';

// ---------------------------------------------------------------------------
// extractPathTokens
// ---------------------------------------------------------------------------

describe('extractPathTokens', () => {
  it('detects slash-separated path', () => {
    const tokens = extractPathTokens('Please edit src/main.py for me');
    expect(tokens).toContain('src/main.py');
  });

  it('detects bare extension file', () => {
    const tokens = extractPathTokens('Look at config.yaml please');
    expect(tokens).toContain('config.yaml');
  });

  it('detects multiple path tokens', () => {
    const tokens = extractPathTokens('Edit src/index.ts and README.md');
    expect(tokens).toContain('src/index.ts');
    expect(tokens).toContain('README.md');
  });

  it('ignores regular natural language words', () => {
    const tokens = extractPathTokens('Please help me with this project');
    expect(tokens).toEqual([]);
  });

  it('ignores node.js as a false positive', () => {
    const tokens = extractPathTokens('I am using node.js for this');
    expect(tokens).toEqual([]);
  });

  it('ignores URLs', () => {
    const tokens = extractPathTokens('See https://example.com/foo.py for details');
    expect(tokens).toEqual([]);
  });

  it('strips surrounding backticks and quotes', () => {
    const tokens = extractPathTokens('Edit `src/utils.ts` now');
    expect(tokens).toContain('src/utils.ts');
  });

  it('returns empty array for probe with no path references', () => {
    const tokens = extractPathTokens('Can you help me understand how to use the tool?');
    expect(tokens).toEqual([]);
  });

  it('handles e.g. as false positive', () => {
    const tokens = extractPathTokens('some tokens e.g. ignored');
    expect(tokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// makeSetChecker
// ---------------------------------------------------------------------------

describe('makeSetChecker', () => {
  it('returns true for paths in the set', () => {
    const checker = makeSetChecker(new Set(['src/index.ts', 'README.md']));
    expect(checker('src/index.ts')).toBe(true);
    expect(checker('README.md')).toBe(true);
  });

  it('returns false for paths not in the set', () => {
    const checker = makeSetChecker(new Set(['src/index.ts']));
    expect(checker('src/main.py')).toBe(false);
  });

  it('passes everything when set is empty (outside git)', () => {
    const checker = makeSetChecker(new Set());
    expect(checker('src/main.py')).toBe(true);
    expect(checker('anything.txt')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// groundProbes — acceptance test
// ---------------------------------------------------------------------------

describe('groundProbes', () => {
  // Manifest that only contains .ts and .md files (TypeScript project)
  const tsOnlyChecker = makeSetChecker(
    new Set(['src/index.ts', 'src/utils.ts', 'README.md', 'package.json']),
  );

  it('drops probe referencing src/main.py (acceptance test)', () => {
    const predictions = [
      {
        id: 'p1',
        behavior: 'reads a python file',
        direction: 'added' as const,
        confidence: 'medium' as const,
        reason: 'r',
        testQuestion: 'Does it?',
        probes: ['Please read src/main.py and summarize it'],
      },
    ];

    const { predictions: grounded, droppedProbes } = groundProbes(predictions, tsOnlyChecker);

    // The probe should be dropped
    expect(grounded[0]!.probes).toHaveLength(0);
    expect(droppedProbes).toHaveLength(1);
    expect(droppedProbes[0]!.predictionId).toBe('p1');
    expect(droppedProbes[0]!.probe).toBe('Please read src/main.py and summarize it');
    expect(droppedProbes[0]!.reason).toContain('src/main.py');
  });

  it('keeps probes that reference only real paths', () => {
    const predictions = [
      {
        id: 'p1',
        behavior: 'reads a real ts file',
        direction: 'added' as const,
        confidence: 'high' as const,
        reason: 'r',
        testQuestion: 'Does it?',
        probes: ['Please review src/index.ts'],
      },
    ];

    const { predictions: grounded, droppedProbes } = groundProbes(predictions, tsOnlyChecker);

    expect(grounded[0]!.probes).toHaveLength(1);
    expect(droppedProbes).toHaveLength(0);
  });

  it('keeps probes with no path references', () => {
    const predictions = [
      {
        id: 'p1',
        behavior: 'answers a general question',
        direction: 'added' as const,
        confidence: 'high' as const,
        reason: 'r',
        testQuestion: 'Does it?',
        probes: ['Can you help me understand how this project works?'],
      },
    ];

    const { predictions: grounded, droppedProbes } = groundProbes(predictions, tsOnlyChecker);

    expect(grounded[0]!.probes).toHaveLength(1);
    expect(droppedProbes).toHaveLength(0);
  });

  it('partially drops probes — keeps valid ones, drops invalid ones', () => {
    const predictions = [
      {
        id: 'p1',
        behavior: 'mixed probes',
        direction: 'strengthened' as const,
        confidence: 'medium' as const,
        reason: 'r',
        testQuestion: 'Does it?',
        probes: [
          'Review README.md and tell me what it says',  // real path → keep
          'Please look at config.yaml for the settings', // fake path → drop
          'What can you help me with?',                   // no path → keep
        ],
      },
    ];

    const { predictions: grounded, droppedProbes } = groundProbes(predictions, tsOnlyChecker);

    expect(grounded[0]!.probes).toHaveLength(2);
    expect(grounded[0]!.probes).toContain('Review README.md and tell me what it says');
    expect(grounded[0]!.probes).toContain('What can you help me with?');
    expect(droppedProbes).toHaveLength(1);
    expect(droppedProbes[0]!.reason).toContain('config.yaml');
  });

  it('handles predictions that all probes are dropped — probes become []', () => {
    const predictions = [
      {
        id: 'p1',
        behavior: 'all bad',
        direction: 'removed' as const,
        confidence: 'low' as const,
        reason: 'r',
        testQuestion: 'Does it?',
        probes: ['Edit src/main.py', 'Edit utils.py'],
      },
    ];

    const { predictions: grounded, droppedProbes } = groundProbes(predictions, tsOnlyChecker);

    // prediction is retained (probes: []) so downstream doesn't break
    expect(grounded).toHaveLength(1);
    expect(grounded[0]!.probes).toHaveLength(0);
    expect(droppedProbes).toHaveLength(2);
  });

  it('drops probes referencing multiple bad paths (all mentioned in issue)', () => {
    const badProbes = [
      'Read src/main.py',
      'Check config.yaml',
      'Look at utils.py',
      'Check settings.json debug flag',
      'Is Python 3.8 in README.md',
    ];

    const predictions = [
      {
        id: 'p1',
        behavior: 'references nonexistent files',
        direction: 'added' as const,
        confidence: 'medium' as const,
        reason: 'r',
        testQuestion: 'Does it?',
        probes: badProbes,
      },
    ];

    const { predictions: grounded, droppedProbes } = groundProbes(predictions, tsOnlyChecker);

    // config.yaml, utils.py, src/main.py — all fake; README.md is real; settings.json is not tracked
    const keptProbes = grounded[0]!.probes;
    expect(keptProbes).not.toContain('Read src/main.py');
    expect(keptProbes).not.toContain('Check config.yaml');
    expect(keptProbes).not.toContain('Look at utils.py');
    // droppedProbes should have entries
    expect(droppedProbes.length).toBeGreaterThan(0);
  });

  it('passes everything when checker always returns true (empty set / outside git)', () => {
    const passthroughChecker = makeSetChecker(new Set());
    const predictions = [
      {
        id: 'p1',
        behavior: 'b',
        direction: 'added' as const,
        confidence: 'low' as const,
        reason: 'r',
        testQuestion: 'Does it?',
        probes: ['Edit src/main.py'],
      },
    ];

    const { predictions: grounded, droppedProbes } = groundProbes(predictions, passthroughChecker);

    expect(grounded[0]!.probes).toHaveLength(1);
    expect(droppedProbes).toHaveLength(0);
  });

  it('records dropped probes with correct predictionId and reason', () => {
    const predictions = [
      {
        id: 'p3',
        behavior: 'b',
        direction: 'weakened' as const,
        confidence: 'low' as const,
        reason: 'r',
        testQuestion: 'Does it?',
        probes: ['Look at debug.py for hints'],
      },
    ];

    const { droppedProbes } = groundProbes(predictions, tsOnlyChecker);

    expect(droppedProbes[0]!.predictionId).toBe('p3');
    expect(droppedProbes[0]!.reason).toMatch(/non-existent path/);
  });
});
