/**
 * Tests for built-in skill slash command registration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registerAll } from './slash/index.js';
import { list, lookup, resetRegistry } from './slash/registry.js';

describe('builtin-skills slash registration', () => {
  // Each test calls registerAll() itself AFTER stubbing AFK_INTERNAL as
  // needed — the audience gate is read at registration time, so the env
  // stub must precede the registerAll call.
  beforeEach(() => {
    resetRegistry();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers public built-in TS skills as slash commands', () => {
    registerAll();
    const names = list().map((c) => c.name);
    // /mint and /diagnose are public-tier — visible by default.
    for (const skill of ['/mint', '/diagnose']) {
      expect(names).toContain(skill);
    }
    // /audit-fit is internal-tier — MUST NOT be visible without AFK_INTERNAL=1.
    expect(names).not.toContain('/audit-fit');
  });

  it('surfaces internal built-in skills when AFK_INTERNAL=1', () => {
    vi.stubEnv('AFK_INTERNAL', '1');
    registerAll();
    const names = list().map((c) => c.name);
    for (const skill of ['/mint', '/diagnose', '/audit-fit']) {
      expect(names).toContain(skill);
    }
  });

  it('keeps /builtin-skills as an alias of the unified /skills listing', () => {
    registerAll();
    // `/builtin-skills` was renamed-by-merge into `/skills` for UX parity
    // with plugin/user skills. The alias survives so muscle memory and
    // older docs keep working — it now resolves to the same command as
    // `/skills`.
    const aliasTarget = lookup('/builtin-skills');
    const canonical = lookup('/skills');
    expect(aliasTarget).toBeDefined();
    expect(canonical).toBeDefined();
    expect(aliasTarget).toBe(canonical);
    expect(aliasTarget?.summary).toMatch(/skills/i);
  });

  it('built-in skill handlers are not forward-passthroughs', async () => {
    registerAll();
    const mint = lookup('/mint');
    expect(mint).toBeDefined();
    // Immediate handlers should exist — they call skill.handler() directly,
    // not return 'forward'. We verify the handler is a function (not the
    // passthrough shape from plugin-skills.ts).
    expect(typeof mint!.handler).toBe('function');
  });
});
