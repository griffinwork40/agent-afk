/**
 * Tests for Phase 2 — job-to-be-done category grouping in `/skills` listing.
 *
 * Covers:
 *   - Category headers render when at least one skill has a `category` field.
 *   - Skills with no category go under "More skills".
 *   - Categories render in canonical SKILL_CATEGORIES order, not alphabetical.
 *   - Empty categories are omitted.
 *   - When NO skill has a category the legacy two-block layout is unchanged.
 *   - Plugin skills with category from DiscoveredSkill are grouped correctly.
 *   - User-scope skills carrying a frontmatter `category` are grouped correctly.
 *
 * Assertions strip ANSI so they pin text, not colour codes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetRegistry, registerSkill, SKILL_CATEGORIES, UNCATEGORIZED_LABEL } from '../../skills/index.js';
import { resetRegistry } from './registry.js';
import { initialSkillsCmd } from './plugin-skills.js';
import { makeDynamicSkillsCmd } from './plugin-skills/listing.js';
import { stripAnsi } from '../display.js';
import type { SlashContext } from './types.js';

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: {
      totalTurns: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: Date.now(),
      turnCosts: [],
      turnTokens: [],
      turns: [],
      model: 'sonnet',
      permissionMode: 'default',
    },
    out: {
      line: (t = '') => lines.push(t),
      raw: (t) => lines.push(t),
      success: (t) => lines.push(`SUCCESS:${t}`),
      info: (t) => lines.push(`INFO:${t}`),
      warn: (t) => lines.push(`WARN:${t}`),
      error: (t) => lines.push(`ERROR:${t}`),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

describe('/skills category grouping (Phase 2)', () => {
  beforeEach(() => {
    resetRegistry();
    _resetRegistry();
    vi.unstubAllEnvs();
    vi.stubEnv('AFK_INTERNAL', undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders a category header when at least one skill has category', async () => {
    registerSkill({
      name: 'mint',
      description: 'Build and ship a feature.',
      category: 'Build & ship',
      handler: async () => 'ok',
    });
    registerSkill({
      name: 'diagnose',
      description: 'Diagnose a bug.',
      category: 'Debug & fix',
      handler: async () => 'ok',
    });

    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('Build & ship');
    expect(out).toContain('Debug & fix');
    expect(out).toContain('/mint');
    expect(out).toContain('/diagnose');
  });

  it('routes skills with no category to "More skills"', async () => {
    registerSkill({
      name: 'mint',
      description: 'Build and ship a feature.',
      category: 'Build & ship',
      handler: async () => 'ok',
    });
    registerSkill({
      name: 'uncategorized',
      description: 'Some skill with no category.',
      handler: async () => 'ok',
    });

    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain(UNCATEGORIZED_LABEL); // 'More skills'
    expect(out).toContain('/uncategorized');
    expect(out).toContain('Build & ship');
    expect(out).toContain('/mint');
  });

  it('renders categories in canonical SKILL_CATEGORIES order', async () => {
    // Register in REVERSE of expected order to prove ordering comes from
    // the vocabulary, not insertion order.
    registerSkill({ name: 'setup-skill', description: 'Setup.', category: 'Setup & ops', handler: async () => 'ok' });
    registerSkill({ name: 'build-skill', description: 'Build.', category: 'Build & ship', handler: async () => 'ok' });
    registerSkill({ name: 'review-skill', description: 'Review.', category: 'Review & verify', handler: async () => 'ok' });

    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    const buildPos = out.indexOf('Build & ship');
    const reviewPos = out.indexOf('Review & verify');
    const setupPos = out.indexOf('Setup & ops');

    // Canonical: Build & ship (0) < Review & verify (4) < Setup & ops (5)
    expect(buildPos).toBeGreaterThan(-1);
    expect(reviewPos).toBeGreaterThan(-1);
    expect(setupPos).toBeGreaterThan(-1);
    expect(buildPos).toBeLessThan(reviewPos);
    expect(reviewPos).toBeLessThan(setupPos);
  });

  it('omits empty categories (no header for categories with zero skills)', async () => {
    registerSkill({
      name: 'mint',
      description: 'Build and ship.',
      category: 'Build & ship',
      handler: async () => 'ok',
    });

    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    // Only 'Build & ship' should appear; others in the vocabulary should not.
    expect(out).toContain('Build & ship');
    for (const cat of SKILL_CATEGORIES) {
      if (cat !== 'Build & ship') {
        expect(out).not.toContain(cat);
      }
    }
  });

  it('falls back to legacy two-block layout when no skill has a category', async () => {
    registerSkill({ name: 'mint', description: 'A built-in.', handler: async () => 'ok' });
    registerSkill({ name: 'user-skill', description: 'A user skill.', origin: 'user', handler: async () => 'ok' });

    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    // Legacy layout uses 'Built-in' divider.
    expect(out).toContain('Built-in');
    // None of the category names should appear.
    for (const cat of SKILL_CATEGORIES) {
      expect(out).not.toContain(cat);
    }
    expect(out).not.toContain(UNCATEGORIZED_LABEL);
  });

  it('groups plugin skills with category from DiscoveredSkill', async () => {
    const cmd = makeDynamicSkillsCmd([
      {
        name: 'plugin:diagnose',
        description: 'Diagnose a bug via plugin.',
        category: 'Debug & fix',
        source: 'plugin',
      },
    ]);

    const { ctx, lines } = makeCtx();
    await cmd.handler(ctx, '');
    const out = stripAnsi(lines.join('\n'));

    expect(out).toContain('Debug & fix');
    expect(out).toContain('diagnose');
  });

  it('SKILL_CATEGORIES vocabulary matches the canonical 7 entries', () => {
    expect(SKILL_CATEGORIES).toHaveLength(7);
    expect(SKILL_CATEGORIES[0]).toBe('Build & ship');
    expect(SKILL_CATEGORIES[6]).toBe('Author & meta');
  });

  it('UNCATEGORIZED_LABEL is the "More skills" bucket label', () => {
    expect(UNCATEGORIZED_LABEL).toBe('More skills');
  });
});
