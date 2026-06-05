/**
 * Tests for the public/internal tier gate on skills.
 *
 * Covers:
 *   1. `isSkillVisible` policy — public always visible, internal gated by
 *      `internalUnlocked`, absent audience treated as public.
 *   2. Built-in tier assignments — forge / audit-fit are 'internal',
 *      diagnose / mint are public. Load-bearing for the whole split:
 *      if these regress, end users see maintainer commands in /help.
 *   3. SkillMetadata round-trip — the `audience` field survives
 *      `registerSkill` → `getSkill` without mutation.
 *
 * Order matters: the built-in assertions run before any `_resetRegistry()`
 * fires, because barrel-import side-effects can't re-register on the
 * second import (ESM module caching).
 */

// Top-level barrel import triggers all built-in skill registrations once.
// MUST come before the test bodies that read the registry.
import './all.js';

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSkill,
  getSkill,
  isSkillVisible,
  _resetRegistry,
  type SkillMetadata,
} from './index.js';

describe('Skill audience tier gate', () => {
  // Pure-policy tests — no registry interaction.
  describe('isSkillVisible policy', () => {
    it('public-audience skill is visible when tier is locked', () => {
      expect(isSkillVisible({ audience: 'public' }, false)).toBe(true);
    });

    it('public-audience skill is visible when tier is unlocked', () => {
      expect(isSkillVisible({ audience: 'public' }, true)).toBe(true);
    });

    it('internal-audience skill is hidden when tier is locked', () => {
      expect(isSkillVisible({ audience: 'internal' }, false)).toBe(false);
    });

    it('internal-audience skill is visible when tier is unlocked', () => {
      expect(isSkillVisible({ audience: 'internal' }, true)).toBe(true);
    });

    it('absent audience defaults to public (visible when locked)', () => {
      expect(isSkillVisible({}, false)).toBe(true);
    });

    it('absent audience is visible when unlocked', () => {
      expect(isSkillVisible({}, true)).toBe(true);
    });
  });

  // Built-in tier assignments — must run BEFORE any `_resetRegistry()`.
  // These rely on the top-level barrel import having registered everything
  // exactly once. No beforeEach reset here.
  describe('built-in skill tier assignments (load-bearing)', () => {
    it('audit-fit is registered as audience: "internal"', () => {
      expect(getSkill('audit-fit').audience).toBe('internal');
    });

    it('diagnose is registered as public (absent or "public")', () => {
      const a = getSkill('diagnose').audience;
      expect(a === undefined || a === 'public').toBe(true);
    });

    it('mint is registered as public (absent or "public")', () => {
      const a = getSkill('mint').audience;
      expect(a === undefined || a === 'public').toBe(true);
    });
  });

  // Round-trip tests reset the registry between cases, so they run LAST
  // — after the built-in tier assertions consume the populated registry.
  describe('SkillMetadata round-trip', () => {
    beforeEach(() => {
      _resetRegistry();
    });

    it('preserves audience: "internal" through register → get', () => {
      const meta: SkillMetadata = {
        name: 'internal-test',
        description: 'Internal-only skill for testing',
        handler: async () => 'ok',
        audience: 'internal',
      };
      registerSkill(meta);
      expect(getSkill('internal-test').audience).toBe('internal');
    });

    it('preserves audience: "public" through register → get', () => {
      registerSkill({
        name: 'public-test',
        description: 'Public skill for testing',
        handler: async () => 'ok',
        audience: 'public',
      });
      expect(getSkill('public-test').audience).toBe('public');
    });

    it('omits audience when not provided (default public)', () => {
      registerSkill({
        name: 'default-test',
        description: 'Skill without explicit audience',
        handler: async () => 'ok',
      });
      expect(getSkill('default-test').audience).toBeUndefined();
    });
  });
});
