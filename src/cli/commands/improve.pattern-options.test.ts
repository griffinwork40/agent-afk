/**
 * Regression guard for `afk improve ... --pattern` validation.
 *
 * History: the CLI hand-maintained a copy of the failure-pattern list. Sprint 2
 * added `tool-failure-density` and `subagent-read-denial` to
 * `FailurePatternSchema` but not to the copy, so
 * `afk improve eval-cases list --pattern tool-failure-density` exited 2 with
 * "Invalid --pattern" while four eval-cases on disk used exactly that pattern.
 *
 * The fix derives the list from the schema, making the drift structurally
 * impossible. These tests fail if anyone reintroduces a hand-maintained literal.
 */

import { describe, it, expect } from 'vitest';
import { VALID_PATTERNS } from './improve/index.js';
import { FailurePatternSchema } from '../../improve/schemas.js';

describe('improve --pattern accepted values', () => {
  it('accepts every pattern the canonical schema defines', () => {
    expect([...VALID_PATTERNS].sort()).toEqual([...FailurePatternSchema.options].sort());
  });

  it('accepts the two patterns that the drifted hand-copy rejected', () => {
    // Named explicitly: these are the exact values that produced the live
    // exit-2 bug, so a future truncation of the list cannot pass silently.
    expect(VALID_PATTERNS).toContain('tool-failure-density');
    expect(VALID_PATTERNS).toContain('subagent-read-denial');
  });

  it('is not a truncated subset of the schema', () => {
    expect(VALID_PATTERNS.length).toBe(FailurePatternSchema.options.length);
    expect(VALID_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });

  it('contains only values the schema will parse', () => {
    for (const pattern of VALID_PATTERNS) {
      expect(() => FailurePatternSchema.parse(pattern)).not.toThrow();
    }
  });
});
