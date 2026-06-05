/**
 * Tests for multi-prompt loader that globs prompts/*.md from skill directories.
 */

import { describe, it, expect } from 'vitest';
import { loadSkillPrompts } from './_lib/prompt-loader.js';

describe('loadSkillPrompts', () => {
  it('loads all .md files from prompts/ dir in alphabetical key order', () => {
    const prompts = loadSkillPrompts('example-template');
    expect(prompts).toHaveProperty('system.md');
    expect(prompts).toHaveProperty('user.md');
    expect(Object.keys(prompts)).toEqual(['system.md', 'user.md']);
  });

  it('returns non-empty string values for each prompt', () => {
    const prompts = loadSkillPrompts('example-template');
    expect(typeof prompts['system.md']).toBe('string');
    expect(typeof prompts['user.md']).toBe('string');
    expect(prompts['system.md'].length).toBeGreaterThan(0);
    expect(prompts['user.md'].length).toBeGreaterThan(0);
  });

  it('maintains stable alphabetical order across multiple calls', () => {
    const prompts1 = loadSkillPrompts('example-template');
    const prompts2 = loadSkillPrompts('example-template');
    expect(Object.keys(prompts1)).toEqual(Object.keys(prompts2));
  });

  it('throws Error with message containing "Unknown skill" when skill does not exist', () => {
    expect(() => loadSkillPrompts('does-not-exist')).toThrow(/Unknown skill/);
  });

  it('includes available skill names in error message for unknown skill', () => {
    expect(() => loadSkillPrompts('does-not-exist')).toThrow(/Available:/);
  });

  it('includes example-template in available skills list', () => {
    try {
      loadSkillPrompts('does-not-exist');
    } catch (e) {
      const error = e as Error;
      expect(error.message).toContain('example-template');
    }
  });
});
