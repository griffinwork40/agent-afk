/**
 * Tests for loadSkillPrompts — covering the P3 path-traversal guard added in PR-14.
 *
 * The guard rejects any `name` that:
 *   - contains '/' (directory separator)
 *   - contains '\\' (Windows directory separator)
 *   - starts with '.' (dot-relative or hidden name)
 *   - contains '..' (parent directory traversal)
 *
 * A legitimate skill name like 'forge' or 'valid-skill' must NOT be rejected
 * by the guard — it may still throw later because the skill doesn't exist on
 * disk (e.g. in CI without a full build), but the error must be about the
 * skill being unknown, not about illegal path components.
 *
 * @module skills/_lib/prompt-loader.test
 */

import { describe, it, expect } from 'vitest';
import { loadSkillPrompts } from './prompt-loader.js';

describe('P3 — loadSkillPrompts path-traversal guard', () => {
  it('throws for "../evil" (parent-traversal prefix)', () => {
    expect(() => loadSkillPrompts('../evil')).toThrow(/illegal path component/i);
  });

  it('throws for "foo/bar" (slash in name)', () => {
    expect(() => loadSkillPrompts('foo/bar')).toThrow(/illegal path component/i);
  });

  it('throws for ".." (bare double-dot)', () => {
    expect(() => loadSkillPrompts('..')).toThrow(/illegal path component/i);
  });

  it('throws for "." (bare single-dot)', () => {
    expect(() => loadSkillPrompts('.')).toThrow(/illegal path component/i);
  });

  it('throws for ".hidden" (starts with dot)', () => {
    expect(() => loadSkillPrompts('.hidden')).toThrow(/illegal path component/i);
  });

  it('throws for "foo\\\\bar" (backslash in name)', () => {
    expect(() => loadSkillPrompts('foo\\bar')).toThrow(/illegal path component/i);
  });

  it('throws for "a/../../etc/passwd" (multi-segment traversal)', () => {
    expect(() => loadSkillPrompts('a/../../etc/passwd')).toThrow(/illegal path component/i);
  });

  it('does NOT throw the path-traversal error for a plain valid name', () => {
    // A simple alphanumeric name should pass the guard. It may throw later
    // because the skill doesn't exist in the test environment, but the
    // error must NOT be about illegal path components.
    try {
      loadSkillPrompts('valid-skill-name');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/illegal path component/i);
    }
  });

  it('does NOT throw the path-traversal error for a hyphenated skill name', () => {
    try {
      loadSkillPrompts('gather');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/illegal path component/i);
    }
  });

  it('does NOT throw the path-traversal error for a name with digits', () => {
    try {
      loadSkillPrompts('skill123');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/illegal path component/i);
    }
  });
});
