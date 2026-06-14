/**
 * Registration + metadata tests for the `get-started` onboarding skill.
 *
 * Unlike the sibling `telegram-setup` / `service-setup` fork skills, this one
 * is `context: 'load'` — it must run in the CURRENT session so it can ask the
 * user, recommend slash commands, dispatch setup sub-skills, and leave state in
 * the caller's context. We assert the metadata contract + that the prompt body
 * encodes the load-bearing steps of the flow; the interactive flow itself is
 * model behavior and not deterministically testable.
 */

import { describe, test, expect } from 'vitest';
import { getSkill, listSkills } from '../index.js';
import { loadSkillPrompts } from '../_lib/prompt-loader.js';

// Import for registration side-effect.
import './index.js';

describe('get-started skill registration', () => {
  test('is registered with name "get-started"', () => {
    expect(listSkills()).toContain('get-started');
  });

  test('is a public, load-mode skill (the linchpin: runs in the current session, not a fork)', () => {
    const skill = getSkill('get-started');
    expect(skill.context).toBe('load');
    expect(skill.audience).toBe('public');
    expect(skill.description.length).toBeGreaterThan(40);
    expect(skill.whenToUse).toBeTruthy();
  });

  test('handler throws if ever called (load skills never invoke it)', async () => {
    const skill = getSkill('get-started');
    await expect(skill.handler({})).rejects.toThrow(/load skill/i);
  });
});

describe('get-started prompt body', () => {
  test('resolves a non-empty system.md', () => {
    const prompts = loadSkillPrompts('get-started');
    expect((prompts['system.md'] ?? '').length).toBeGreaterThan(500);
  });

  test('encodes the load-bearing flow steps', () => {
    const body = loadSkillPrompts('get-started')['system.md'] ?? '';

    // Surface gate — don't ask on non-interactive surfaces.
    expect(body).toContain('get_runtime_state');
    // Preflight via the doctor JSON mode + an explicit git check.
    expect(body).toContain('afk doctor -f json');
    expect(body).toContain('git rev-parse');
    // Name persisted to hot memory (survives /clear).
    expect(body).toContain('memory_update');
    // Migration via the non-interactive flag paths only (never interactive `afk migrate`).
    expect(body).toContain('afk migrate --dry-run');
    expect(body).toContain('afk migrate -y');
    // Capability setup delegates to the existing setup sub-skills.
    expect(body).toContain('/telegram-setup');
    expect(body).toContain('/service-setup');
    // Project context (/init) MUST be recommended before the save point (/clear).
    const initIdx = body.indexOf('/init');
    const clearIdx = body.indexOf('/clear');
    expect(initIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(-1);
    expect(initIdx).toBeLessThan(clearIdx);
  });
});
