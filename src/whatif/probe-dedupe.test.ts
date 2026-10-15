/**
 * Tests for probe-dedupe.ts
 */

import { describe, it, expect } from 'vitest';
import { dedupeProbes } from './probe-dedupe.js';

describe('dedupeProbes', () => {
  it('keeps all probes when none are duplicates', () => {
    const probes = [
      'Fix the bug in auth.ts',
      'Add a test for the login flow',
      'Refactor the database module',
    ];
    const { kept, dropped } = dedupeProbes(probes);
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });

  it('drops exact duplicates (case-insensitive)', () => {
    const probes = ['Fix the bug in auth.ts', 'Fix the Bug in Auth.ts', 'Different task'];
    const { kept, dropped } = dedupeProbes(probes);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1);
    expect(dropped).toContain('Fix the Bug in Auth.ts');
  });

  it('drops exact duplicates ignoring punctuation', () => {
    const probes = [
      'Can you help me fix this?',
      'Can you help me fix this',
      'A different request.',
    ];
    const { kept, dropped } = dedupeProbes(probes);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1);
  });

  it('drops near-duplicates by Jaccard >= 0.8', () => {
    // High overlap — should be dropped
    const probes = [
      'Please refactor the authentication module',
      'Please refactor the authentication module now',
    ];
    const { kept, dropped } = dedupeProbes(probes);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(kept[0]).toBe('Please refactor the authentication module');
  });

  it('keeps near-but-distinct probes below the threshold', () => {
    // Low enough overlap to be kept
    const probes = [
      'Write a unit test for the login endpoint',
      'Refactor the database connection pooling logic',
    ];
    const { kept, dropped } = dedupeProbes(probes);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it('preserves order (keeps first occurrence)', () => {
    const probes = ['A', 'B', 'A'];
    const { kept } = dedupeProbes(probes);
    expect(kept).toEqual(['A', 'B']);
  });

  it('handles empty input', () => {
    const { kept, dropped } = dedupeProbes([]);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(0);
  });

  it('handles a single probe', () => {
    const { kept, dropped } = dedupeProbes(['Only one probe here']);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('respects a custom threshold', () => {
    // These two would be dropped at threshold 0.5 but kept at threshold 0.9
    const probes = [
      'Help me with the authentication flow',
      'Help me with the authorization flow',
    ];
    const { kept: keptLoose } = dedupeProbes(probes, 0.5);
    const { kept: keptStrict } = dedupeProbes(probes, 0.9);
    // At 0.9 both are kept because they differ (authorization vs authentication)
    expect(keptStrict).toHaveLength(2);
    // At 0.5 the near-duplicate is dropped
    expect(keptLoose).toHaveLength(1);
  });

  it('collapses extra whitespace during normalisation', () => {
    const probes = ['fix  the  bug', 'fix the bug'];
    const { kept, dropped } = dedupeProbes(probes);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });
});
