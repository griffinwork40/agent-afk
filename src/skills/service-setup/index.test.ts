/**
 * Registration + metadata tests for the `service-setup` skill.
 *
 * The skill is `context: 'fork'` so the real flow is exercised end-to-end
 * by SkillExecutor's fork pathway (covered elsewhere). Here we verify the
 * skill is registered, its metadata is shaped correctly, and its handler
 * refuses direct invocation — mirroring the test contract used for the
 * sibling `telegram-setup` fork skill.
 */

import { describe, test, expect } from 'vitest';
import { getSkill, listSkills } from '../index.js';

// Import for registration side-effect.
import './index.js';

describe('service-setup skill registration', () => {
  test('is registered with name "service-setup"', () => {
    expect(listSkills()).toContain('service-setup');
  });

  test('is a fork skill', () => {
    const skill = getSkill('service-setup');
    expect(skill.context).toBe('fork');
  });

  test('has whenToUse guidance for the model', () => {
    const skill = getSkill('service-setup');
    expect(skill.whenToUse).toBeDefined();
    expect(skill.whenToUse).toMatch(/always-on|service|launchd|auto-start/i);
  });

  test('description names the macOS LaunchAgent surface and pre-flight intent', () => {
    const skill = getSkill('service-setup');
    expect(skill.description).toMatch(/launchagent|launchd|macOS/i);
    // Surfaces to the model that pre-flight prevents crash loops — if this
    // ever drifts, the prompt's hard-rule contract may be at risk.
    expect(skill.description).toMatch(/pre-flight|crash|token|valid/i);
  });

  test('handler throws if invoked directly (fork-only contract)', async () => {
    const skill = getSkill('service-setup');
    await expect(skill.handler(undefined)).rejects.toThrow(/fork/i);
  });

  test('no flags declared (skill takes no positional flags)', () => {
    const skill = getSkill('service-setup');
    expect(skill.flags).toBeUndefined();
  });
});
