/**
 * Registration + metadata tests for the `telegram-setup` skill.
 *
 * The skill is `context: 'fork'` so the real flow is exercised end-to-end by
 * SkillExecutor's fork pathway (covered in skill-executor.test.ts with its
 * own fork fixtures). Here we verify:
 *
 *   1. Importing the module registers the skill in the global registry.
 *   2. Metadata is shaped correctly: fork context, no flags, has whenToUse,
 *      no handler that would expose secrets.
 *   3. The handler throws if accidentally called (defense against a future
 *      executor regression that bypasses the fork branch).
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { getSkill, listSkills } from '../index.js';

// Import for registration side-effect.
import './index.js';

describe('telegram-setup skill registration', () => {
  beforeAll(() => {
    // No reset — we want the side-effect import to populate the registry.
  });

  test('is registered with name "telegram-setup"', () => {
    expect(listSkills()).toContain('telegram-setup');
  });

  test('is a fork skill', () => {
    const skill = getSkill('telegram-setup');
    expect(skill.context).toBe('fork');
  });

  test('has whenToUse guidance for the model', () => {
    const skill = getSkill('telegram-setup');
    expect(skill.whenToUse).toBeDefined();
    expect(skill.whenToUse).toMatch(/telegram/i);
  });

  test('description warns against token leakage (informational)', () => {
    // Surfaces the skill's purpose to the model in the manifest; if this
    // wording ever drifts, the prompt-discipline contract may be at risk.
    const skill = getSkill('telegram-setup');
    expect(skill.description).toMatch(/token/i);
    expect(skill.description).toMatch(/never|without|isolat|leak/i);
  });

  test('handler throws if invoked directly (fork-only contract)', async () => {
    const skill = getSkill('telegram-setup');
    await expect(skill.handler(undefined)).rejects.toThrow(/fork/i);
  });

  test('no flags declared (skill takes no positional args)', () => {
    const skill = getSkill('telegram-setup');
    expect(skill.flags).toBeUndefined();
  });
});
