/**
 * Unit tests for src/utils/skill-md.ts
 *
 * Covers parser edge-cases that are not exercised by the higher-level
 * integration suites (plugin-skills-discovery-flags, plugin-skills-harvest-flat).
 *
 * Finding #3430:
 *   - nit · test-coverage: inline `flags: --foo` (non-bracket scalar form)
 *     falls back to body scan — no test existed for this path.
 *   - low · security: block-form flag items are validated against FLAG_REGEX;
 *     entries like `--foo; rm -rf /` are dropped.
 *   - nit: body-scan flag count is capped at 64.
 */

import { describe, it, expect } from 'vitest';
import {
  parseFlagsField,
  extractFlagsFromBody,
  resolveSkillFlags,
  harvestFlagsFromSkillMd,
} from './skill-md.js';

describe('parseFlagsField — inline non-bracket scalar form (#3430)', () => {
  it('returns null for `flags: --foo` (scalar, not bracket form) so body-scan fallback fires', () => {
    // The non-bracket scalar form `flags: --foo` is not a valid YAML list, so
    // parseFlagsField intentionally returns null, which makes resolveSkillFlags
    // fall through to the body/argument-hint scan.
    const result = parseFlagsField('--foo', []);
    expect(result).toBeNull();
  });

  it('harvestFlagsFromSkillMd falls back to body scan when flags: uses scalar form', () => {
    const content = `---
name: my-skill
description: "Does stuff."
flags: --body-fallback
---

Use --from-body to trigger things.
`;
    // flags: --body-fallback is a scalar value — not bracket, not block.
    // parseFlagsField returns null → resolveSkillFlags falls through to body scan.
    const flags = harvestFlagsFromSkillMd(content);
    expect(flags).toContain('--from-body');
    // The scalar string `--body-fallback` is NOT added as a flag entry.
    expect(flags).not.toContain('--body-fallback');
  });
});

describe('parseFlagsField — security: block-form items validated against FLAG_REGEX (#3430)', () => {
  it('drops block-form items containing shell metacharacters', () => {
    const followingLines = [
      '  - --safe-flag',
      '  - --foo; rm -rf /',
      '  - --another-safe',
      '  - --bad && echo hi',
    ];
    const result = parseFlagsField('', followingLines);
    expect(result).toEqual(['--another-safe', '--safe-flag']);
  });

  it('drops inline-form items containing shell metacharacters', () => {
    const result = parseFlagsField('[--safe, --foo; rm -rf /, --also-safe]', []);
    expect(result).toEqual(['--also-safe', '--safe']);
  });

  it('returns null when all items are invalid after validation', () => {
    // Both entries contain shell metacharacters and fail VALID_FLAG_EXACT.
    const followingLines = ['  - --foo; rm -rf /', '  - --bad&&echo'];
    const result = parseFlagsField('', followingLines);
    expect(result).toBeNull();
  });
});

describe('parseFlagsField — dedupe (#3460)', () => {
  it('dedupes duplicate flags in inline form, preserving first-seen order before sort', () => {
    const result = parseFlagsField('[--beta, --alpha, --beta, --alpha]', []);
    // Duplicates removed; result is sorted alphabetically.
    expect(result).toEqual(['--alpha', '--beta']);
  });

  it('dedupes duplicate flags in block form, preserving first-seen order before sort', () => {
    const followingLines = [
      '  - --gamma',
      '  - --alpha',
      '  - --gamma',
      '  - --beta',
      '  - --alpha',
    ];
    const result = parseFlagsField('', followingLines);
    expect(result).toEqual(['--alpha', '--beta', '--gamma']);
  });
});

describe('extractFlagsFromBody — body scan capped at 64 (#3430)', () => {
  it('returns at most 64 flags from the body', () => {
    // Generate 80 unique flag-like strings in the body.
    const body = Array.from({ length: 80 }, (_, i) => `--flag-${i.toString().padStart(2, '0')}`).join(' ');
    const flags = extractFlagsFromBody(body);
    expect(flags).toHaveLength(64);
  });

  it('returns all flags when body has fewer than 64', () => {
    const body = '--alpha --beta --gamma';
    const flags = extractFlagsFromBody(body);
    expect(flags).toEqual(['--alpha', '--beta', '--gamma']);
  });
});

describe('resolveSkillFlags — null vs [] contract (#3430)', () => {
  it('null frontmatterFlags falls through to body scan', () => {
    const flags = resolveSkillFlags(null, undefined, '--from-body');
    expect(flags).toContain('--from-body');
  });

  it('empty array frontmatterFlags falls through to body scan', () => {
    const flags = resolveSkillFlags([], undefined, '--from-body');
    expect(flags).toContain('--from-body');
  });

  it('non-empty frontmatterFlags wins over body scan', () => {
    const flags = resolveSkillFlags(['--from-fm'], undefined, '--from-body');
    expect(flags).toEqual(['--from-fm']);
    expect(flags).not.toContain('--from-body');
  });

  it('always returns string[] (never null)', () => {
    const result = resolveSkillFlags(null, undefined, '');
    expect(Array.isArray(result)).toBe(true);
  });
});
