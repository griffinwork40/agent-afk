/**
 * Tests for skill registry and metadata.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerSkill,
  getSkill,
  listSkills,
  _resetRegistry,
  type SkillMetadata,
} from './index.js';

describe('Skill Registry', () => {
  beforeEach(() => {
    _resetRegistry();
  });

  it('registers a skill and retrieves it by name', () => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    const meta: SkillMetadata = {
      name: 'test-skill',
      description: 'Test skill for unit tests',
      handler,
    };

    registerSkill(meta);
    const retrieved = getSkill('test-skill');

    expect(retrieved.name).toBe('test-skill');
    expect(retrieved.description).toBe('Test skill for unit tests');
    expect(retrieved.handler).toBe(handler);
  });

  it('lists all registered skills', () => {
    const meta1: SkillMetadata = {
      name: 'skill-1',
      description: 'First skill',
      handler: vi.fn(),
    };
    const meta2: SkillMetadata = {
      name: 'skill-2',
      description: 'Second skill',
      handler: vi.fn(),
    };

    registerSkill(meta1);
    registerSkill(meta2);

    const skills = listSkills();
    expect(skills).toHaveLength(2);
    expect(skills).toContain('skill-1');
    expect(skills).toContain('skill-2');
  });

  it('throws Error with "Available skills:" message when skill not found', () => {
    const handler = vi.fn();
    registerSkill({
      name: 'existing-skill',
      description: 'An existing skill',
      handler,
    });

    expect(() => getSkill('unknown')).toThrow(/Available skills:/);
  });

  it('includes available skill names in error message', () => {
    registerSkill({
      name: 'skill-alpha',
      description: 'Alpha',
      handler: vi.fn(),
    });
    registerSkill({
      name: 'skill-beta',
      description: 'Beta',
      handler: vi.fn(),
    });

    try {
      getSkill('unknown');
    } catch (e) {
      const error = e as Error;
      expect(error.message).toContain('skill-alpha');
      expect(error.message).toContain('skill-beta');
    }
  });

  it('resets registry between tests (internal _resetRegistry)', () => {
    registerSkill({
      name: 'temp-skill',
      description: 'Temporary',
      handler: vi.fn(),
    });
    expect(listSkills()).toContain('temp-skill');

    _resetRegistry();

    expect(listSkills()).not.toContain('temp-skill');
    expect(listSkills().length).toBe(0);
  });
});
