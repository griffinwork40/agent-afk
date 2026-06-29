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

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

describe('loadSkillPrompts — baseDir override (out-of-tree plugin support)', () => {
  // Simulate a plugin's own skills root: <root>/demo/prompts/*.md
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'afk-prompt-loader-'));
    const promptsDir = join(root, 'demo', 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(promptsDir, 'system.md'), 'system body');
    writeFileSync(join(promptsDir, 'agent.md'), 'agent body');
    writeFileSync(join(promptsDir, 'ignored.txt'), 'not markdown');
    // A sibling skill dir with no prompts/ subdir, to exercise that error path.
    mkdirSync(join(root, 'no-prompts'), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads prompts from the supplied baseDir, not the in-tree root', () => {
    const prompts = loadSkillPrompts('demo', root);
    expect(prompts['system.md']).toBe('system body');
    expect(prompts['agent.md']).toBe('agent body');
  });

  it('returns only .md files, keyed in alphabetical order', () => {
    const prompts = loadSkillPrompts('demo', root);
    expect(Object.keys(prompts)).toEqual(['agent.md', 'system.md']);
    expect(prompts).not.toHaveProperty('ignored.txt');
  });

  it('lists available skills from baseDir when the skill is unknown', () => {
    let msg = '';
    try {
      loadSkillPrompts('missing', root);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/Unknown skill: missing/);
    // The available list is derived from baseDir, surfacing the fixture skills.
    expect(msg).toMatch(/Available:.*demo/);
  });

  it('throws the no-prompts error for a baseDir skill missing prompts/', () => {
    expect(() => loadSkillPrompts('no-prompts', root)).toThrow(/has no prompts\/ dir/);
  });

  it('still enforces the path-traversal guard even with a baseDir', () => {
    expect(() => loadSkillPrompts('../escape', root)).toThrow(/illegal path component/i);
  });
});
