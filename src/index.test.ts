/**
 * Tests that the library entry point (src/index.ts) resolves and exports expected symbols.
 */

import { describe, it, expect } from 'vitest';

describe('library entry point', () => {
  it('exports AgentSession from agent', async () => {
    const mod = await import('./index.js');
    expect(mod.AgentSession).toBeDefined();
    expect(typeof mod.AgentSession).toBe('function');
  });

  it('exports TelegramBot and SessionManager', async () => {
    const mod = await import('./index.js');
    expect(mod.TelegramBot).toBeDefined();
    expect(mod.SessionManager).toBeDefined();
  });

  it('exports the framework SDK surface consumed by out-of-tree skill plugins', async () => {
    const mod = await import('./index.js');
    // Skills registry + prompts
    expect(typeof mod.registerSkill).toBe('function');
    expect(typeof mod.listSkills).toBe('function');
    expect(typeof mod.getSkill).toBe('function');
    expect(typeof mod.loadSkillPrompts).toBe('function');
    // Session facets
    expect(typeof mod.deriveSessionFacet).toBe('function');
    expect(typeof mod.getOrDeriveFacet).toBe('function');
    expect(typeof mod.listSessionIds).toBe('function');
    expect(typeof mod.loadStoredSession).toBe('function');
    // Subagent + skill discovery
    expect(typeof mod.describeFailure).toBe('function');
    expect(typeof mod.discoverPluginSkillBodies).toBe('function');
    // Env + user-scope state dirs
    expect(mod.env).toBeDefined();
    expect(typeof mod.getSessionsDir).toBe('function');
    expect(typeof mod.getSkillsDir).toBe('function');
    expect(typeof mod.getAgentFrameworkDir).toBe('function');
  });

});
