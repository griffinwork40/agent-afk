/**
 * Regression tests for the /skills audience gate.
 *
 * Verifies that skills tagged audience: 'internal' are hidden from /skills
 * listing and detail when AFK_INTERNAL is unset, and visible when AFK_INTERNAL=1.
 *
 * Addresses PR #569 BLOCKER: buildListingGroups + renderSkillDetail must both
 * filter by audience — /help already filters (builtin-skills.ts:142), /skills
 * must be consistent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetRegistry, registerSkill } from '../../skills/index.js';
import { resetRegistry } from './registry.js';
import { initialSkillsCmd } from './plugin-skills.js';
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
      planMode: false,
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

describe('/skills audience gate', () => {
  beforeEach(() => {
    // Clean slate for both the slash-command registry and the skill registry.
    resetRegistry();
    _resetRegistry();
    vi.unstubAllEnvs();

    // Register a mix of public and internal skills.
    registerSkill({
      name: 'mint',
      description: 'public skill — visible to everyone',
      audience: 'public',
      handler: async () => 'ok',
    });
    registerSkill({
      name: 'forge',
      description: 'internal skill — maintainer only',
      audience: 'internal',
      handler: async () => 'ok',
    });
    registerSkill({
      name: 'audit-fit',
      description: 'another internal skill',
      audience: 'internal',
      handler: async () => 'ok',
    });
    // A skill with no audience tag — should default to public.
    registerSkill({
      name: 'diagnose',
      description: 'no audience tag — defaults to public',
      handler: async () => 'ok',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Listing (no args) ────────────────────────────────────────────────────

  it('/skills listing hides internal skills when AFK_INTERNAL is unset', async () => {
    vi.stubEnv('AFK_INTERNAL', undefined as unknown as string);
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const output = lines.join('\n');

    expect(output).toContain('mint');
    expect(output).toContain('diagnose');
    expect(output).not.toContain('forge');
    expect(output).not.toContain('audit-fit');
  });

  it('/skills listing hides internal skills when AFK_INTERNAL is empty string', async () => {
    vi.stubEnv('AFK_INTERNAL', '');
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const output = lines.join('\n');

    expect(output).not.toContain('forge');
    expect(output).not.toContain('audit-fit');
  });

  it('/skills listing shows internal skills when AFK_INTERNAL=1', async () => {
    vi.stubEnv('AFK_INTERNAL', '1');
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '');
    const output = lines.join('\n');

    expect(output).toContain('mint');
    expect(output).toContain('forge');
    expect(output).toContain('audit-fit');
    expect(output).toContain('diagnose');
  });

  // ── Detail (/skills <name>) ──────────────────────────────────────────────

  it('/skills forge returns "No skill found" when AFK_INTERNAL is unset', async () => {
    vi.stubEnv('AFK_INTERNAL', undefined as unknown as string);
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'forge');
    const output = lines.join('\n');

    expect(output).toMatch(/no skill found/i);
    // Must not leak internal skill description
    expect(output).not.toContain('maintainer only');
  });

  it('/skills forge renders detail when AFK_INTERNAL=1', async () => {
    vi.stubEnv('AFK_INTERNAL', '1');
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'forge');
    const output = lines.join('\n');

    expect(output).toContain('forge');
    expect(output).toContain('maintainer only');
  });

  it('/skills mint renders detail regardless of AFK_INTERNAL', async () => {
    vi.stubEnv('AFK_INTERNAL', undefined as unknown as string);
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'mint');
    const output = lines.join('\n');

    expect(output).toContain('mint');
    expect(output).toContain('visible to everyone');
  });

  it('/skills detail works for unlabeled (public-default) skill', async () => {
    vi.stubEnv('AFK_INTERNAL', undefined as unknown as string);
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, 'diagnose');
    const output = lines.join('\n');

    expect(output).toContain('diagnose');
    expect(output).toContain('defaults to public');
  });

  // ── /skills with leading slash ────────────────────────────────────────────

  it('/skills /forge (with leading slash) returns "No skill found" when locked', async () => {
    vi.stubEnv('AFK_INTERNAL', undefined as unknown as string);
    const { ctx, lines } = makeCtx();
    await initialSkillsCmd.handler(ctx, '/forge');
    const output = lines.join('\n');

    expect(output).toMatch(/no skill found/i);
  });
});
